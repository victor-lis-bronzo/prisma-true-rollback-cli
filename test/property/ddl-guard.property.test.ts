// Feature: prisma-true-rollback-cli, Property 12: Non-transactional-DDL engines are guarded before any DDL
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { TransactionalExecutor } from '../../src/executor/transactional-executor.js';
import { UnsupportedDdlError } from '../../src/models/errors.js';
import type { Connection, Tx } from '../../src/drivers/driver.js';

/**
 * Property 12: Non-transactional-DDL engines are guarded before any DDL.
 *
 * For any set of reverse statements, when `applyReversal` runs against an engine
 * whose driver reports no transactional-DDL support (`supportsTransactionalDDL:
 * false`), the executor SHALL abort BEFORE executing any Reverse_SQL — throwing
 * an `UnsupportedDdlError` — leaving the Database schema and Tracking_Table
 * unchanged (zero reverse statements executed) and never opening a transaction.
 *
 * The guard is verified with a fake `Connection`/`Tx` whose `transaction()` and
 * `Tx.exec()` (plus the tracking-record mutation) increment counters. When the
 * guard fires we assert `transaction()` was never called and the exec/delete
 * counts are 0. As a contrast, with `supportsTransactionalDDL: true` the same
 * statements DO execute (one `exec` per statement, transaction opened once,
 * tracking record deleted once), proving the counters faithfully observe work.
 *
 * Validates: Requirements 4.6
 */

/** A fake Tx that records every statement executed and every tracking mutation. */
interface CountingTx extends Tx {
  execCount: number;
  deleteCount: number;
  execs: string[];
}

/** A fake Connection whose transaction() is counted and whose Tx records work. */
class CountingConnection implements Connection {
  transactionCount = 0;
  closeCount = 0;
  readonly tx: CountingTx;

  constructor() {
    const tx: CountingTx = {
      execCount: 0,
      deleteCount: 0,
      execs: [],
      async exec(statement: string): Promise<void> {
        tx.execCount += 1;
        tx.execs.push(statement);
      },
      async queryLatestMigration() {
        return null;
      },
      async queryMigrationByName() {
        return null;
      },
      async deleteMigrationRecord(): Promise<void> {
        tx.deleteCount += 1;
      },
      async insertMigrationRecord(): Promise<void> {
        // Not exercised by applyReversal.
      },
    };
    this.tx = tx;
  }

  async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    this.transactionCount += 1;
    return fn(this.tx);
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

describe('Property 12: Non-transactional-DDL engines are guarded before any DDL', () => {
  // Arbitrary arrays of reverse SQL statements (including the empty array).
  const statementsArb = fc.array(fc.string(), { maxLength: 20 });

  it('aborts before any statement executes and never opens a transaction when transactional DDL is unsupported', async () => {
    await fc.assert(
      fc.asyncProperty(
        statementsArb,
        fc.string(),
        fc.option(fc.string(), { nil: undefined }),
        async (statements, targetMigration, engine) => {
          const conn = new CountingConnection();
          const executor = new TransactionalExecutor();

          let thrown: unknown;
          try {
            await executor.applyReversal(conn, {
              statements,
              targetMigration,
              supportsTransactionalDDL: false,
              engine,
            });
          } catch (err) {
            thrown = err;
          }

          // The guard MUST fire with the typed error, before any DDL.
          expect(thrown).toBeInstanceOf(UnsupportedDdlError);

          // Zero reverse statements executed; no transaction opened; tracking
          // table untouched — the database is left completely unchanged.
          expect(conn.transactionCount).toBe(0);
          expect(conn.tx.execCount).toBe(0);
          expect(conn.tx.execs).toHaveLength(0);
          expect(conn.tx.deleteCount).toBe(0);

          return true;
        },
      ),
      { numRuns: 100 },
    );
  });

  it('executes every statement inside one transaction when transactional DDL is supported (contrast)', async () => {
    await fc.assert(
      fc.asyncProperty(
        statementsArb,
        fc.string(),
        async (statements, targetMigration) => {
          const conn = new CountingConnection();
          const executor = new TransactionalExecutor();

          await executor.applyReversal(conn, {
            statements,
            targetMigration,
            supportsTransactionalDDL: true,
          });

          // A single transaction is opened and each statement executes in order,
          // followed by exactly one tracking-record deletion.
          expect(conn.transactionCount).toBe(1);
          expect(conn.tx.execCount).toBe(statements.length);
          expect(conn.tx.execs).toEqual(statements);
          expect(conn.tx.deleteCount).toBe(1);

          return true;
        },
      ),
      { numRuns: 100 },
    );
  });
});
