// Unit tests for the Compensating-Recovery Coordinator (RecoveryCoordinator).
//
// Covers Task 12.3: the FULL-RESTORE outcome (R6.6). When every restore step
// succeeds AND every verification step confirms the prior state, the
// coordinator reports `{ fullyRestored: true, unrestored: [] }`:
//
//   - TransactionalExecutor.restoreDatabase resolves (DB + tracking record
//     restore transaction committed),
//   - FsSnapshotManager.restore resolves (folder recreated),
//   - FsSnapshotManager.equals returns true (folder matches the snapshot
//     byte-for-byte),
//   - the re-read tracking record (Tx.queryMigrationByName) matches the
//     captured record field-for-field.
//
// A small contrast case confirms that when folder verification (equals) returns
// false, `migrationFolder` appears in `unrestored` and `fullyRestored` is false.
//
// The executor and snapshot manager collaborators are injected via the
// constructor as lightweight fakes; a fake Connection whose `transaction`
// invokes a fake Tx supplies the re-read tracking record for verification.
//
// Requirements: 6.6

import { describe, it, expect } from 'vitest';

import type { Connection, Tx } from '../../src/drivers/driver.js';
import type {
  FolderSnapshot,
  MigrationRecord,
  PreOperationSnapshot,
} from '../../src/models/types.js';
import type { TransactionalExecutor } from '../../src/executor/transactional-executor.js';
import type { FsSnapshotManager } from '../../src/snapshot/fs-snapshot-manager.js';
import { RecoveryCoordinator } from '../../src/recovery/recovery-coordinator.js';

/** A representative tracking record captured before the operation. */
const CAPTURED_RECORD: MigrationRecord = {
  id: '3f2a1c9e-0000-4a2b-9c3d-000000000001',
  migrationName: '20240101000000_init',
  checksum: 'abc123def456',
  finishedAt: '2024-01-01T00:00:05.000Z',
  startedAt: '2024-01-01T00:00:00.000Z',
  appliedStepsCount: 1,
  logs: null,
  rolledBackAt: null,
};

/** A minimal folder snapshot for the target migration. */
const FOLDER_SNAPSHOT: FolderSnapshot = {
  rootName: '20240101000000_init',
  files: [
    {
      relativePath: 'migration.sql',
      contentBase64: Buffer.from('CREATE TABLE "A" ("id" TEXT);').toString(
        'base64'
      ),
      mode: 0o644,
    },
  ],
};

const SNAPSHOT: PreOperationSnapshot = {
  capturedAt: '2024-01-01T00:10:00.000Z',
  trackingRecord: CAPTURED_RECORD,
  folder: FOLDER_SNAPSHOT,
  forwardStatements: ['CREATE TABLE "A" ("id" TEXT);'],
};

/**
 * A fake {@link Tx} whose `queryMigrationByName` returns whatever record it was
 * seeded with (simulating the re-read after the DB restore committed). Other
 * methods are unused by the recovery-verification path.
 */
class FakeTx implements Tx {
  constructor(private readonly reReadRecord: MigrationRecord | null) {}

  async exec(): Promise<void> {}

  async queryLatestMigration(): Promise<MigrationRecord | null> {
    return null;
  }

  async queryMigrationByName(name: string): Promise<MigrationRecord | null> {
    // Only return the seeded record when the queried name matches (mirrors the
    // real driver, which keys by migration_name).
    if (this.reReadRecord !== null && this.reReadRecord.migrationName === name) {
      return this.reReadRecord;
    }
    return null;
  }

  async deleteMigrationRecord(): Promise<void> {}

  async insertMigrationRecord(): Promise<void> {}
}

/**
 * A fake {@link Connection} whose `transaction` runs the callback against a
 * {@link FakeTx} seeded with the given re-read record.
 */
class FakeConnection implements Connection {
  constructor(private readonly reReadRecord: MigrationRecord | null) {}

  async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return fn(new FakeTx(this.reReadRecord));
  }

  async close(): Promise<void> {}
}

/** A fake executor whose `restoreDatabase` resolves or rejects on demand. */
function makeExecutor(opts: { restoreDatabaseThrows?: unknown }): TransactionalExecutor {
  return {
    async restoreDatabase(): Promise<void> {
      if (opts.restoreDatabaseThrows !== undefined) {
        throw opts.restoreDatabaseThrows;
      }
    },
  } as unknown as TransactionalExecutor;
}

/** A fake snapshot manager with controllable `restore`/`equals` behavior. */
function makeSnapshots(opts: {
  restoreThrows?: unknown;
  equalsResult: boolean;
}): FsSnapshotManager {
  return {
    async restore(): Promise<void> {
      if (opts.restoreThrows !== undefined) {
        throw opts.restoreThrows;
      }
    },
    async equals(): Promise<boolean> {
      return opts.equalsResult;
    },
  } as unknown as FsSnapshotManager;
}

describe('RecoveryCoordinator.recover — full-restore outcome (R6.6)', () => {
  it('reports { fullyRestored: true, unrestored: [] } when every restore and verification succeeds', async () => {
    // Arrange: DB restore succeeds, folder restore succeeds, folder equals the
    // snapshot, and the re-read tracking record equals the captured record.
    const executor = makeExecutor({});
    const snapshots = makeSnapshots({ equalsResult: true });
    const conn = new FakeConnection(CAPTURED_RECORD);
    const coordinator = new RecoveryCoordinator(executor, snapshots);

    // Act
    const report = await coordinator.recover({
      conn,
      snapshot: SNAPSHOT,
      folderPath: '/tmp/migrations/20240101000000_init',
    });

    // Assert: R6.6 — full restore.
    expect(report).toEqual({ fullyRestored: true, unrestored: [] });
  });

  it('works with migrationsDir (folder path derived from snapshot.folder.rootName)', async () => {
    const executor = makeExecutor({});
    const snapshots = makeSnapshots({ equalsResult: true });
    const conn = new FakeConnection(CAPTURED_RECORD);
    const coordinator = new RecoveryCoordinator(executor, snapshots);

    const report = await coordinator.recover({
      conn,
      snapshot: SNAPSHOT,
      migrationsDir: '/tmp/migrations',
    });

    expect(report.fullyRestored).toBe(true);
    expect(report.unrestored).toEqual([]);
  });

  it('contrast: when folder equals() returns false, migrationFolder is unrestored and fullyRestored is false', async () => {
    // Arrange: identical to the happy path EXCEPT folder verification fails.
    const executor = makeExecutor({});
    const snapshots = makeSnapshots({ equalsResult: false });
    const conn = new FakeConnection(CAPTURED_RECORD);
    const coordinator = new RecoveryCoordinator(executor, snapshots);

    // Act
    const report = await coordinator.recover({
      conn,
      snapshot: SNAPSHOT,
      folderPath: '/tmp/migrations/20240101000000_init',
    });

    // Assert: not a full restore; only the migration folder is unrestored.
    expect(report.fullyRestored).toBe(false);
    expect(report.unrestored).toHaveLength(1);
    expect(report.unrestored[0].element).toBe('migrationFolder');
    // The DB + tracking record still verified, so they are NOT listed.
    const elements = report.unrestored.map((u) => u.element);
    expect(elements).not.toContain('database');
    expect(elements).not.toContain('trackingRecord');
    // Operator remediation is provided (R6.7 surface).
    expect(report.unrestored[0].manualSteps.length).toBeGreaterThan(0);
  });
});
