/**
 * Rollback Orchestrator (Tasks 13.2 + 13.3; design.md §11 "Rollback
 * Orchestrator", §"Rollback_Operation step sequence", §"Error Handling").
 *
 * Sequences the entire Rollback_Operation, owns exit-code mapping, and
 * guarantees the database connection is closed on every path via a `finally`
 * block (R7.6, Property 13). It is engine-agnostic: the concrete
 * {@link DbDriver} is passed to {@link RollbackOrchestrator.run}; all other
 * collaborators are injected via the constructor (with sensible defaults) so
 * the orchestrator is trivially testable with fakes.
 *
 * ── Canonical step sequence (design's numbering) ────────────────────────────
 *   Pre-flight (no changes): connect (10s, R7.3) → validate target (R1.4/1.5/1.6)
 *                            → destructive warning (R2.3) → confirmation
 *                            (R2.4/2.5/2.6).
 *   Step 1 of 5  Generate Reverse_SQL (R3). Dry-run prints raw SQL, exit 0 (R3.4).
 *   Step 2 of 5  Capture Pre_Operation_Snapshot (read-only) BEFORE first
 *                destructive action (R6.1); capture failure → clean abort (R6.2).
 *   Step 3 of 5  Apply reversal + delete tracking record in ONE transaction
 *                (R4). Transactional-DDL guard runs first (R4.6). ── POINT OF
 *                NO RETURN. ──
 *   Step 4 of 5  Delete Migration_Folder (R5.2/5.3). The folder was already
 *                snapshotted in Step 2, so a delete failure here triggers
 *                Compensating_Recovery (R5.4, R6.3).
 *   Step 5 of 5  Confirm success, exit 0 (R5.5, R5.6, R4.3).
 *
 * ── Exit-code mapping (design's exit-code summary; Task 13.3) ────────────────
 *   0            success (R5.6/R4.3) or a safe no-op abort: dry-run (R3.4),
 *                declined/timed-out confirmation (R2.5).
 *   1            validation/config errors (R1.4/1.5/1.6, R7.x surfaced here) and
 *                recovery outcomes (R6.6 full restore, R6.7 partial restore).
 *   non-zero     execution-phase failures: reverse-SQL generation (R3.2/3.3/
 *                3.5/3.6), the transaction (R4.4/4.5), the DDL guard (R4.6), and
 *                snapshot capture (R6.2). These use {@link EXIT_EXECUTION_FAILURE}.
 *
 * Every user-facing message is emitted through the {@link Logger}, which routes
 * it through the Redactor (R8.1/8.2/8.3/8.5).
 */

import type { Connection, DbDriver } from '../drivers/driver.js';
import { DEFAULT_CONNECT_TIMEOUT_MS } from '../drivers/driver.js';
import { TransactionalExecutor } from '../executor/transactional-executor.js';
import { ReverseSqlGenerator } from '../reverse-sql/reverse-sql-generator.js';
import { FsSnapshotManager } from '../snapshot/fs-snapshot-manager.js';
import { RecoveryCoordinator } from '../recovery/recovery-coordinator.js';
import { ConsoleLogger, type Logger } from '../logger/logger.js';
import {
  FsDeleteError,
  RollbackError,
  UnsupportedDdlError,
} from '../models/errors.js';
import type {
  FolderSnapshot,
  ParsedArgs,
  PreOperationSnapshot,
  RecoveryReport,
  ResolvedConfig,
  ReverseSql,
  TargetMigration,
} from '../models/types.js';
import { TargetValidationError, TargetValidator } from './target-validator.js';

// ---------------------------------------------------------------------------
// Exit codes (design §"Exit-code summary")
// ---------------------------------------------------------------------------

/** Success or a safe no-op abort (dry-run, declined confirmation). */
export const EXIT_SUCCESS = 0;
/** Validation, config, or recovery outcome. */
export const EXIT_VALIDATION = 1;
/** Execution-phase failure (engine / transaction / FS / snapshot). */
export const EXIT_EXECUTION_FAILURE = 2;

/** Interactive-confirmation timeout budget in milliseconds (R2.5). */
export const CONFIRM_TIMEOUT_MS = 60_000;

/** Total number of destructive/executing steps shown to the user (R8.1). */
const TOTAL_STEPS = 5;

/** Human-readable step labels (design canonical step names). */
const STEP_LABELS = {
  generate: 'Generate reverse SQL',
  snapshot: 'Capture pre-operation snapshot',
  reversal: 'Apply reverse SQL and remove tracking record',
  delete: 'Delete migration folder',
  confirm: 'Confirm success',
} as const;

/**
 * Confirmation prompt: resolves to `true` to proceed, `false` to decline, and
 * MUST resolve to `false` on a 60-second timeout (R2.5). The default
 * implementation is provided by {@link defaultConfirm}.
 *
 * @param message The destructive-operation prompt text (already displayed via
 *   the logger; passed here so a custom prompt can reuse it).
 * @param timeoutMs The confirmation timeout budget.
 */
export type ConfirmFn = (message: string, timeoutMs: number) => Promise<boolean>;

/**
 * A minimal clock abstraction so the confirmation timeout is testable without
 * real timers. Mirrors `setTimeout`/`clearTimeout` for a single timer.
 */
export interface Clock {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Default {@link Clock} backed by the global timer functions. */
export const systemClock: Clock = {
  setTimeout: (handler: () => void, ms: number) => setTimeout(handler, ms),
  clearTimeout: (handle: unknown) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Default confirmation: reads a single line from stdin, treating `y`/`yes`
 * (case-insensitive) as acceptance. Declines on any other answer, on EOF, or
 * after `timeoutMs` elapses (R2.5). Kept dependency-free and injectable so the
 * orchestrator's tests never touch real stdin/timers.
 */
export function defaultConfirm(clock: Clock = systemClock): ConfirmFn {
  return (message: string, timeoutMs: number): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      const stdin = process.stdin;
      let settled = false;

      const finish = (value: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        clock.clearTimeout(timer);
        stdin.removeListener('data', onData);
        stdin.removeListener('end', onEnd);
        try {
          stdin.pause();
        } catch {
          /* ignore */
        }
        resolve(value);
      };

      const onData = (chunk: Buffer | string): void => {
        const answer = chunk.toString().trim().toLowerCase();
        finish(answer === 'y' || answer === 'yes');
      };
      const onEnd = (): void => finish(false);

      // Decline on timeout (R2.5).
      const timer = clock.setTimeout(() => finish(false), timeoutMs);

      // The prompt itself is written by the orchestrator via the logger; here
      // we only wire up the input listeners.
      void message;
      try {
        stdin.resume();
      } catch {
        /* ignore */
      }
      stdin.setEncoding('utf8');
      stdin.once('data', onData);
      stdin.once('end', onEnd);
    });
}

/** Collaborators injected into the {@link RollbackOrchestrator}. */
export interface OrchestratorDeps {
  validator?: TargetValidator;
  reverseSqlGenerator?: ReverseSqlGenerator;
  executor?: TransactionalExecutor;
  snapshotManager?: FsSnapshotManager;
  recoveryCoordinator?: RecoveryCoordinator;
  logger?: Logger;
  /** Confirmation prompt (defaults to a stdin-backed prompt). */
  confirm?: ConfirmFn;
  /** Confirmation timeout in ms (defaults to {@link CONFIRM_TIMEOUT_MS}). */
  confirmTimeoutMs?: number;
  /** Connection timeout in ms (defaults to {@link DEFAULT_CONNECT_TIMEOUT_MS}). */
  connectTimeoutMs?: number;
}

/**
 * Drives the full Rollback_Operation and returns a process exit code.
 */
export class RollbackOrchestrator {
  private readonly validator: TargetValidator;
  private readonly reverseSqlGenerator: ReverseSqlGenerator;
  private readonly executor: TransactionalExecutor;
  private readonly snapshotManager: FsSnapshotManager;
  private readonly recoveryCoordinator: RecoveryCoordinator;
  private readonly logger: Logger;
  private readonly confirm: ConfirmFn;
  private readonly confirmTimeoutMs: number;
  private readonly connectTimeoutMs: number;

  constructor(deps: OrchestratorDeps = {}) {
    this.validator = deps.validator ?? new TargetValidator();
    this.reverseSqlGenerator =
      deps.reverseSqlGenerator ?? new ReverseSqlGenerator();
    this.executor = deps.executor ?? new TransactionalExecutor();
    this.snapshotManager = deps.snapshotManager ?? new FsSnapshotManager();
    this.recoveryCoordinator =
      deps.recoveryCoordinator ?? new RecoveryCoordinator();
    this.logger = deps.logger ?? new ConsoleLogger();
    this.confirm = deps.confirm ?? defaultConfirm();
    this.confirmTimeoutMs = deps.confirmTimeoutMs ?? CONFIRM_TIMEOUT_MS;
    this.connectTimeoutMs = deps.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  }

  /**
   * Execute the Rollback_Operation for `args.migrationName` against the
   * database described by `cfg`, using `driver`. Returns the process exit code.
   *
   * The database connection (once opened) is ALWAYS closed in a `finally` block
   * before this method returns, on every success or failure path (R7.6,
   * Property 13).
   */
  async run(
    args: ParsedArgs,
    cfg: ResolvedConfig,
    driver: DbDriver
  ): Promise<number> {
    // Open the connection with a 10-second timeout (R7.3). A connection failure
    // is reported with the redacted target host (R7.4) and mapped to exit 1.
    let conn: Connection;
    try {
      conn = await driver.connect(cfg.connectionUrl, this.connectTimeoutMs);
    } catch (err) {
      this.logger.error(
        `Failed to connect to the database (${driver.redactedTarget(
          cfg.connectionUrl
        )}): ${this.detail(err)}`
      );
      return EXIT_VALIDATION;
    }

    // Everything after a successful connect runs inside try/finally so the
    // connection is closed exactly once, on every path (R7.6, Property 13).
    try {
      return await this.execute(args, cfg, driver, conn);
    } finally {
      try {
        await conn.close();
      } catch (closeErr) {
        // A close failure must not mask the operation's own outcome; surface it
        // as a (redacted) warning only.
        this.logger.error(
          `Warning: failed to close the database connection: ${this.detail(
            closeErr
          )}`
        );
      }
    }
  }

  /**
   * The core sequence, executed with an already-open connection. Separated from
   * {@link run} so the connection-close `finally` in {@link run} wraps every
   * branch here — including early returns — without duplication.
   */
  private async execute(
    args: ParsedArgs,
    cfg: ResolvedConfig,
    driver: DbDriver,
    conn: Connection
  ): Promise<number> {
    // ── Pre-flight: target validation (R1.4/1.5/1.6). No changes. ──────────
    let validated;
    try {
      validated = await this.validator.validate(
        cfg.migrationsDir,
        conn,
        args.migrationName
      );
    } catch (err) {
      if (err instanceof TargetValidationError) {
        this.logger.error(err.message);
        return EXIT_VALIDATION; // R1.4/1.5/1.6 → exit 1, no changes
      }
      throw err;
    }
    const target: TargetMigration = validated.target;

    // ── Pre-flight: destructive warning before any change (R2.3). ──────────
    this.logger.warn(
      `WARNING: This will PERMANENTLY and IRREVERSIBLY roll back migration ` +
        `"${target.name}" — it will reverse the schema change in the database, ` +
        `remove its tracking record, and delete its migration folder. This ` +
        `action cannot be undone.`
    );

    // ── Pre-flight: interactive confirmation (R2.4/2.5) unless --yes (R2.6). ─
    if (!args.flags.yes) {
      const prompt = `Type "y" to confirm rollback of "${target.name}" (60s timeout):`;
      this.logger.info(prompt);
      const confirmed = await this.confirm(prompt, this.confirmTimeoutMs);
      if (!confirmed) {
        // Declined OR 60s timeout → exit 0, no changes (R2.5).
        this.logger.info(
          'Rollback declined or confirmation timed out. No changes were made.'
        );
        return EXIT_SUCCESS;
      }
    }

    // ── Step 1 of 5: generate Reverse_SQL (R3). ────────────────────────────
    this.logger.step(1, TOTAL_STEPS, STEP_LABELS.generate);
    let reverse: ReverseSql;
    try {
      reverse = await this.reverseSqlGenerator.generate(cfg, target);
    } catch (err) {
      // Engine non-zero / empty / timeout / not-found (R3.2/3.3/3.5/3.6).
      this.logger.stepFailed(STEP_LABELS.generate, err);
      return EXIT_EXECUTION_FAILURE;
    }

    // Dry-run: emit the complete Reverse_SQL verbatim, exit 0, zero changes (R3.4).
    if (args.flags.dryRun) {
      this.logger.info('--- Reverse SQL (dry run; no changes will be made) ---');
      this.logger.info(reverse.raw);
      this.logger.info('--- End of reverse SQL. Dry run complete. ---');
      return EXIT_SUCCESS;
    }
    this.logger.verbose(
      `Generated ${reverse.statements.length} reverse statement(s).`
    );
    this.logger.stepDone(STEP_LABELS.generate);

    // ── Transactional-DDL guard (R4.6). Abort before ANY destructive action. ─
    // The executor also enforces this inside applyReversal, but checking here
    // keeps the failure classification explicit and avoids taking a snapshot
    // for an engine that can never proceed (zero reverse statements execute).
    if (!driver.supportsTransactionalDDL) {
      const guardErr = new UnsupportedDdlError(driver.engine);
      this.logger.stepFailed(STEP_LABELS.reversal, guardErr);
      return EXIT_EXECUTION_FAILURE; // R4.6 → non-zero, DB + tracking unchanged
    }

    // ── Step 2 of 5: capture Pre_Operation_Snapshot BEFORE first destructive
    //    action (R6.1). Read-only; a capture failure is a clean abort (R6.2). ─
    this.logger.step(2, TOTAL_STEPS, STEP_LABELS.snapshot);
    let snapshot: PreOperationSnapshot;
    try {
      snapshot = await this.captureSnapshot(target, validated.record);
    } catch (err) {
      // R6.2: snapshot could not be captured → non-zero, NO destructive change.
      this.logger.stepFailed(STEP_LABELS.snapshot, err);
      return EXIT_EXECUTION_FAILURE;
    }
    this.logger.stepDone(STEP_LABELS.snapshot);

    // ── Step 3 of 5: apply reversal + delete tracking record in ONE
    //    transaction (R4). POINT OF NO RETURN once this commits. ─────────────
    this.logger.step(3, TOTAL_STEPS, STEP_LABELS.reversal);
    for (const statement of reverse.statements) {
      this.logger.verbose(`Executing reverse statement: ${statement}`);
    }
    try {
      await this.executor.applyReversal(conn, {
        statements: reverse.statements,
        targetMigration: target.name,
        supportsTransactionalDDL: driver.supportsTransactionalDDL,
        engine: driver.engine,
      });
    } catch (err) {
      // Transaction rolled back (R4.4); DB + tracking match pre-transaction
      // state. Report the failing statement + reason (R4.5). No FS change yet,
      // so no recovery is needed — this is a clean abort.
      this.logger.stepFailed(STEP_LABELS.reversal, err);
      return EXIT_EXECUTION_FAILURE;
    }
    this.logger.stepDone(STEP_LABELS.reversal);

    // ── Step 4 of 5: delete the Migration_Folder (R5.2/5.3). The folder was
    //    already snapshotted in Step 2, so on failure we can recover (R5.4). ──
    this.logger.step(4, TOTAL_STEPS, STEP_LABELS.delete);
    try {
      const outcome = await this.snapshotManager.delete(target.folderPath);
      if (outcome.kind === 'alreadyAbsent') {
        // R5.3: a missing folder is a no-op; report and continue.
        this.logger.info(
          `Migration folder "${target.name}" was already absent; nothing to delete.`
        );
      }
    } catch (err) {
      // R5.4 / R6.3: a post-commit FS failure → initiate Compensating_Recovery.
      this.logger.stepFailed(STEP_LABELS.delete, err);
      const cause = err instanceof FsDeleteError ? err.message : this.detail(err);
      return await this.runRecovery(conn, cfg, snapshot, cause);
    }
    this.logger.stepDone(STEP_LABELS.delete);

    // ── Step 5 of 5: confirm success, exit 0 (R5.5, R5.6, R4.3). ────────────
    this.logger.step(5, TOTAL_STEPS, STEP_LABELS.confirm);
    this.logger.info(
      `Migration "${target.name}" was fully rolled back: the schema change was ` +
        `reversed, its tracking record was removed, and its migration folder ` +
        `was deleted.`
    );
    this.logger.stepDone(STEP_LABELS.confirm);
    return EXIT_SUCCESS;
  }

  /**
   * Capture the Pre_Operation_Snapshot (R6.1): the tracking record (already
   * resolved during validation), the full folder contents (via the snapshot
   * manager), and the forward statements parsed from the folder's
   * `migration.sql` (used by recovery to restore the DB — R6.4).
   *
   * The folder snapshot is captured here (before the first destructive action)
   * and reused as the restore source for Step 4 (R5.1) and for recovery (R6.5),
   * so no second capture is taken after the delete.
   *
   * @throws {SnapshotError} propagated from the snapshot manager when the folder
   *   cannot be read (R6.2).
   */
  private async captureSnapshot(
    target: TargetMigration,
    record: PreOperationSnapshot['trackingRecord']
  ): Promise<PreOperationSnapshot> {
    const folder = await this.snapshotManager.capture(target.folderPath);
    const forwardStatements = this.parseForwardStatements(folder);
    return {
      capturedAt: new Date().toISOString(),
      trackingRecord: record,
      folder,
      forwardStatements,
    };
  }

  /**
   * Parse the migration's forward statements from the `migration.sql` file
   * captured in the folder snapshot. These are re-applied during recovery to
   * restore the schema (R6.4). Comments and blank fragments are stripped and
   * statements are split on `;` — the same shape the executor expects.
   *
   * Returns an empty array when no `migration.sql` is present (recovery will
   * then only restore the tracking record + folder, and report the DB element
   * accordingly).
   */
  private parseForwardStatements(folder: FolderSnapshot): string[] {
    const entry = folder.files.find(
      (f) => f.relativePath === 'migration.sql' || f.relativePath.endsWith('/migration.sql')
    );
    if (entry === undefined) {
      return [];
    }
    const sql = Buffer.from(entry.contentBase64, 'base64').toString('utf8');
    return this.splitStatements(sql);
  }

  /**
   * Split a SQL script into executable statements, stripping `--` line comments
   * and `/* *&#47;` block comments and discarding blank fragments. A small,
   * self-contained splitter (the generator's parser is private to that module).
   */
  private splitStatements(sql: string): string[] {
    const withoutBlock = sql.replace(/\/\*[\s\S]*?\*\//g, '');
    const withoutLine = withoutBlock
      .split('\n')
      .map((line) => {
        const idx = line.indexOf('--');
        return idx >= 0 ? line.slice(0, idx) : line;
      })
      .join('\n');
    return withoutLine
      .split(';')
      .map((fragment) => fragment.trim())
      .filter((fragment) => fragment.length > 0);
  }

  /**
   * Initiate Compensating_Recovery after a post-commit failure (R5.4/R6.3) and
   * map its result to an exit code (R6.6/R6.7).
   *
   * - Fully restored → exit 1 with an "aborted, prior state restored" message
   *   (R6.6).
   * - Partially restored → exit 1 listing each unrestored element and its
   *   specific manual steps (R6.7).
   */
  private async runRecovery(
    conn: Connection,
    cfg: ResolvedConfig,
    snapshot: PreOperationSnapshot,
    cause: string
  ): Promise<number> {
    this.logger.warn(
      `A destructive step failed after the database transaction committed ` +
        `(${cause}). Initiating compensating recovery to restore the prior state...`
    );

    let report: RecoveryReport;
    try {
      report = await this.recoveryCoordinator.recover({
        conn,
        snapshot,
        migrationsDir: cfg.migrationsDir,
      });
    } catch (err) {
      // Recovery itself threw unexpectedly — treat the whole prior state as
      // unrestored and report exit 1 with manual guidance (R6.7).
      this.logger.error(
        `Compensating recovery failed unexpectedly: ${this.detail(err)}. ` +
          `Manual restoration is required: re-apply the migration's forward SQL, ` +
          `re-insert its tracking record, and recreate its migration folder from backup.`
      );
      return EXIT_VALIDATION;
    }

    if (report.fullyRestored) {
      // R6.6: full restore → exit 1, prior state restored.
      this.logger.error(
        'Rollback operation aborted; the prior state was fully restored ' +
          '(database schema, tracking record, and migration folder). No changes persist.'
      );
      return EXIT_VALIDATION;
    }

    // R6.7: partial restore → exit 1, list each unrestored element + manual steps.
    this.logger.error(
      'Rollback operation aborted, but compensating recovery could NOT fully ' +
        'restore the prior state. The following elements require manual restoration:'
    );
    for (const item of report.unrestored) {
      this.logger.error(
        `  - ${item.element}: ${item.detail}\n    Manual steps: ${item.manualSteps}`
      );
    }
    return EXIT_VALIDATION;
  }

  /** Extract a concise, human-readable detail string from an unknown error. */
  private detail(error: unknown): string {
    if (error instanceof RollbackError && error.message.length > 0) {
      return error.message;
    }
    if (error instanceof Error && error.message.length > 0) {
      return error.message;
    }
    return String(error);
  }
}
