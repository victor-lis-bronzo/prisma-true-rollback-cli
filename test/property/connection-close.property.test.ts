// Feature: prisma-true-rollback-cli, Property 13: Opened connections are always closed
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  RollbackOrchestrator,
} from '../../src/orchestrator/rollback-orchestrator.js';
import { ConsoleLogger } from '../../src/logger/logger.js';
import { TargetValidationError } from '../../src/orchestrator/target-validator.js';
import {
  FsDeleteError,
  ReverseSqlError,
  TransactionAbortedError,
} from '../../src/models/errors.js';
import type { Connection, DbDriver, Tx } from '../../src/drivers/driver.js';
import type {
  DeleteOutcome,
  FolderSnapshot,
  MigrationRecord,
  ParsedArgs,
  RecoveryReport,
  ResolvedConfig,
  ReverseSql,
  TargetMigration,
} from '../../src/models/types.js';
import type { TargetValidator } from '../../src/orchestrator/target-validator.js';
import type { ReverseSqlGenerator } from '../../src/reverse-sql/reverse-sql-generator.js';
import type { TransactionalExecutor } from '../../src/executor/transactional-executor.js';
import type { FsSnapshotManager } from '../../src/snapshot/fs-snapshot-manager.js';
import type { RecoveryCoordinator } from '../../src/recovery/recovery-coordinator.js';

/**
 * Property 13: Opened connections are always closed.
 *
 * *For any* execution path — a full success, OR a failure injected at any step
 * of the Rollback_Operation (pre-flight validation, reverse-SQL generation, the
 * Step-3 transaction, or the Step-4 folder delete → compensating recovery) —
 * in which a Database connection was successfully opened, the orchestrator SHALL
 * close that connection EXACTLY ONCE before returning, and `run(...)` SHALL
 * return an exit code without letting any exception escape.
 *
 * ── Modeling strategy ───────────────────────────────────────────────────────
 * The guarantee under test lives in `RollbackOrchestrator.run`, whose
 * `try/finally` wraps the whole post-connect sequence and calls `conn.close()`
 * once on every branch (R7.6). To exercise every branch deterministically we
 * drive the *real* orchestrator but replace each collaborator with a minimal
 * fake injected through `OrchestratorDeps`. A single generated failure-injection
 * choice decides which fake throws (or that all succeed):
 *
 *   • 'validate'   — the validator throws a TargetValidationError (pre-flight
 *                    abort → exit 1). The connection is already open.
 *   • 'reverse-sql'— the reverse-SQL generator throws (Step 1 failure → exit 2).
 *   • 'transaction'— the executor's applyReversal throws (Step 3 abort → exit 2).
 *   • 'fs-delete'  — the snapshot manager's delete throws an FsDeleteError
 *                    (Step 4 post-commit failure), triggering compensating
 *                    recovery through the injected recovery coordinator.
 *   • 'success'    — every collaborator succeeds and the operation completes
 *                    (exit 0).
 *
 * The `FakeConnection` counts `close()` invocations. For each generated
 * scenario we assert (a) `run` resolves to a number and never throws, and
 * (b) the connection was closed exactly once — independent of the path taken.
 *
 * Validates: Requirements 7.6
 */

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = '/repo/prisma/migrations';
const MIGRATION_NAME = 'mig_target';

/** A fake connection whose only responsibility is to count `close()` calls. */
class FakeConnection implements Connection {
  closeCount = 0;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async transaction<T>(_fn: (tx: Tx) => Promise<T>): Promise<T> {
    // Never invoked directly in these tests: the executor collaborator is a
    // fake, so it does not open a transaction on this connection. Kept total
    // so the fake fully satisfies the Connection contract.
    throw new Error('FakeConnection.transaction should not be called in this property');
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

/**
 * A driver that hands back a pre-built {@link FakeConnection}. `connect` always
 * succeeds here because the property is scoped to paths where the connection
 * *was* opened (a connect failure never opens a connection, so there is nothing
 * to close — that branch is out of scope for Property 13).
 */
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
// Test-data builders
// ---------------------------------------------------------------------------

function buildRecord(): MigrationRecord {
  return {
    id: `id-${MIGRATION_NAME}`,
    migrationName: MIGRATION_NAME,
    checksum: `sum-${MIGRATION_NAME}`,
    finishedAt: '2024-01-01T00:00:00.000Z',
    startedAt: '2024-01-01T00:00:00.000Z',
    appliedStepsCount: 1,
    logs: null,
    rolledBackAt: null,
  };
}

function buildTarget(): TargetMigration {
  return { name: MIGRATION_NAME, folderPath: `${MIGRATIONS_DIR}/${MIGRATION_NAME}` };
}

function buildFolderSnapshot(): FolderSnapshot {
  return {
    rootName: MIGRATION_NAME,
    files: [
      {
        relativePath: 'migration.sql',
        contentBase64: Buffer.from('CREATE obj_a;', 'utf8').toString('base64'),
        mode: 0o644,
      },
    ],
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

function buildArgs(): ParsedArgs {
  // --yes so the run is non-interactive; dry-run stays false so the full
  // destructive sequence (through Step 4) is exercised.
  return {
    migrationName: MIGRATION_NAME,
    flags: { version: false, dryRun: false, yes: true, override: false, verbose: false },
  };
}

// ---------------------------------------------------------------------------
// Injection points
// ---------------------------------------------------------------------------

type Injection =
  | 'validate'
  | 'reverse-sql'
  | 'transaction'
  | 'fs-delete'
  | 'success';

const REVERSE_SQL: ReverseSql = {
  raw: 'DROP obj_a;',
  statements: ['DROP obj_a'],
};

/**
 * Build a fully-wired orchestrator whose collaborators succeed except the one
 * selected by `injection`, which throws. Returns both the orchestrator and the
 * shared {@link FakeConnection} so the test can inspect its close count.
 */
function buildOrchestrator(injection: Injection): {
  orchestrator: RollbackOrchestrator;
  conn: FakeConnection;
  driver: DbDriver;
} {
  const conn = new FakeConnection();
  const driver = new FakeDriver(conn);
  const record = buildRecord();
  const target = buildTarget();

  const validator = {
    validate: async () => {
      if (injection === 'validate') {
        throw new TargetValidationError(
          'not-latest',
          MIGRATION_NAME,
          'Injected validation failure.',
        );
      }
      return { target, record };
    },
  } as unknown as TargetValidator;

  const reverseSqlGenerator = {
    generate: async () => {
      if (injection === 'reverse-sql') {
        throw new ReverseSqlError('Injected reverse-SQL generation failure.');
      }
      return REVERSE_SQL;
    },
  } as unknown as ReverseSqlGenerator;

  const executor = {
    applyReversal: async () => {
      if (injection === 'transaction') {
        throw new TransactionAbortedError(
          'DROP obj_a',
          'injected statement failure',
        );
      }
    },
  } as unknown as TransactionalExecutor;

  const snapshotManager = {
    capture: async (): Promise<FolderSnapshot> => buildFolderSnapshot(),
    delete: async (): Promise<DeleteOutcome> => {
      if (injection === 'fs-delete') {
        throw new FsDeleteError(MIGRATION_NAME, 'permission denied (injected)', {
          isPermissionError: true,
        });
      }
      return { kind: 'deleted' };
    },
  } as unknown as FsSnapshotManager;

  // Recovery is only reached on the 'fs-delete' branch; report a full restore
  // (its own exit-code mapping is covered by other properties). The point here
  // is purely that the connection still gets closed once afterwards.
  const recoveryCoordinator = {
    recover: async (): Promise<RecoveryReport> => ({
      fullyRestored: true,
      unrestored: [],
    }),
  } as unknown as RecoveryCoordinator;

  const orchestrator = new RollbackOrchestrator({
    validator,
    reverseSqlGenerator,
    executor,
    snapshotManager,
    recoveryCoordinator,
    logger: new ConsoleLogger({ out: () => {}, err: () => {} }),
    confirm: async () => true,
  });

  return { orchestrator, conn, driver };
}

// ---------------------------------------------------------------------------
// The property
// ---------------------------------------------------------------------------

describe('Property 13: Opened connections are always closed', () => {
  const injectionArb = fc.constantFrom<Injection>(
    'validate',
    'reverse-sql',
    'transaction',
    'fs-delete',
    'success',
  );

  it('closes the opened connection exactly once on every success/failure path and never throws', async () => {
    await fc.assert(
      fc.asyncProperty(injectionArb, async (injection) => {
        const { orchestrator, conn, driver } = buildOrchestrator(injection);

        // run(...) must resolve to an exit code — no exception may escape,
        // regardless of which step failed.
        const exitCode = await orchestrator.run(buildArgs(), buildConfig(), driver);
        expect(typeof exitCode).toBe('number');

        // The core guarantee: the opened connection was closed EXACTLY ONCE
        // before run returned, on this (and therefore every) path (R7.6).
        expect(conn.closeCount).toBe(1);

        return true;
      }),
      { numRuns: 100 },
    );
  });
});
