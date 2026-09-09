/**
 * Target Validator (Task 13.1; design.md §"Target Validator", Pre-flight phase).
 *
 * Validates that the User-supplied Target_Migration is eligible for rollback
 * BEFORE any change is made to the Database or file system. Three checks are
 * performed, each of which maps to exit code 1 with zero changes:
 *
 *   1. **Unknown folder (R1.4).** The migration name must correspond to an
 *      existing Migration_Folder under the Migrations_Directory.
 *   2. **No tracking record (R1.5).** The migration must have a corresponding
 *      row in the Tracking_Table (`_prisma_migrations`).
 *   3. **Not the latest applied (R1.6).** Only the most recently applied
 *      migration may be rolled back — the target must equal the latest recorded
 *      migration.
 *
 * These run during pre-flight (before Step 1), so a failure is a clean abort:
 * no reverse SQL is generated, no snapshot is taken, and no destructive action
 * occurs. The orchestrator maps a {@link TargetValidationError} to exit code 1.
 *
 * The folder existence check uses the standard library (`fs/promises`). The
 * tracking-record and latest-migration checks use the {@link Connection}'s
 * transaction/`Tx` surface (`queryMigrationByName`, `queryLatestMigration`);
 * these are read-only queries and make no change.
 *
 * Note: the validation is intentionally implemented as thrown typed errors (a
 * discriminated `reason` on {@link TargetValidationError}) so the orchestrator
 * can `try/catch` uniformly and map every validation failure to exit 1. The
 * concrete `validate` method also returns the resolved {@link TargetMigration}
 * and its {@link MigrationRecord} on success so the orchestrator can reuse them.
 */

import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

import type { Connection, Tx } from '../drivers/driver.js';
import { RollbackError } from '../models/errors.js';
import type { MigrationRecord, TargetMigration } from '../models/types.js';

/** Discriminator for the specific validation failure that occurred. */
export type TargetValidationReason =
  | 'unknown-folder' // R1.4
  | 'not-recorded' // R1.5
  | 'not-latest'; // R1.6

/**
 * A Target_Migration failed pre-flight validation. Each `reason` maps to a
 * distinct requirement; the orchestrator maps every instance to exit code 1
 * with no changes (R1.4, R1.5, R1.6).
 */
export class TargetValidationError extends RollbackError {
  /** Which validation check failed. */
  readonly reason: TargetValidationReason;
  /** The offending migration name. */
  readonly migrationName: string;

  constructor(
    reason: TargetValidationReason,
    migrationName: string,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'TargetValidationError';
    this.reason = reason;
    this.migrationName = migrationName;
  }
}

/** A successful validation result: the resolved target + its tracking record. */
export interface ValidatedTarget {
  target: TargetMigration;
  record: MigrationRecord;
}

/**
 * Minimal filesystem surface the validator needs (folder existence). Injectable
 * so tests can supply a fake without touching the real filesystem.
 */
export interface DirectoryProbe {
  /** Resolves true iff `folderPath` exists and is a directory. */
  isDirectory(folderPath: string): Promise<boolean>;
}

/** Default {@link DirectoryProbe} backed by `fs/promises`. */
export const fsDirectoryProbe: DirectoryProbe = {
  async isDirectory(folderPath: string): Promise<boolean> {
    try {
      const stat = await fsp.stat(folderPath);
      return stat.isDirectory();
    } catch {
      return false;
    }
  },
};

/**
 * Validates that a Target_Migration is eligible for rollback (R1.4–R1.6).
 *
 * The {@link DirectoryProbe} is injected (defaulting to the `fs/promises`-backed
 * probe) so the folder-existence check is testable with a fake.
 */
export class TargetValidator {
  private readonly probe: DirectoryProbe;

  constructor(probe: DirectoryProbe = fsDirectoryProbe) {
    this.probe = probe;
  }

  /**
   * Validate the migration named `migrationName` against the migrations
   * directory and the Tracking_Table.
   *
   * @param migrationsDir Absolute path to the Migrations_Directory.
   * @param conn          An open, read-only-usable database connection.
   * @param migrationName The Target_Migration name (folder name).
   * @returns the resolved {@link TargetMigration} and its {@link MigrationRecord}.
   * @throws {TargetValidationError} on any of the three failures (R1.4/1.5/1.6).
   */
  async validate(
    migrationsDir: string,
    conn: Connection,
    migrationName: string
  ): Promise<ValidatedTarget> {
    const folderPath = path.join(migrationsDir, migrationName);

    // 1. Unknown folder (R1.4) — checked first so a typo is reported before any
    //    database query is attempted.
    const exists = await this.probe.isDirectory(folderPath);
    if (!exists) {
      throw new TargetValidationError(
        'unknown-folder',
        migrationName,
        `Unknown migration "${migrationName}": no matching folder was found in the migrations directory.`
      );
    }

    // 2 & 3. Query the tracking table for the record and the latest migration.
    //    Both are read-only queries run inside a transaction for a consistent
    //    view; no changes are made.
    const { record, latest } = await conn.transaction(async (tx: Tx) => {
      const byName = await tx.queryMigrationByName(migrationName);
      const latestMigration = await tx.queryLatestMigration();
      return { record: byName, latest: latestMigration };
    });

    // 2. No tracking record (R1.5).
    if (record === null) {
      throw new TargetValidationError(
        'not-recorded',
        migrationName,
        `Migration "${migrationName}" is not recorded as applied in the tracking table; there is nothing to roll back.`
      );
    }

    // 3. Not the most recently applied migration (R1.6).
    if (latest === null || latest.migrationName !== migrationName) {
      const latestName = latest?.migrationName ?? '(none)';
      throw new TargetValidationError(
        'not-latest',
        migrationName,
        `Migration "${migrationName}" is not the most recently applied migration ` +
          `(latest applied: "${latestName}"). Only the most recently applied migration can be rolled back.`
      );
    }

    return {
      target: { name: migrationName, folderPath },
      record,
    };
  }
}
