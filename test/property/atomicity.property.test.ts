// Feature: prisma-true-rollback-cli, Property 1: Atomicity — any failure restores the pre-operation baseline
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  RollbackOrchestrator,
  EXIT_VALIDATION,
  EXIT_EXECUTION_FAILURE,
} from '../../src/orchestrator/rollback-orchestrator.js';
import { TransactionalExecutor } from '../../src/executor/transactional-executor.js';
import { RecoveryCoordinator } from '../../src/recovery/recovery-coordinator.js';
import { TargetValidator } from '../../src/orchestrator/target-validator.js';
import { ConsoleLogger } from '../../src/logger/logger.js';
import { ReverseSqlGenerator } from '../../src/reverse-sql/reverse-sql-generator.js';
import { StatementError, FsDeleteError } from '../../src/models/errors.js';
import type { Connection, DbDriver, Tx } from '../../src/drivers/driver.js';
import type {
  DeleteOutcome,
  FileEntry,
  FolderSnapshot,
  MigrationRecord,
  ParsedArgs,
  ResolvedConfig,
} from '../../src/models/types.js';

/**
 * Property 1: Atomicity — any failure restores the pre-operation baseline.
 *
 * *For any* Rollback_Operation and *any* failure injected at *any* point after
 * pre-flight validation — either
 *   (a) a failing reverse statement inside the Step-3 transaction, or
 *   (b) a filesystem failure during Step-4 folder deletion, AFTER the
 *       transaction has already committed —
 * the observable state of the three resources the operation touches:
 *   1. the Database schema,
 *   2. the Tracking_Table record for the Target_Migration, and
 *   3. the Migration_Folder,
 * SHALL, once `orchestrator.run` returns, equal the Pre_Operation_Snapshot
 * baseline captured before the first destructive action — with no partial
 * changes.
 *
 * ── Modeling strategy ───────────────────────────────────────────────────────
 * The property is exercised end-to-end through the *real* `RollbackOrchestrator`
 * wired to the *real* `TransactionalExecutor` and *real* `RecoveryCoordinator`,
 * with only the leaf I/O boundaries faked by faithful in-memory models:
 *
 *   • In-memory DATABASE (`DbModel`): a schema state (`Set<string>` of applied
 *     schema object names) plus a single-row tracking table keyed by migration
 *     name. Reverse statements are modeled as `DROP <name>` (remove from the
 *     schema set); the migration's *forward* statements — parsed by the
 *     orchestrator out of the folder's `migration.sql` and re-applied by
 *     recovery — are `CREATE <name>` (add to the set). CREATE/DROP of the same
 *     name are exact inverses, so a full reverse-then-forward-restore returns
 *     the schema to baseline. The fake `Connection.transaction` snapshots DB
 *     state on entry and, on any throw from the callback, rolls the schema and
 *     tracking table back to that snapshot before rethrowing — exactly the
 *     commit-on-resolve / rollback-on-throw contract the driver guarantees (R4).
 *
 *   • In-memory FILESYSTEM (`FsModel`): the migration folder's contents as an
 *     ordered list of `FileEntry`. A generated `migration.sql` holds the
 *     forward statements so the orchestrator's snapshot parser recovers them.
 *     A fake `FsSnapshotManager` reads/deletes/restores/compares this model.
 *
 * ── Failure injection ───────────────────────────────────────────────────────
 * A generated injection point selects one of the two post-pre-flight failure
 * branches:
 *   • 'transaction' — one randomly chosen reverse statement throws inside the
 *     Step-3 transaction. The DB rolls back (no schema/tracking change) and no
 *     FS deletion is attempted, so all three resources stay at baseline with no
 *     compensation needed.
 *   • 'fs-delete'   — the Step-3 transaction commits (schema reversed, tracking
 *     record deleted, folder still present), then the Step-4 folder delete
 *     throws an `FsDeleteError`. This is the point-of-no-return case: the
 *     orchestrator must initiate Compensating_Recovery, which re-applies the
 *     forward statements, re-inserts the tracking record, and restores the
 *     folder from the snapshot — returning every resource to baseline.
 *
 * After `run` returns, we assert the live DB schema, the live tracking record,
 * and the live folder contents each equal the baseline captured up front. We
 * also assert the exit code reflects a failure/recovery outcome (never 0), so a
 * silent partial success cannot slip through.
 *
 * Validates: Requirements 4.4, 6.3, 6.4, 6.5
 */

// ---------------------------------------------------------------------------
// In-memory DATABASE model
// ---------------------------------------------------------------------------

interface DbState {
  /** Applied schema-object names (the "schema" the migrations mutate). */
  schema: Set<string>;
  /** The single tracking-table row keyed by migration name (or null). */
  record: MigrationRecord | null;
}

function cloneDbState(s: DbState): DbState {
  return { schema: new Set(s.schema), record: s.record ? { ...s.record } : null };
}

/**
 * Parse a modeled statement of the form `CREATE <name>` or `DROP <name>` and
 * apply it to the schema set. Unknown shapes are treated as no-ops (they never
 * occur in generated input but keep the model total).
 */
function applyStatement(schema: Set<string>, statement: string): void {
  const create = /^CREATE\s+(\S+)$/.exec(statement.trim());
  if (create) {
    schema.add(create[1]);
    return;
  }
  const drop = /^DROP\s+(\S+)$/.exec(statement.trim());
  if (drop) {
    schema.delete(drop[1]);
  }
}

/**
 * A fake `Connection` backed by a mutable `DbState`. `transaction` snapshots the
 * state on entry and restores it if the callback throws (rollback), otherwise
 * keeps the mutations (commit) — the driver contract the executor relies on.
 *
 * `execFailsOn`, when set, causes `tx.exec` to throw a `StatementError` the
 * first time it is asked to run that exact statement (the transaction-phase
 * failure injection). `execCalls` records executed statements for diagnostics.
 */
class FakeConnection implements Connection {
  closeCount = 0;
  readonly execCalls: string[] = [];

  constructor(
    private readonly db: DbState,
    private readonly execFailsOn: string | null,
    private readonly failReason: string,
  ) {}

  async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const backup = cloneDbState(this.db);
    const tx: Tx = {
      exec: async (statement: string): Promise<void> => {
        this.execCalls.push(statement);
        if (this.execFailsOn !== null && statement === this.execFailsOn) {
          throw new StatementError(statement, this.failReason);
        }
        applyStatement(this.db.schema, statement);
      },
      queryLatestMigration: async (): Promise<MigrationRecord | null> =>
        this.db.record ? { ...this.db.record } : null,
      queryMigrationByName: async (name: string): Promise<MigrationRecord | null> =>
        this.db.record && this.db.record.migrationName === name
          ? { ...this.db.record }
          : null,
      deleteMigrationRecord: async (name: string): Promise<void> => {
        if (this.db.record && this.db.record.migrationName === name) {
          this.db.record = null;
        }
      },
      insertMigrationRecord: async (record: MigrationRecord): Promise<void> => {
        this.db.record = { ...record };
      },
    };

    try {
      const result = await fn(tx);
      return result; // commit: keep mutations
    } catch (err) {
      // rollback: restore the pre-transaction state, then rethrow (R4 contract).
      this.db.schema = backup.schema;
      this.db.record = backup.record;
      throw err;
    }
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

/** A driver whose only job is to advertise transactional-DDL support + connect. */
class FakeDriver implements DbDriver {
  readonly engine = 'postgresql' as const;
  readonly supportsTransactionalDDL = true;
  constructor(private readonly conn: Connection) {}
  async connect(): Promise<Connection> {
    return this.conn;
  }
  redactedTarget(): string {
    return 'db.example.test';
  }
}

// ---------------------------------------------------------------------------
// In-memory FILESYSTEM model + fake snapshot manager
// ---------------------------------------------------------------------------

interface FsState {
  /** The migration folder's files, or null when the folder is absent. */
  files: FileEntry[] | null;
}

function cloneFiles(files: FileEntry[]): FileEntry[] {
  return files.map((f) => ({ ...f }));
}

function sortedFiles(files: FileEntry[]): FileEntry[] {
  return cloneFiles(files).sort((a, b) =>
    a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
  );
}

/**
 * A fake `FsSnapshotManager` (structurally compatible with the real one's
 * surface used by the orchestrator + recovery coordinator) backed by an
 * in-memory `FsState`. `deleteFailsCause`, when set, makes `delete` throw an
 * `FsDeleteError` (the post-commit filesystem-failure injection); the folder is
 * left present so recovery has something to compare against.
 */
class FakeSnapshotManager {
  constructor(
    private readonly fs: FsState,
    private readonly rootName: string,
    private readonly deleteFailsCause: string | null,
  ) {}

  async capture(): Promise<FolderSnapshot> {
    if (this.fs.files === null) {
      // Mirrors the real manager throwing SnapshotError on an unreadable folder;
      // never happens for the baseline capture in this property.
      throw new Error(`folder absent: ${this.rootName}`);
    }
    return { rootName: this.rootName, files: sortedFiles(this.fs.files) };
  }

  async delete(): Promise<DeleteOutcome> {
    if (this.deleteFailsCause !== null) {
      throw new FsDeleteError(this.rootName, this.deleteFailsCause, {
        isPermissionError: true,
      });
    }
    if (this.fs.files === null) {
      return { kind: 'alreadyAbsent' };
    }
    this.fs.files = null;
    return { kind: 'deleted' };
  }

  async restore(_folderPath: string, snapshot: FolderSnapshot): Promise<void> {
    this.fs.files = sortedFiles(snapshot.files);
  }

  async equals(_folderPath: string, snapshot: FolderSnapshot): Promise<boolean> {
    if (this.fs.files === null) {
      return snapshot.files.length === 0;
    }
    const current = sortedFiles(this.fs.files);
    if (current.length !== snapshot.files.length) {
      return false;
    }
    const expected = sortedFiles(snapshot.files);
    return current.every(
      (f, i) =>
        f.relativePath === expected[i].relativePath &&
        f.contentBase64 === expected[i].contentBase64 &&
        f.mode === expected[i].mode,
    );
  }
}

// ---------------------------------------------------------------------------
// A directory probe that always reports the folder exists (pre-flight passes).
// ---------------------------------------------------------------------------

const alwaysExistsProbe = { isDirectory: async (): Promise<boolean> => true };

// ---------------------------------------------------------------------------
// Test-data builders
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = '/repo/prisma/migrations';

function buildRecord(migrationName: string): MigrationRecord {
  return {
    id: `id-${migrationName}`,
    migrationName,
    checksum: `sum-${migrationName}`,
    finishedAt: '2024-01-01T00:00:00.000Z',
    startedAt: '2024-01-01T00:00:00.000Z',
    appliedStepsCount: 1,
    logs: null,
    rolledBackAt: null,
  };
}

function buildConfig(): ResolvedConfig {
  return {
    engine: 'postgresql',
    connectionUrl: 'postgresql://user:pass@db.example.test:5432/app',
    migrationsDir: MIGRATIONS_DIR,
    schemaPath: '/repo/prisma/schema.prisma',
  };
}

function buildArgs(migrationName: string): ParsedArgs {
  return {
    migrationName,
    flags: { version: false, dryRun: false, yes: true, override: false, verbose: false },
  };
}

/** Build the folder's initial files: a `migration.sql` + arbitrary extra files. */
function buildFiles(forwardStatements: string[], extras: FileEntry[]): FileEntry[] {
  const migrationSql = forwardStatements.map((s) => `${s};`).join('\n');
  const sqlEntry: FileEntry = {
    relativePath: 'migration.sql',
    contentBase64: Buffer.from(migrationSql, 'utf8').toString('base64'),
    mode: 0o644,
  };
  return sortedFiles([sqlEntry, ...extras]);
}

// ---------------------------------------------------------------------------
// The property
// ---------------------------------------------------------------------------

describe('Property 1: Atomicity — any failure restores the pre-operation baseline', () => {
  /**
   * Arbitrary for a whole scenario:
   *  - migrationName: the target (folder name + tracking record name).
   *  - objectNames: the distinct schema objects this migration created. Each
   *    yields a forward `CREATE <name>` and a reverse `DROP <name>` (inverses).
   *  - preExistingSchema: other schema objects present at baseline that the
   *    operation must not disturb.
   *  - extras: extra files in the migration folder (byte-for-byte restore).
   *  - injection: which failure branch, and (for 'transaction') which reverse
   *    statement fails.
   */
  // A safe SQL-identifier fragment: alphanumerics + underscore only. This keeps
  // modeled `CREATE <name>` / `DROP <name>` statements free of characters the
  // orchestrator's forward-SQL splitter treats specially (`;`, `--`, `/* */`,
  // newlines), so the forward statements the orchestrator parses out of
  // `migration.sql` round-trip exactly to the ones this model generated.
  const identArb = fc
    .stringMatching(/^[A-Za-z0-9_]{1,10}$/)
    .filter((s) => s.length > 0);

  const scenarioArb = fc
    .record({
      migrationName: identArb.map((s) => `mig_${s}`),
      objectNames: fc.uniqueArray(identArb.map((s) => `obj_${s}`), {
        minLength: 1,
        maxLength: 6,
      }),
      preExistingSchema: fc.uniqueArray(identArb.map((s) => `base_${s}`), {
        minLength: 0,
        maxLength: 4,
      }),
      extras: fc.array(
        fc.record({
          name: identArb.map((s) => `f_${s}.sql`),
          content: fc.string({ maxLength: 40 }),
          mode: fc.constantFrom(0o644, 0o600, 0o755),
        }),
        { maxLength: 4 },
      ),
      branch: fc.constantFrom<'transaction' | 'fs-delete'>('transaction', 'fs-delete'),
      failSelector: fc.double({ min: 0, max: 0.999, noNaN: true }),
    })
    .map((raw) => {
      // Reverse = DROP each created object; forward = CREATE each object.
      const reverse = raw.objectNames.map((n) => `DROP ${n}`);
      const forward = raw.objectNames.map((n) => `CREATE ${n}`);
      // De-duplicate extra file names against migration.sql and each other.
      const seen = new Set<string>(['migration.sql']);
      const extras: FileEntry[] = [];
      for (const e of raw.extras) {
        if (seen.has(e.name)) {
          continue;
        }
        seen.add(e.name);
        extras.push({
          relativePath: e.name,
          contentBase64: Buffer.from(e.content, 'utf8').toString('base64'),
          mode: e.mode,
        });
      }
      const failIndex = Math.floor(raw.failSelector * reverse.length);
      return {
        migrationName: raw.migrationName,
        objectNames: raw.objectNames,
        preExistingSchema: raw.preExistingSchema,
        reverse,
        forward,
        extras,
        branch: raw.branch,
        failingStatement: reverse[Math.min(failIndex, reverse.length - 1)],
      };
    });

  it('restores DB schema, tracking record, and migration folder to baseline on any injected failure', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        // ── Baseline: DB schema = pre-existing + this migration's objects; the
        //    tracking record is present; the folder holds migration.sql + extras.
        const baselineSchema = new Set<string>([
          ...scenario.preExistingSchema,
          ...scenario.objectNames,
        ]);
        const baselineRecord = buildRecord(scenario.migrationName);
        const baselineFiles = buildFiles(scenario.forward, scenario.extras);

        // Live, mutable state the orchestrator will drive.
        const db: DbState = {
          schema: new Set(baselineSchema),
          record: { ...baselineRecord },
        };
        const fs: FsState = { files: cloneFiles(baselineFiles) };

        // Wire the failure injection for the chosen branch.
        const execFailsOn =
          scenario.branch === 'transaction' ? scenario.failingStatement : null;
        const deleteFailsCause =
          scenario.branch === 'fs-delete' ? 'permission denied (injected)' : null;

        const conn = new FakeConnection(db, execFailsOn, 'injected statement failure');
        const driver = new FakeDriver(conn);
        const snapshotManager = new FakeSnapshotManager(
          fs,
          scenario.migrationName,
          deleteFailsCause,
        );

        // Real executor + real recovery coordinator, wired to the in-memory
        // fakes. The recovery coordinator uses the real executor's restore path.
        const executor = new TransactionalExecutor();
        // Reverse-SQL generator is stubbed to return the modeled reverse
        // statements (its real engine dependency is out of scope for Property 1).
        const reverseSqlGenerator = {
          generate: async () => ({
            raw: scenario.reverse.map((s) => `${s};`).join('\n'),
            statements: scenario.reverse,
          }),
        } as unknown as ReverseSqlGenerator;

        const recoveryCoordinator = new RecoveryCoordinator(
          executor,
          snapshotManager as unknown as import('../../src/snapshot/fs-snapshot-manager.js').FsSnapshotManager,
        );

        const orchestrator = new RollbackOrchestrator({
          validator: new TargetValidator(alwaysExistsProbe),
          reverseSqlGenerator,
          executor,
          snapshotManager:
            snapshotManager as unknown as import('../../src/snapshot/fs-snapshot-manager.js').FsSnapshotManager,
          recoveryCoordinator,
          logger: new ConsoleLogger({ out: () => {}, err: () => {} }),
          confirm: async () => true,
        });

        const exitCode = await orchestrator.run(
          buildArgs(scenario.migrationName),
          buildConfig(),
          driver,
        );

        // ── Assertion 1: the final DB SCHEMA equals the baseline. ────────────
        const finalSchema = [...db.schema].sort();
        const expectedSchema = [...baselineSchema].sort();
        expect(finalSchema).toEqual(expectedSchema);

        // ── Assertion 2: the final TRACKING RECORD equals the baseline. ──────
        expect(db.record).toEqual(baselineRecord);

        // ── Assertion 3: the final MIGRATION FOLDER equals the baseline. ─────
        expect(fs.files).not.toBeNull();
        expect(sortedFiles(fs.files as FileEntry[])).toEqual(sortedFiles(baselineFiles));

        // ── Assertion 4: a failure was injected, so the exit code is never a
        //    clean success (0). Both branches map to a non-zero failure/recovery
        //    outcome, guarding against a silent partial success. ──────────────
        expect(exitCode).not.toBe(0);
        if (scenario.branch === 'transaction') {
          // Transaction-phase failure → clean abort (execution failure).
          expect(exitCode).toBe(EXIT_EXECUTION_FAILURE);
        } else {
          // Post-commit FS failure → compensating recovery outcome.
          expect(exitCode).toBe(EXIT_VALIDATION);
        }

        // ── Assertion 5: the connection was always closed (R7.6). ────────────
        expect(conn.closeCount).toBe(1);

        return true;
      }),
      { numRuns: 200 },
    );
  });
});
