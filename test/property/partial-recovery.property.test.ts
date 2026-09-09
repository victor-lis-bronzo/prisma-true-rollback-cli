// Feature: prisma-true-rollback-cli, Property 18: Partial recovery reports exactly the unrestored elements
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { RecoveryCoordinator } from '../../src/recovery/recovery-coordinator.js';
import { TransactionalExecutor } from '../../src/executor/transactional-executor.js';
import { FsSnapshotManager } from '../../src/snapshot/fs-snapshot-manager.js';
import { RestoreError } from '../../src/models/errors.js';
import type { Connection, Tx } from '../../src/drivers/driver.js';
import type {
  FolderSnapshot,
  MigrationRecord,
  PreOperationSnapshot,
  UnrestoredElement,
} from '../../src/models/types.js';

/**
 * Property 18: Partial recovery reports exactly the unrestored elements.
 *
 * For any Compensating_Recovery that fails to restore some subset of
 * {Database, Tracking_Table record, Migration_Folder},
 * `RecoveryCoordinator.recover` SHALL return
 * `{ fullyRestored: false, unrestored }` where `unrestored` lists EXACTLY those
 * elements that could not be restored, each with a human-readable `detail` and
 * concrete `manualSteps`; and when the failing subset is empty (all three
 * restore successfully) it SHALL return `{ fullyRestored: true, unrestored: [] }`
 * (R6.6 / R6.7).
 *
 * Strategy: drive the coordinator with fake collaborators so we control which
 * elements fail, then derive the EXPECTED unrestored set from the coordinator's
 * documented verification logic and assert the returned set matches exactly.
 *
 * We generate three independent failure switches:
 *   - `failDatabase`      — the DB restore transaction throws. Per the
 *     coordinator this marks BOTH `database` AND `trackingRecord` unrestored
 *     (they share one transaction).
 *   - `failTrackingVerify`— the DB restore succeeds but the re-read tracking
 *     record does not match the captured record, so `trackingRecord` is
 *     unrestored via the verification step (only observable when the DB restore
 *     did not throw).
 *   - `failFolder`        — the folder verification (`equals`) reports a
 *     mismatch, so `migrationFolder` is unrestored.
 *
 * These switches span every subset of {database, trackingRecord,
 * migrationFolder} that the coordinator can actually produce, including the
 * empty subset (full restore).
 *
 * Fakes are typed as the concrete collaborator classes but only implement the
 * three methods the coordinator invokes (`restoreDatabase`, `restore`,
 * `equals`); the rest are irrelevant to recovery.
 *
 * Validates: Requirements 6.7
 */
describe('Property 18: Partial recovery reports exactly the unrestored elements', () => {
  const MIGRATION_NAME = '20240101000000_init';

  /** The captured tracking record baseline the coordinator verifies against. */
  function makeRecord(): MigrationRecord {
    return {
      id: 'rec-1',
      migrationName: MIGRATION_NAME,
      checksum: 'abc123',
      finishedAt: '2024-01-01T00:00:01.000Z',
      startedAt: '2024-01-01T00:00:00.000Z',
      appliedStepsCount: 1,
      logs: null,
      rolledBackAt: null,
    };
  }

  function makeSnapshot(record: MigrationRecord): PreOperationSnapshot {
    const folder: FolderSnapshot = {
      rootName: MIGRATION_NAME,
      files: [
        {
          relativePath: 'migration.sql',
          contentBase64: Buffer.from('CREATE TABLE t (id INT);').toString('base64'),
          mode: 0o644,
        },
      ],
    };
    return {
      capturedAt: '2024-01-01T00:00:00.000Z',
      trackingRecord: record,
      folder,
      forwardStatements: ['CREATE TABLE t (id INT);'],
    };
  }

  /**
   * A fake Connection whose `transaction(fn)` runs `fn(tx)` (commit-on-resolve /
   * rethrow-on-throw driver contract). Its `Tx.queryMigrationByName` returns
   * either the captured record (verification passes) or a non-matching record
   * (verification fails), depending on `trackingVerifies`.
   */
  function makeFakeConnection(
    expected: MigrationRecord,
    trackingVerifies: boolean,
  ): Connection {
    const tx: Tx = {
      async exec(): Promise<void> {
        /* unused in recovery verification */
      },
      queryLatestMigration(): Promise<MigrationRecord | null> {
        return Promise.resolve(null);
      },
      queryMigrationByName(name: string): Promise<MigrationRecord | null> {
        if (name !== expected.migrationName) {
          return Promise.resolve(null);
        }
        if (trackingVerifies) {
          return Promise.resolve({ ...expected });
        }
        // A record that differs in at least one field -> verification fails.
        return Promise.resolve({ ...expected, checksum: `${expected.checksum}-DRIFTED` });
      },
      async deleteMigrationRecord(): Promise<void> {
        /* unused */
      },
      async insertMigrationRecord(): Promise<void> {
        /* unused */
      },
    };

    return {
      async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
        return await fn(tx);
      },
      async close(): Promise<void> {
        /* unused */
      },
    };
  }

  /**
   * A fake TransactionalExecutor exposing only `restoreDatabase`: it throws when
   * `failDatabase` is set (simulating the DB restore transaction rolling back),
   * and resolves otherwise.
   */
  function makeFakeExecutor(failDatabase: boolean): TransactionalExecutor {
    const fake = {
      async restoreDatabase(): Promise<void> {
        if (failDatabase) {
          throw new Error('DB restore transaction rolled back');
        }
      },
    };
    return fake as unknown as TransactionalExecutor;
  }

  /**
   * A fake FsSnapshotManager exposing only `restore` and `equals`. `restore`
   * always resolves (we exercise the verification path for folder failures);
   * `equals` returns `false` when `failFolder` is set (folder mismatch) and
   * `true` otherwise.
   */
  function makeFakeSnapshots(failFolder: boolean): FsSnapshotManager {
    const fake = {
      async restore(): Promise<void> {
        /* folder written; verification below decides success */
      },
      async equals(): Promise<boolean> {
        return !failFolder;
      },
    };
    return fake as unknown as FsSnapshotManager;
  }

  it('returns exactly the unrestored elements for any injected failure subset', async () => {
    const scenarioArb = fc.record({
      failDatabase: fc.boolean(),
      failTrackingVerify: fc.boolean(),
      failFolder: fc.boolean(),
    });

    await fc.assert(
      fc.asyncProperty(scenarioArb, async ({ failDatabase, failTrackingVerify, failFolder }) => {
        const record = makeRecord();
        const snapshot = makeSnapshot(record);

        // When the DB restore throws, verifyTrackingRecord is still invoked but
        // its result is irrelevant (database failure already marks tracking
        // unrestored). Only expose a passing/failing verify when the DB
        // restore succeeded.
        const trackingVerifies = !failTrackingVerify;

        const executor = makeFakeExecutor(failDatabase);
        const snapshots = makeFakeSnapshots(failFolder);
        const conn = makeFakeConnection(record, trackingVerifies);

        const coordinator = new RecoveryCoordinator(executor, snapshots);

        const report = await coordinator.recover({
          conn,
          snapshot,
          folderPath: '/tmp/does-not-matter/migration-folder',
        });

        // Derive the EXPECTED unrestored set from the coordinator's logic:
        //  - database        <- failDatabase
        //  - trackingRecord  <- failDatabase OR tracking re-read mismatch
        //  - migrationFolder <- folder mismatch (equals === false)
        const expected = new Set<UnrestoredElement['element']>();
        if (failDatabase) {
          expected.add('database');
        }
        if (failDatabase || failTrackingVerify) {
          expected.add('trackingRecord');
        }
        if (failFolder) {
          expected.add('migrationFolder');
        }

        const actualElements = report.unrestored.map((u) => u.element);

        // No duplicate elements are reported.
        expect(new Set(actualElements).size).toBe(actualElements.length);

        // The reported set equals EXACTLY the expected unrestored set.
        expect(new Set(actualElements)).toEqual(expected);

        // fullyRestored is true iff nothing is unrestored (R6.6 vs R6.7).
        expect(report.fullyRestored).toBe(expected.size === 0);
        if (expected.size === 0) {
          expect(report.unrestored).toEqual([]);
        }

        // Every reported element carries a non-empty detail and manualSteps
        // that name the element (R6.7).
        for (const entry of report.unrestored) {
          expect(entry.detail.trim().length).toBeGreaterThan(0);
          expect(entry.manualSteps.trim().length).toBeGreaterThan(0);
        }

        return true;
      }),
      { numRuns: 200 },
    );
  });

  it('reports a folder failure caused by a thrown restore as migrationFolder unrestored', async () => {
    // Complement to the `equals`-based folder failure: when `restore` itself
    // throws, the coordinator must still report `migrationFolder` unrestored.
    const record = makeRecord();
    const snapshot = makeSnapshot(record);

    const executor = makeFakeExecutor(false);
    const throwingSnapshots = {
      async restore(): Promise<void> {
        throw new RestoreError('failed to restore folder', {
          folderPath: '/tmp/x',
        });
      },
      async equals(): Promise<boolean> {
        // Even if a stray equals were true, the thrown restore governs.
        return true;
      },
    } as unknown as FsSnapshotManager;
    const conn = makeFakeConnection(record, true);

    const coordinator = new RecoveryCoordinator(executor, throwingSnapshots);
    const report = await coordinator.recover({
      conn,
      snapshot,
      folderPath: '/tmp/does-not-matter/migration-folder',
    });

    expect(report.fullyRestored).toBe(false);
    expect(report.unrestored.map((u) => u.element)).toEqual(['migrationFolder']);
  });
});
