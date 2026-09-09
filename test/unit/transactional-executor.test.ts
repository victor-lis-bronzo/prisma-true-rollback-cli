// Unit tests for the Transactional Executor (TransactionalExecutor).
//
// Covers Task 10.5: transaction *structure* — verifying that both the reverse
// SQL statements and the tracking-record delete run inside ONE transaction,
// with the delete AFTER all reverse statements (R4.1, R4.2), and that a
// successful callback resolves (commits) so the operation can map to exit 0
// (R4.3). Also verifies the recovery restore path re-applies forward
// statements then re-inserts the tracking record within a single transaction
// (R6.4).
//
// A fake Connection/Tx records the exact order of operations into a shared log
// so ordering can be asserted precisely (e.g.
// ['exec:stmt1', 'exec:stmt2', 'deleteMigrationRecord:20240101_init']).
//
//   - applyReversal runs reverse statements then the delete, all inside one
//     transaction, delete last (R4.1, R4.2).
//   - a resolving callback commits — the transaction wrapper resolves and the
//     executor's promise resolves (R4.3, maps to exit 0).
//   - restoreDatabase re-applies forward statements then insertMigrationRecord
//     within one transaction (R6.4).
//
// Requirements: 4.1, 4.2, 4.3 (with a 6.4 restore-structure check).

import { describe, it, expect } from 'vitest';

import type { Connection, Tx } from '../../src/drivers/driver.js';
import type { MigrationRecord } from '../../src/models/types.js';
import { TransactionalExecutor } from '../../src/executor/transactional-executor.js';

/**
 * A fake {@link Tx} that appends a descriptive entry to a shared operation log
 * for every method invoked, so the test can assert exact call ordering. Query
 * methods return benign defaults; they are unused by the paths under test.
 */
class FakeTx implements Tx {
  constructor(private readonly log: string[]) {}

  async exec(statement: string): Promise<void> {
    this.log.push(`exec:${statement}`);
  }

  async queryLatestMigration(): Promise<MigrationRecord | null> {
    this.log.push('queryLatestMigration');
    return null;
  }

  async queryMigrationByName(): Promise<MigrationRecord | null> {
    this.log.push('queryMigrationByName');
    return null;
  }

  async deleteMigrationRecord(name: string): Promise<void> {
    this.log.push(`deleteMigrationRecord:${name}`);
  }

  async insertMigrationRecord(record: MigrationRecord): Promise<void> {
    this.log.push(`insertMigrationRecord:${record.migrationName}`);
  }
}

/**
 * A fake {@link Connection} that models the driver's transaction wrapper:
 * it records a `begin` boundary, runs the callback with a single {@link FakeTx}
 * bound to the shared log, and — mirroring "commit on resolve / rollback on
 * throw" — records `commit` when the callback resolves or `rollback` when it
 * throws (rethrowing the original error). A single Tx instance is used so all
 * operations are provably within the same transaction.
 */
class FakeConnection implements Connection {
  readonly log: string[] = [];
  /** How many times a transaction was opened — proves single-transaction use. */
  transactionCount = 0;

  async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    this.transactionCount += 1;
    this.log.push('begin');
    const tx = new FakeTx(this.log);
    try {
      const result = await fn(tx);
      this.log.push('commit');
      return result;
    } catch (err) {
      this.log.push('rollback');
      throw err;
    }
  }

  async close(): Promise<void> {
    this.log.push('close');
  }
}

function makeRecord(name: string): MigrationRecord {
  return {
    id: 'id-1',
    migrationName: name,
    checksum: 'abc123',
    finishedAt: '2024-01-01T00:00:00.000Z',
    startedAt: '2024-01-01T00:00:00.000Z',
    appliedStepsCount: 1,
    logs: null,
    rolledBackAt: null,
  };
}

describe('TransactionalExecutor.applyReversal — transaction structure', () => {
  it('runs all reverse statements then the tracking-record delete inside ONE transaction, delete last (R4.1, R4.2)', async () => {
    const executor = new TransactionalExecutor();
    const conn = new FakeConnection();

    await executor.applyReversal(conn, {
      statements: ['stmt1', 'stmt2', 'stmt3'],
      targetMigration: '20240101_init',
      supportsTransactionalDDL: true,
    });

    // Exactly one transaction was opened for the whole operation.
    expect(conn.transactionCount).toBe(1);

    // Exact ordering: begin → each reverse statement in order → delete → commit.
    expect(conn.log).toEqual([
      'begin',
      'exec:stmt1',
      'exec:stmt2',
      'exec:stmt3',
      'deleteMigrationRecord:20240101_init',
      'commit',
    ]);
  });

  it('performs the tracking-record delete AFTER every reverse statement (R4.2)', async () => {
    const executor = new TransactionalExecutor();
    const conn = new FakeConnection();

    await executor.applyReversal(conn, {
      statements: ['a', 'b'],
      targetMigration: 'mig',
      supportsTransactionalDDL: true,
    });

    const deleteIndex = conn.log.indexOf('deleteMigrationRecord:mig');
    const lastExecIndex = conn.log.lastIndexOf('exec:b');
    expect(deleteIndex).toBeGreaterThan(-1);
    // Every exec entry precedes the single delete entry.
    for (const [i, entry] of conn.log.entries()) {
      if (entry.startsWith('exec:')) {
        expect(i).toBeLessThan(deleteIndex);
      }
    }
    expect(deleteIndex).toBeGreaterThan(lastExecIndex);
  });

  it('deletes the tracking record even when there are zero reverse statements, still within one transaction (R4.2)', async () => {
    const executor = new TransactionalExecutor();
    const conn = new FakeConnection();

    await executor.applyReversal(conn, {
      statements: [],
      targetMigration: 'only_delete',
      supportsTransactionalDDL: true,
    });

    expect(conn.transactionCount).toBe(1);
    expect(conn.log).toEqual([
      'begin',
      'deleteMigrationRecord:only_delete',
      'commit',
    ]);
  });

  it('commits on successful completion — the transaction wrapper resolves so the operation maps to exit 0 (R4.3)', async () => {
    const executor = new TransactionalExecutor();
    const conn = new FakeConnection();

    // Model commit-on-resolve: applyReversal resolves (does not reject) and the
    // recorded log ends with a 'commit' (never 'rollback').
    await expect(
      executor.applyReversal(conn, {
        statements: ['stmt1'],
        targetMigration: 'm',
        supportsTransactionalDDL: true,
      })
    ).resolves.toBeUndefined();

    expect(conn.log.at(-1)).toBe('commit');
    expect(conn.log).not.toContain('rollback');
  });
});

describe('TransactionalExecutor.restoreDatabase — transaction structure (R6.4)', () => {
  it('re-applies forward statements in order then inserts the tracking record within ONE transaction (R6.4)', async () => {
    const executor = new TransactionalExecutor();
    const conn = new FakeConnection();
    const record = makeRecord('20240101_init');

    await executor.restoreDatabase(conn, {
      forwardStatements: ['fwd1', 'fwd2'],
      record,
    });

    expect(conn.transactionCount).toBe(1);
    expect(conn.log).toEqual([
      'begin',
      'exec:fwd1',
      'exec:fwd2',
      'insertMigrationRecord:20240101_init',
      'commit',
    ]);
  });

  it('inserts the tracking record AFTER all forward statements and commits (R6.4)', async () => {
    const executor = new TransactionalExecutor();
    const conn = new FakeConnection();
    const record = makeRecord('mig');

    await executor.restoreDatabase(conn, {
      forwardStatements: ['x', 'y', 'z'],
      record,
    });

    const insertIndex = conn.log.indexOf('insertMigrationRecord:mig');
    for (const [i, entry] of conn.log.entries()) {
      if (entry.startsWith('exec:')) {
        expect(i).toBeLessThan(insertIndex);
      }
    }
    expect(conn.log.at(-1)).toBe('commit');
    expect(conn.log).not.toContain('rollback');
  });
});
