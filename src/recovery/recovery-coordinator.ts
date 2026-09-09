/**
 * Compensating-Recovery Coordinator (design.md §9).
 *
 * When a destructive step fails *after* the point of no return (the Step 3
 * transaction has already committed and a Step 4 filesystem action fails), the
 * orchestrator initiates Compensating_Recovery. This coordinator restores all
 * three elements captured in the Pre_Operation_Snapshot back to their
 * pre-operation baseline and reports exactly what was and was not restored:
 *
 *   - **Database + Tracking_Table (R6.4).** Delegated to
 *     {@link TransactionalExecutor.restoreDatabase}, which re-applies the
 *     original migration's forward statements and re-inserts the saved tracking
 *     record inside a single transaction.
 *   - **Migration_Folder (R6.5).** Delegated to
 *     {@link FsSnapshotManager.restore}, which recreates the folder byte-for-byte
 *     from the folder snapshot.
 *
 * After attempting the restores, the coordinator *verifies* the result rather
 * than trusting the restore calls blindly (design.md §"Recovery verification"):
 *   - the folder is re-compared against the snapshot via
 *     {@link FsSnapshotManager.equals};
 *   - the database/tracking-record restoration is verified by re-reading the
 *     tracking record and comparing it field-for-field with the captured
 *     record.
 *
 * If every element matches → `{ fullyRestored: true, unrestored: [] }` (R6.6).
 * If any element failed to restore → `{ fullyRestored: false, unrestored: [...] }`
 * listing exactly the unrestored elements, each with a human-readable `detail`
 * and specific `manualSteps` (R6.7).
 *
 * ── Design note on the folder path input ────────────────────────────────────
 * A {@link FolderSnapshot} records only the migration folder's `rootName`, not
 * its absolute location on disk. Both {@link FsSnapshotManager.restore} and
 * {@link FsSnapshotManager.equals} operate on an absolute `folderPath`. The
 * design's `RecoveryCoordinator.recover` input is `{ conn, snapshot }`; to make
 * the absolute path available (and to keep this component trivially testable
 * with a temp directory or a fake snapshot manager), the folder path is
 * threaded through the input as an explicit {@link RecoverInput.folderPath}.
 * The orchestrator, which owns the resolved config, forwards the absolute
 * migration folder path (`migrationsDir/snapshot.folder.rootName`) here. When
 * omitted, it is reconstructed from the input as a fallback — see
 * {@link RecoverInput.folderPath} / {@link RecoverInput.migrationsDir}.
 */

import * as path from 'node:path';

import type { Connection, Tx } from '../drivers/driver.js';
import { TransactionalExecutor } from '../executor/transactional-executor.js';
import { FsSnapshotManager } from '../snapshot/fs-snapshot-manager.js';
import type {
  MigrationRecord,
  PreOperationSnapshot,
  RecoveryReport,
  UnrestoredElement,
} from '../models/types.js';

/**
 * Input to {@link RecoveryCoordinator.recover}.
 *
 * design.md models this as `{ conn, snapshot }`. Because a
 * {@link PreOperationSnapshot}'s folder snapshot carries only the folder
 * `rootName` (not its absolute location), the absolute migration folder path is
 * threaded through here so the coordinator can drive
 * {@link FsSnapshotManager.restore}/`equals`. Provide **either**
 * {@link folderPath} (the absolute path to the migration folder) **or**
 * {@link migrationsDir} (the absolute migrations directory, from which the
 * folder path is derived as `migrationsDir/snapshot.folder.rootName`).
 */
export interface RecoverInput {
  /** An open database connection; its lifecycle is owned by the caller (R7.6). */
  conn: Connection;
  /** The pre-operation snapshot to restore the prior state from (R6.1). */
  snapshot: PreOperationSnapshot;
  /**
   * Absolute path to the Target_Migration's folder. When supplied this is used
   * directly for folder restore/verification. Takes precedence over
   * {@link migrationsDir}.
   */
  folderPath?: string;
  /**
   * Absolute path to the migrations directory. Used to derive the folder path
   * as `migrationsDir/snapshot.folder.rootName` when {@link folderPath} is not
   * supplied.
   */
  migrationsDir?: string;
}

/** Human-readable label for each recoverable element (used in `detail`). */
const ELEMENT_LABEL = {
  database: 'Database schema',
  trackingRecord: 'Tracking_Table record',
  migrationFolder: 'Migration_Folder',
} as const;

/**
 * Restores the Database, Tracking_Table record, and Migration_Folder to the
 * Pre_Operation_Snapshot and reports the outcome (R6.4–R6.7).
 *
 * The {@link TransactionalExecutor} and {@link FsSnapshotManager} collaborators
 * are injected via the constructor (defaulting to fresh instances) so tests can
 * supply fakes that inject restore failures (Task 12.2, Property 18).
 */
export class RecoveryCoordinator {
  private readonly executor: TransactionalExecutor;
  private readonly snapshots: FsSnapshotManager;

  constructor(
    executor: TransactionalExecutor = new TransactionalExecutor(),
    snapshots: FsSnapshotManager = new FsSnapshotManager()
  ) {
    this.executor = executor;
    this.snapshots = snapshots;
  }

  /**
   * Attempt to restore the pre-operation baseline and report exactly what was
   * restored.
   *
   * Flow:
   *   1. **Restore the DB + tracking record (R6.4).** Call
   *      {@link TransactionalExecutor.restoreDatabase}. A throw here means the
   *      restore transaction rolled back, so *both* the database schema and the
   *      tracking record are considered unrestored.
   *   2. **Restore the folder (R6.5).** Call
   *      {@link FsSnapshotManager.restore}. A throw here means the folder is
   *      unrestored.
   *   3. **Verify (R6.6/R6.7).** Re-read the tracking record and compare it with
   *      the captured record; re-compare the folder against the snapshot via
   *      {@link FsSnapshotManager.equals}. Any mismatch marks the corresponding
   *      element unrestored even if the restore call itself did not throw.
   *   4. Aggregate: empty unrestored list → `fullyRestored: true` (R6.6);
   *      otherwise `fullyRestored: false` with per-element `detail` +
   *      `manualSteps` (R6.7).
   *
   * @param input The connection, snapshot, and folder path — see {@link RecoverInput}.
   */
  async recover(input: RecoverInput): Promise<RecoveryReport> {
    const { conn, snapshot } = input;
    const folderPath = this.resolveFolderPath(input);

    // Track failures per element. `database` and `trackingRecord` share the DB
    // restore transaction (they succeed or fail together), but are reported as
    // distinct elements per the design's UnrestoredElement.element union.
    let databaseRestoreThrew: unknown | undefined;
    let folderRestoreThrew: unknown | undefined;

    // 1. Restore DB + tracking record in one transaction (R6.4).
    try {
      await this.executor.restoreDatabase(conn, {
        forwardStatements: snapshot.forwardStatements,
        record: snapshot.trackingRecord,
      });
    } catch (err) {
      databaseRestoreThrew = err;
    }

    // 2. Restore the migration folder byte-for-byte (R6.5).
    try {
      await this.snapshots.restore(folderPath, snapshot.folder);
    } catch (err) {
      folderRestoreThrew = err;
    }

    // 3. Verify each element independently (design §"Recovery verification").
    const trackingVerified = await this.verifyTrackingRecord(
      conn,
      snapshot.trackingRecord
    );
    const folderVerified = await this.snapshots.equals(folderPath, snapshot.folder);

    // 4. Aggregate into per-element unrestored entries (R6.6 vs R6.7).
    const unrestored: UnrestoredElement[] = [];

    // Database schema: unrestored if the restore transaction threw. When it
    // committed we treat the schema as restored (the forward statements were
    // re-applied within the same verified transaction as the tracking record).
    const databaseRestored = databaseRestoreThrew === undefined;
    if (!databaseRestored) {
      unrestored.push(
        this.describe('database', this.causeText(databaseRestoreThrew))
      );
    }

    // Tracking record: unrestored if the restore threw OR the re-read record
    // does not match the captured record.
    const trackingRestored = databaseRestored && trackingVerified;
    if (!trackingRestored) {
      const detail = !databaseRestored
        ? this.causeText(databaseRestoreThrew)
        : 'the re-read tracking record does not match the captured pre-operation record';
      unrestored.push(this.describe('trackingRecord', detail));
    }

    // Migration folder: unrestored if the restore threw OR the folder does not
    // match the snapshot byte-for-byte.
    const folderRestored = folderRestoreThrew === undefined && folderVerified;
    if (!folderRestored) {
      const detail =
        folderRestoreThrew !== undefined
          ? this.causeText(folderRestoreThrew)
          : 'the migration folder does not match the pre-operation snapshot byte-for-byte';
      unrestored.push(this.describe('migrationFolder', detail));
    }

    return { fullyRestored: unrestored.length === 0, unrestored };
  }

  /**
   * Resolve the absolute migration folder path from the input, preferring an
   * explicit {@link RecoverInput.folderPath}, then deriving it from
   * {@link RecoverInput.migrationsDir} + the snapshot's folder `rootName`.
   *
   * @throws {Error} when neither `folderPath` nor `migrationsDir` is provided —
   *   the coordinator cannot locate the folder to restore without one of them.
   */
  private resolveFolderPath(input: RecoverInput): string {
    if (input.folderPath !== undefined && input.folderPath.length > 0) {
      return input.folderPath;
    }
    if (input.migrationsDir !== undefined && input.migrationsDir.length > 0) {
      return path.join(input.migrationsDir, input.snapshot.folder.rootName);
    }
    throw new Error(
      'RecoveryCoordinator.recover requires either `folderPath` or `migrationsDir` in its input to locate the migration folder.'
    );
  }

  /**
   * Re-read the tracking record for the captured migration and compare it
   * field-for-field with the captured record. Returns `true` only when a record
   * exists and every field matches. Any read failure is treated as "not
   * verified" (returns `false`) so the element is reported as unrestored rather
   * than propagating the error out of recovery.
   */
  private async verifyTrackingRecord(
    conn: Connection,
    expected: MigrationRecord
  ): Promise<boolean> {
    try {
      return await conn.transaction(async (tx: Tx) => {
        const actual = await tx.queryMigrationByName(expected.migrationName);
        return actual !== null && this.recordsEqual(actual, expected);
      });
    } catch {
      return false;
    }
  }

  /** Field-for-field equality of two tracking records. */
  private recordsEqual(a: MigrationRecord, b: MigrationRecord): boolean {
    return (
      a.id === b.id &&
      a.migrationName === b.migrationName &&
      a.checksum === b.checksum &&
      a.finishedAt === b.finishedAt &&
      a.startedAt === b.startedAt &&
      a.appliedStepsCount === b.appliedStepsCount &&
      a.logs === b.logs &&
      a.rolledBackAt === b.rolledBackAt
    );
  }

  /**
   * Build an {@link UnrestoredElement} for `element` with a human-readable
   * `detail` and the specific `manualSteps` an operator must perform to restore
   * consistency by hand (R6.7).
   */
  private describe(
    element: UnrestoredElement['element'],
    detail: string
  ): UnrestoredElement {
    return {
      element,
      detail: `${ELEMENT_LABEL[element]} could not be restored: ${detail}.`,
      manualSteps: this.manualStepsFor(element),
    };
  }

  /** Element-specific manual remediation steps (R6.7). */
  private manualStepsFor(element: UnrestoredElement['element']): string {
    switch (element) {
      case 'database':
        return (
          'Manually re-apply the target migration\'s forward SQL (the statements in its ' +
          'migration.sql) against the database to restore the schema to its pre-rollback state.'
        );
      case 'trackingRecord':
        return (
          'Manually re-insert the target migration\'s row into the _prisma_migrations ' +
          'tracking table using the captured record values (id, migration_name, checksum, ' +
          'started_at, finished_at, applied_steps_count, logs, rolled_back_at).'
        );
      case 'migrationFolder':
        return (
          'Manually recreate the migration folder under the migrations directory from the ' +
          'pre-operation snapshot so its files, contents, and modes match byte-for-byte.'
        );
    }
  }

  /** Extract a concise, human-readable cause string from an unknown error. */
  private causeText(err: unknown): string {
    if (err instanceof Error && err.message.length > 0) {
      return err.message;
    }
    return String(err);
  }
}
