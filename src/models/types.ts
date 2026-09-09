/**
 * Core shared data-model types for the Prisma True Rollback CLI.
 *
 * These types are consumed across every component (arg parser, config resolver,
 * environment guard, drivers, engine runner, reverse-SQL generator, transactional
 * executor, snapshot manager, recovery coordinator, and orchestrator). They mirror
 * the shapes defined in design.md's "Data Models" and "Components and Interfaces"
 * sections.
 *
 * Requirement traceability: Requirements 4, 5, 6, 7, 8 (shared model surface).
 */

// ---------------------------------------------------------------------------
// Resolved configuration (Requirements 7.1, 7.2, 7.5)
// ---------------------------------------------------------------------------

/** Database engines the CLI supports. Anything else is rejected (R7.5). */
export type DbEngine = 'postgresql' | 'mysql' | 'sqlite';

/**
 * Fully resolved configuration produced by the Config Resolver from
 * `schema.prisma` + `DATABASE_URL` (R7.1).
 */
export interface ResolvedConfig {
  engine: DbEngine;
  /** In-memory only; never serialized or logged raw (R8.5). */
  connectionUrl: string;
  /** Absolute path to `prisma/migrations`. */
  migrationsDir: string;
  /** Absolute path to `schema.prisma`. */
  schemaPath: string;
  /** Optional connection target designation used by the environment guard (R2.1). */
  connectionTargetDesignation?: 'production' | 'development';
}

// ---------------------------------------------------------------------------
// Target migration + tracking record (Requirements 1, 6)
// ---------------------------------------------------------------------------

/** The migration selected for rollback. */
export interface TargetMigration {
  /** Folder name == tracking `migration_name`. */
  name: string;
  /** `migrationsDir/name`. */
  folderPath: string;
}

/**
 * Mirrors the `_prisma_migrations` row for the Target_Migration.
 * Captured pre-operation so it can be re-inserted during recovery (R6.4).
 */
export interface MigrationRecord {
  id: string;
  migrationName: string;
  checksum: string;
  finishedAt: string | null;
  startedAt: string;
  appliedStepsCount: number;
  logs: string | null;
  rolledBackAt: string | null;
}

// ---------------------------------------------------------------------------
// Folder + pre-operation snapshot (Requirements 5.1, 6.1, 6.4, 6.5)
// ---------------------------------------------------------------------------

/** A single file captured in a folder snapshot. */
export interface FileEntry {
  /** POSIX-normalized, relative to the folder root. */
  relativePath: string;
  /** Exact bytes, base64-encoded for byte-for-byte restore (R6.5). */
  contentBase64: string;
  /** Preserved file mode. */
  mode: number;
}

/** A byte-for-byte snapshot of a migration folder's contents. */
export interface FolderSnapshot {
  /** Migration folder name. */
  rootName: string;
  /** Sorted by `relativePath` for deterministic comparison. */
  files: FileEntry[];
}

/**
 * Everything captured before the first destructive action so any partial
 * failure can be fully compensated (R6.1).
 */
export interface PreOperationSnapshot {
  /** ISO timestamp of capture. */
  capturedAt: string;
  /** Tracking-table row for the target migration (R6.1). */
  trackingRecord: MigrationRecord;
  /** Full folder contents; also the restore source for R5.1. */
  folder: FolderSnapshot;
  /** Parsed from the folder's `migration.sql`, used to restore the DB (R6.4). */
  forwardStatements: string[];
}

// ---------------------------------------------------------------------------
// Step results and operation outcome (Requirement 8)
// ---------------------------------------------------------------------------

/** Canonical step names for the destructive/executing portion of the operation. */
export type StepName =
  | 'generate-reverse-sql'
  | 'capture-snapshot'
  | 'apply-reversal'
  | 'delete-folder'
  | 'confirm-success';

/** Result of a single step within the Rollback_Operation. */
export interface StepResult {
  step: StepName;
  status: 'ok' | 'failed' | 'skipped';
  detail?: string;
  /** Whether this step made an irreversible-in-place change. */
  destructivePerformed: boolean;
}

/** Aggregate outcome of a full Rollback_Operation. */
export interface OperationOutcome {
  exitCode: number;
  steps: StepResult[];
  recovery?: RecoveryReport;
}

// ---------------------------------------------------------------------------
// Recovery reporting (Requirements 6.6, 6.7)
// ---------------------------------------------------------------------------

/** Outcome of a Compensating_Recovery attempt. */
export interface RecoveryReport {
  /** True → full restore (R6.6); false → partial, see `unrestored` (R6.7). */
  fullyRestored: boolean;
  /** Populated when `fullyRestored` is false (R6.7). */
  unrestored: UnrestoredElement[];
}

/** A single element that could not be restored during recovery (R6.7). */
export interface UnrestoredElement {
  element: 'database' | 'trackingRecord' | 'migrationFolder';
  detail: string;
  /** Explicit remediation steps for the operator (R6.7). */
  manualSteps: string;
}

// ---------------------------------------------------------------------------
// Environment guard (Requirements 2.1, 2.2)
// ---------------------------------------------------------------------------

/** Classification of the invocation environment. */
export type EnvClassification = 'development' | 'production' | 'ambiguous';

/**
 * Guard decision the orchestrator acts on.
 * `production` blocks regardless of override (R2.1); `ambiguous` blocks unless
 * overridden (R2.2).
 */
export type GuardDecision =
  | { allow: true }
  | { allow: false; reason: 'production'; exitCode: number } // R2.1 non-zero
  | { allow: false; reason: 'ambiguous'; exitCode: number }; // R2.2 non-zero

// ---------------------------------------------------------------------------
// Filesystem delete semantics (Requirement 5.3)
// ---------------------------------------------------------------------------

/** Result of deleting a migration folder; missing folder is a no-op (R5.3). */
export type DeleteOutcome = { kind: 'deleted' } | { kind: 'alreadyAbsent' };

// ---------------------------------------------------------------------------
// Prisma engine runner (Requirements 3.1, 3.2, 3.5, 3.6)
// ---------------------------------------------------------------------------

/** Result of invoking the Prisma engine child process (`prisma migrate diff`). */
export type EngineResult =
  | { kind: 'ok'; sql: string; command: string } // command retained for verbose (redacted before log)
  | { kind: 'nonzero'; exitCode: number; stderr: string } // R3.2 include full engine output
  | { kind: 'timeout' } // R3.5 kill child, abort
  | { kind: 'notFound' }; // R3.6 ENOENT / binary missing

// ---------------------------------------------------------------------------
// Reverse-SQL generation (Requirements 3.3, 3.4)
// ---------------------------------------------------------------------------

/** Post-processed reverse-direction SQL produced by the generator. */
export interface ReverseSql {
  /** Exact engine output (shown verbatim in dry-run, R3.4). */
  raw: string;
  /** Parsed executable statements, comments/whitespace stripped. */
  statements: string[];
}

// ---------------------------------------------------------------------------
// CLI argument parsing (Requirements 1.1-1.3, 1.7, 2.2, 2.6, 3.4, 8.4)
// ---------------------------------------------------------------------------

/** Parsed CLI arguments for a rollback invocation. */
export interface ParsedArgs {
  /** Required unless a terminal flag is set. */
  migrationName: string;
  flags: {
    version: boolean; // R1.7  --version / -v
    dryRun: boolean; // R3.4  --dry-run
    yes: boolean; // R2.6  --yes / -y (non-interactive confirm)
    override: boolean; // R2.2  --override (ambiguous-env authorization)
    verbose: boolean; // R8.4  --verbose
  };
}

/** Discriminated result of parsing `argv`. */
export type ArgParseResult =
  | { kind: 'run'; args: ParsedArgs }
  | { kind: 'version' } // R1.7 -> print version, exit 0
  | { kind: 'error'; message: string; exitCode: 1 }; // R1.2, R1.3
