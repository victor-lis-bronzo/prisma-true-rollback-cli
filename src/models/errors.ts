/**
 * Typed error classes for the Prisma True Rollback CLI.
 *
 * These errors are thrown by the various components and are consumed by the
 * Rollback Orchestrator to map failures to specific exit codes and to produce
 * user-facing messages (every message is passed through the Redactor before
 * display). Each class exposes the specific fields the orchestrator needs for
 * exit-code mapping and messaging.
 *
 * NOTE: This file is intentionally self-contained. It does NOT import from
 * `./types` (owned by a concurrently-developed task). To avoid a cross-file
 * write conflict, the `DbEngine` union is aliased locally here.
 */

/**
 * Supported database engines. Kept as a local alias so this file has no
 * dependency on `./types`. Must stay in sync with the canonical `DbEngine`
 * defined in the data-model types module.
 */
export type DbEngine = 'postgresql' | 'mysql' | 'sqlite';

/** The list of engines the CLI supports, for messaging on rejection (R7.5). */
export const SUPPORTED_ENGINES: readonly DbEngine[] = ['postgresql', 'mysql', 'sqlite'];

/**
 * Base class for all CLI-specific errors. Extending a common base lets the
 * orchestrator perform a single `instanceof RollbackError` check while still
 * discriminating on the concrete subclass for exit-code mapping.
 *
 * The constructor forwards `options` (notably `{ cause }`) to the native
 * `Error` constructor so the underlying cause chain is preserved, and fixes up
 * the prototype so `instanceof` works reliably when compiled to older targets.
 */
export class RollbackError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RollbackError';
    // Restore the prototype chain (needed when targeting < ES2015 semantics).
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Configuration resolution failed: `schema.prisma` could not be located, or
 * `DATABASE_URL` is unset/empty/whitespace-only. Carries the specific missing
 * source so the message can identify it (R7.2, exit 1).
 */
export class ConfigError extends RollbackError {
  /** Identifies which configuration source was missing/invalid. */
  readonly missingSource: 'schema.prisma' | 'DATABASE_URL';

  constructor(
    missingSource: 'schema.prisma' | 'DATABASE_URL',
    message?: string,
    options?: { cause?: unknown }
  ) {
    super(
      message ??
        (missingSource === 'schema.prisma'
          ? 'Could not locate schema.prisma.'
          : 'DATABASE_URL is unset or empty.'),
      options
    );
    this.name = 'ConfigError';
    this.missingSource = missingSource;
  }
}

/**
 * The resolved datasource engine is not one of {postgresql, mysql, sqlite}.
 * Carries the offending engine name and the list of supported engines so the
 * message can name the engine and list what is supported (R7.5, exit 1).
 */
export class UnsupportedEngineError extends RollbackError {
  /** The unsupported engine identifier that was resolved. */
  readonly engine: string;
  /** The engines the CLI supports. */
  readonly supportedEngines: readonly DbEngine[];

  constructor(
    engine: string,
    supportedEngines: readonly DbEngine[] = SUPPORTED_ENGINES,
    options?: { cause?: unknown }
  ) {
    super(
      `Unsupported database engine "${engine}". Supported engines: ${supportedEngines.join(', ')}.`,
      options
    );
    this.name = 'UnsupportedEngineError';
    this.engine = engine;
    this.supportedEngines = supportedEngines;
  }
}

/**
 * The generated reverse SQL is effectively empty — it contains no executable
 * statements (only whitespace and/or SQL comments) — so there is nothing to
 * reverse (R3.3, non-zero exit).
 */
export class ReverseSqlError extends RollbackError {
  /** The raw engine output that was classified as effectively empty. */
  readonly rawSql?: string;

  constructor(
    message = 'No reversal statements were generated for the target migration.',
    options?: { cause?: unknown; rawSql?: string }
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'ReverseSqlError';
    this.rawSql = options?.rawSql;
  }
}

/**
 * A single database statement failed during execution. Thrown by the `Tx`
 * layer and typically wrapped by a `TransactionAbortedError` after rollback.
 * Carries the offending statement text and the underlying cause (R4.5).
 */
export class StatementError extends RollbackError {
  /** The exact statement text that failed. */
  readonly statement: string;

  constructor(statement: string, message?: string, options?: { cause?: unknown }) {
    super(message ?? `Database statement failed: ${statement}`, options);
    this.name = 'StatementError';
    this.statement = statement;
  }
}

/**
 * The reverse-application transaction was rolled back because a statement
 * failed. MUST carry the failing statement text AND the underlying reason so
 * the orchestrator can report both (R4.5, non-zero exit). After rollback the
 * database and tracking table match their pre-transaction state (R4.4).
 */
export class TransactionAbortedError extends RollbackError {
  /** The text of the statement whose failure aborted the transaction. */
  readonly failingStatement: string;
  /** The underlying failure reason (human-readable). */
  readonly reason: string;

  constructor(
    failingStatement: string,
    reason: string,
    options?: { cause?: unknown }
  ) {
    super(
      `Transaction aborted and rolled back. Failing statement: ${failingStatement} — reason: ${reason}`,
      options
    );
    this.name = 'TransactionAbortedError';
    this.failingStatement = failingStatement;
    this.reason = reason;
  }
}

/**
 * The target engine's driver reports no support for transactional DDL (e.g.
 * MySQL performs implicit commits on DDL). The operation is aborted before any
 * reverse SQL is executed so no partial/unrecoverable DDL is applied
 * (R4.6, non-zero exit).
 */
export class UnsupportedDdlError extends RollbackError {
  /** The engine that lacks transactional-DDL support. */
  readonly engine: DbEngine | string;

  constructor(engine: DbEngine | string, options?: { cause?: unknown }) {
    super(
      `Engine "${engine}" does not support transactional DDL; aborting before executing any reverse SQL to avoid an unrecoverable partial rollback.`,
      options
    );
    this.name = 'UnsupportedDdlError';
    this.engine = engine;
  }
}

/**
 * Capturing the Pre_Operation_Snapshot (tracking record + folder contents)
 * failed. Because the snapshot is a precondition for the first destructive
 * action, this is a clean abort with no destructive change (R6.2, non-zero exit).
 */
export class SnapshotError extends RollbackError {
  /** The folder path whose snapshot capture failed, when applicable. */
  readonly folderPath?: string;

  constructor(
    message = 'Failed to capture the pre-operation snapshot.',
    options?: { cause?: unknown; folderPath?: string }
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'SnapshotError';
    this.folderPath = options?.folderPath;
  }
}

/**
 * Deletion of the Migration_Folder failed (e.g. a permission error or other
 * filesystem failure). Distinct from the no-op "already absent" outcome, which
 * is not an error (R5.3). A delete failure after the transaction commit triggers
 * compensating recovery (R5.4, non-zero exit).
 */
export class FsDeleteError extends RollbackError {
  /** The folder path whose deletion failed. */
  readonly folderPath: string;
  /** True when the failure was a permission error. */
  readonly isPermissionError: boolean;

  constructor(
    folderPath: string,
    message?: string,
    options?: { cause?: unknown; isPermissionError?: boolean }
  ) {
    super(
      message ?? `Failed to delete migration folder: ${folderPath}`,
      options?.cause !== undefined ? { cause: options.cause } : undefined
    );
    this.name = 'FsDeleteError';
    this.folderPath = folderPath;
    this.isPermissionError = options?.isPermissionError ?? false;
  }
}

/**
 * Restoring the Migration_Folder from the snapshot during compensating recovery
 * failed. Contributes to a partial-recovery report listing unrestored elements
 * and manual remediation steps (R6.7, exit 1).
 */
export class RestoreError extends RollbackError {
  /** The folder path that could not be restored, when applicable. */
  readonly folderPath?: string;

  constructor(
    message = 'Failed to restore the migration folder from the snapshot.',
    options?: { cause?: unknown; folderPath?: string }
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'RestoreError';
    this.folderPath = options?.folderPath;
  }
}
