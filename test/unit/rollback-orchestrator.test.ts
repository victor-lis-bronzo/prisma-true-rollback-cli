// Unit tests for the Rollback Orchestrator (RollbackOrchestrator).
//
// Covers Task 13.8: validation branches and safeguard/FS wiring, exercised by
// injecting fakes for every collaborator (validator, reverseSqlGenerator,
// executor, snapshotManager, recoveryCoordinator, logger, confirm) plus a fake
// driver/connection. Each collaborator records into a single shared, ordered
// call log so cross-collaborator ordering (warning-before-change,
// snapshot-before-delete, recovery-on-delete-failure) can be asserted exactly.
//
// Branches covered:
//   - Unknown folder (R1.4) / no-tracking-record (R1.5): validator throws
//     TargetValidationError → run returns exit 1 and NO destructive collaborator
//     (executor.applyReversal, snapshotManager.delete) is invoked.
//   - Destructive warning before any change (R2.3): a logger warning is captured
//     before any executor/delete call.
//   - Interactive confirmation gate (R2.4/2.5/2.6): decline OR timeout (confirm
//     returns false) → exit 0, no destructive collaborator ran; --yes → confirm
//     never called and the operation proceeds.
//   - Snapshot-before-delete ordering (R5.1): snapshot capture is recorded
//     before the folder delete.
//   - Recovery-on-delete-failure wiring (R5.4/R6.3): snapshotManager.delete
//     throwing after a committed transaction invokes recoveryCoordinator.recover.
//   - Success message + exit 0 (R5.5/R5.6).
//   - Snapshot-capture-failure abort (R6.2): capture throws → non-zero exit, no
//     folder delete.
//
// Requirements: 1.4, 1.5, 2.3, 2.4, 2.5, 2.6, 5.1, 5.4, 5.5, 5.6, 6.1, 6.2, 6.3

import { describe, it, expect } from 'vitest';

import {
  RollbackOrchestrator,
  EXIT_SUCCESS,
  EXIT_VALIDATION,
  EXIT_EXECUTION_FAILURE,
  type OrchestratorDeps,
} from '../../src/orchestrator/rollback-orchestrator.js';
import {
  TargetValidationError,
  type TargetValidationReason,
  type ValidatedTarget,
} from '../../src/orchestrator/target-validator.js';
import type { TransactionalExecutor } from '../../src/executor/transactional-executor.js';
import type { ReverseSqlGenerator } from '../../src/reverse-sql/reverse-sql-generator.js';
import type { FsSnapshotManager } from '../../src/snapshot/fs-snapshot-manager.js';
import type { RecoveryCoordinator } from '../../src/recovery/recovery-coordinator.js';
import type { Logger } from '../../src/logger/logger.js';
import { FsDeleteError, SnapshotError } from '../../src/models/errors.js';
import type { Connection, DbDriver, Tx } from '../../src/drivers/driver.js';
import type {
  DeleteOutcome,
  MigrationRecord,
  ParsedArgs,
  RecoveryReport,
  ResolvedConfig,
  ReverseSql,
} from '../../src/models/types.js';

// ---------------------------------------------------------------------------
// Shared, ordered call log
// ---------------------------------------------------------------------------
//
// Every collaborator appends a tagged entry to one list so tests can assert the
// exact interleaving of warnings, snapshot capture, reversal, delete, and
// recovery across collaborators — not just within one of them.

type CallLog = string[];

const MIGRATIONS_DIR = '/repo/prisma/migrations';
const MIGRATION_NAME = '20240101000000_init';
const FOLDER_PATH = `${MIGRATIONS_DIR}/${MIGRATION_NAME}`;

// ---------------------------------------------------------------------------
// Test-data builders
// ---------------------------------------------------------------------------

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

function buildArgs(overrides: Partial<ParsedArgs['flags']> = {}): ParsedArgs {
  return {
    migrationName: MIGRATION_NAME,
    flags: {
      version: false,
      dryRun: false,
      yes: false,
      override: false,
      verbose: false,
      ...overrides,
    },
  };
}

function buildReverseSql(): ReverseSql {
  return { raw: 'DROP TABLE "Widget";', statements: ['DROP TABLE "Widget"'] };
}

// ---------------------------------------------------------------------------
// Fake connection + driver (record open/close; harmless Tx)
// ---------------------------------------------------------------------------

class FakeConnection implements Connection {
  closeCount = 0;
  constructor(private readonly log: CallLog) {}

  async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const tx: Tx = {
      exec: async () => {},
      queryLatestMigration: async () => null,
      queryMigrationByName: async () => null,
      deleteMigrationRecord: async () => {},
      insertMigrationRecord: async () => {},
    };
    return fn(tx);
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    this.log.push('conn.close');
  }
}

class FakeDriver implements DbDriver {
  readonly engine = 'postgresql' as const;
  constructor(
    private readonly conn: Connection,
    readonly supportsTransactionalDDL: boolean = true,
  ) {}
  async connect(): Promise<Connection> {
    return this.conn;
  }
  redactedTarget(): string {
    return 'db.example.test';
  }
}

// ---------------------------------------------------------------------------
// Capturing logger — records level + message and tags warnings into the log
// ---------------------------------------------------------------------------

interface LoggedLine {
  level: 'step' | 'stepDone' | 'stepFailed' | 'info' | 'warn' | 'verbose' | 'error';
  message: string;
}

class CapturingLogger implements Logger {
  readonly lines: LoggedLine[] = [];
  constructor(private readonly log: CallLog) {}

  step(index: number, total: number, name: string): void {
    this.lines.push({ level: 'step', message: `Step ${index} of ${total}: ${name}` });
  }
  stepDone(name: string): void {
    this.lines.push({ level: 'stepDone', message: name });
  }
  stepFailed(name: string, error: unknown): void {
    this.lines.push({ level: 'stepFailed', message: `${name}: ${String(error)}` });
  }
  info(message: string): void {
    this.lines.push({ level: 'info', message });
  }
  warn(message: string): void {
    this.lines.push({ level: 'warn', message });
    this.log.push('logger.warn');
  }
  verbose(message: string): void {
    this.lines.push({ level: 'verbose', message });
  }
  error(message: string): void {
    this.lines.push({ level: 'error', message });
  }

  /** True when any captured line at `level` includes `substr`. */
  has(level: LoggedLine['level'], substr: string): boolean {
    return this.lines.some((l) => l.level === level && l.message.includes(substr));
  }
}

// ---------------------------------------------------------------------------
// Fake collaborators (validator, generator, executor, snapshot mgr, recovery)
// ---------------------------------------------------------------------------

/** A validator that either throws a TargetValidationError or returns a target. */
class FakeValidator {
  applyReversalGuard = false;
  constructor(
    private readonly log: CallLog,
    private readonly outcome:
      | { kind: 'ok'; result: ValidatedTarget }
      | { kind: 'throw'; reason: TargetValidationReason; message: string },
  ) {}

  async validate(): Promise<ValidatedTarget> {
    this.log.push('validator.validate');
    if (this.outcome.kind === 'throw') {
      throw new TargetValidationError(
        this.outcome.reason,
        MIGRATION_NAME,
        this.outcome.message,
      );
    }
    return this.outcome.result;
  }
}

class FakeReverseSqlGenerator {
  constructor(
    private readonly log: CallLog,
    private readonly reverse: ReverseSql = buildReverseSql(),
  ) {}
  async generate(): Promise<ReverseSql> {
    this.log.push('generator.generate');
    return this.reverse;
  }
}

class FakeExecutor {
  applyReversalCount = 0;
  constructor(
    private readonly log: CallLog,
    private readonly throwOnApply = false,
  ) {}
  async applyReversal(): Promise<void> {
    this.applyReversalCount += 1;
    this.log.push('executor.applyReversal');
    if (this.throwOnApply) {
      throw new Error('injected reversal failure');
    }
  }
  async restoreDatabase(): Promise<void> {
    this.log.push('executor.restoreDatabase');
  }
}

class FakeSnapshotManager {
  captureCount = 0;
  deleteCount = 0;
  constructor(
    private readonly log: CallLog,
    private readonly opts: {
      captureThrows?: boolean;
      deleteThrows?: boolean;
      deleteOutcome?: DeleteOutcome;
    } = {},
  ) {}

  async capture(): Promise<{ rootName: string; files: [] }> {
    this.captureCount += 1;
    this.log.push('snapshot.capture');
    if (this.opts.captureThrows) {
      throw new SnapshotError('injected capture failure', { folderPath: FOLDER_PATH });
    }
    return { rootName: MIGRATION_NAME, files: [] };
  }

  async delete(): Promise<DeleteOutcome> {
    this.deleteCount += 1;
    this.log.push('snapshot.delete');
    if (this.opts.deleteThrows) {
      throw new FsDeleteError(FOLDER_PATH, 'injected delete failure', {
        isPermissionError: true,
      });
    }
    return this.opts.deleteOutcome ?? { kind: 'deleted' };
  }

  async restore(): Promise<void> {
    this.log.push('snapshot.restore');
  }
  async equals(): Promise<boolean> {
    return true;
  }
}

class FakeRecoveryCoordinator {
  recoverCount = 0;
  constructor(
    private readonly log: CallLog,
    private readonly report: RecoveryReport = { fullyRestored: true, unrestored: [] },
  ) {}
  async recover(): Promise<RecoveryReport> {
    this.recoverCount += 1;
    this.log.push('recovery.recover');
    return this.report;
  }
}

// ---------------------------------------------------------------------------
// Harness: wire an orchestrator to a fresh set of fakes over one shared log
// ---------------------------------------------------------------------------

interface Harness {
  orchestrator: RollbackOrchestrator;
  log: CallLog;
  logger: CapturingLogger;
  validator: FakeValidator;
  generator: FakeReverseSqlGenerator;
  executor: FakeExecutor;
  snapshotManager: FakeSnapshotManager;
  recovery: FakeRecoveryCoordinator;
  conn: FakeConnection;
  driver: FakeDriver;
  confirmCalls: number;
  run(args?: ParsedArgs): Promise<number>;
}

interface HarnessOptions {
  validatorOutcome?:
    | { kind: 'ok'; result: ValidatedTarget }
    | { kind: 'throw'; reason: TargetValidationReason; message: string };
  captureThrows?: boolean;
  deleteThrows?: boolean;
  deleteOutcome?: DeleteOutcome;
  throwOnApply?: boolean;
  confirmResult?: boolean;
  supportsTransactionalDDL?: boolean;
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const log: CallLog = [];
  const logger = new CapturingLogger(log);

  const validator = new FakeValidator(
    log,
    options.validatorOutcome ?? {
      kind: 'ok',
      result: {
        target: { name: MIGRATION_NAME, folderPath: FOLDER_PATH },
        record: buildRecord(MIGRATION_NAME),
      },
    },
  );
  const generator = new FakeReverseSqlGenerator(log);
  const executor = new FakeExecutor(log, options.throwOnApply ?? false);
  const snapshotManager = new FakeSnapshotManager(log, {
    captureThrows: options.captureThrows,
    deleteThrows: options.deleteThrows,
    deleteOutcome: options.deleteOutcome,
  });
  const recovery = new FakeRecoveryCoordinator(log);
  const conn = new FakeConnection(log);
  const driver = new FakeDriver(conn, options.supportsTransactionalDDL ?? true);

  const harness = {
    log,
    logger,
    validator,
    generator,
    executor,
    snapshotManager,
    recovery,
    conn,
    driver,
    confirmCalls: 0,
  } as Harness;

  const confirm = async (): Promise<boolean> => {
    harness.confirmCalls += 1;
    log.push('confirm');
    return options.confirmResult ?? true;
  };

  const deps: OrchestratorDeps = {
    validator: validator as unknown as OrchestratorDeps['validator'],
    reverseSqlGenerator: generator as unknown as ReverseSqlGenerator,
    executor: executor as unknown as TransactionalExecutor,
    snapshotManager: snapshotManager as unknown as FsSnapshotManager,
    recoveryCoordinator: recovery as unknown as RecoveryCoordinator,
    logger,
    confirm,
  };

  harness.orchestrator = new RollbackOrchestrator(deps);
  harness.run = (args?: ParsedArgs) =>
    harness.orchestrator.run(args ?? buildArgs(), buildConfig(), driver);

  return harness;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RollbackOrchestrator — target validation branches', () => {
  it('unknown folder (R1.4): validator throws → exit 1 and no destructive collaborator runs', async () => {
    const h = makeHarness({
      validatorOutcome: {
        kind: 'throw',
        reason: 'unknown-folder',
        message: 'Unknown migration "…": no matching folder was found.',
      },
    });

    const exit = await h.run();

    expect(exit).toBe(EXIT_VALIDATION);
    // No reversal, no delete — a validation failure is a clean pre-flight abort.
    expect(h.executor.applyReversalCount).toBe(0);
    expect(h.snapshotManager.deleteCount).toBe(0);
    expect(h.snapshotManager.captureCount).toBe(0);
    // The validation message reached stderr.
    expect(h.logger.has('error', 'Unknown migration')).toBe(true);
    // The connection was still opened and closed.
    expect(h.conn.closeCount).toBe(1);
  });

  it('no tracking record (R1.5): validator throws → exit 1 and no destructive collaborator runs', async () => {
    const h = makeHarness({
      validatorOutcome: {
        kind: 'throw',
        reason: 'not-recorded',
        message: 'Migration "…" is not recorded as applied; nothing to roll back.',
      },
    });

    const exit = await h.run();

    expect(exit).toBe(EXIT_VALIDATION);
    expect(h.executor.applyReversalCount).toBe(0);
    expect(h.snapshotManager.deleteCount).toBe(0);
    expect(h.logger.has('error', 'is not recorded as applied')).toBe(true);
  });
});

describe('RollbackOrchestrator — destructive warning (R2.3)', () => {
  it('emits the destructive warning BEFORE any reversal or folder delete', async () => {
    const h = makeHarness({ confirmResult: true });

    await h.run(buildArgs());

    // A warning was captured, and mentions the migration name + irreversibility.
    expect(h.logger.has('warn', MIGRATION_NAME)).toBe(true);
    expect(h.logger.has('warn', 'cannot be undone')).toBe(true);

    // The first warning strictly precedes the first reversal and the first delete.
    const firstWarn = h.log.indexOf('logger.warn');
    const firstReversal = h.log.indexOf('executor.applyReversal');
    const firstDelete = h.log.indexOf('snapshot.delete');
    expect(firstWarn).toBeGreaterThan(-1);
    expect(firstReversal).toBeGreaterThan(firstWarn);
    expect(firstDelete).toBeGreaterThan(firstWarn);
  });
});

describe('RollbackOrchestrator — interactive confirmation gate (R2.4/2.5/2.6)', () => {
  it('decline (confirm returns false) → exit 0 and no destructive collaborator runs (R2.4/R2.5)', async () => {
    const h = makeHarness({ confirmResult: false });

    const exit = await h.run(buildArgs({ yes: false }));

    expect(exit).toBe(EXIT_SUCCESS);
    expect(h.confirmCalls).toBe(1);
    expect(h.executor.applyReversalCount).toBe(0);
    expect(h.snapshotManager.deleteCount).toBe(0);
    expect(h.snapshotManager.captureCount).toBe(0);
    // "no changes were made" style message surfaced to the user.
    expect(h.logger.has('info', 'No changes were made')).toBe(true);
  });

  it('timeout is modeled as confirm resolving false → exit 0 and no destructive collaborator runs (R2.5)', async () => {
    // Per the ConfirmFn contract, a 60s timeout resolves to false, so the
    // timeout path is behaviourally identical to an explicit decline.
    const h = makeHarness({ confirmResult: false });

    const exit = await h.run(buildArgs({ yes: false }));

    expect(exit).toBe(EXIT_SUCCESS);
    expect(h.executor.applyReversalCount).toBe(0);
    expect(h.snapshotManager.deleteCount).toBe(0);
  });

  it('--yes: confirm is NEVER called and the operation proceeds to completion (R2.6)', async () => {
    const h = makeHarness();

    const exit = await h.run(buildArgs({ yes: true }));

    expect(h.confirmCalls).toBe(0);
    expect(h.log).not.toContain('confirm');
    // Proceeded through the destructive steps to a successful completion.
    expect(h.executor.applyReversalCount).toBe(1);
    expect(h.snapshotManager.deleteCount).toBe(1);
    expect(exit).toBe(EXIT_SUCCESS);
  });
});

describe('RollbackOrchestrator — snapshot-before-delete ordering (R5.1)', () => {
  it('captures the pre-operation snapshot BEFORE deleting the folder', async () => {
    const h = makeHarness({ confirmResult: true });

    await h.run();

    const captureIndex = h.log.indexOf('snapshot.capture');
    const deleteIndex = h.log.indexOf('snapshot.delete');
    expect(captureIndex).toBeGreaterThan(-1);
    expect(deleteIndex).toBeGreaterThan(-1);
    expect(captureIndex).toBeLessThan(deleteIndex);
  });

  it('captures the snapshot BEFORE the first destructive action (reversal) (R6.1)', async () => {
    const h = makeHarness({ confirmResult: true });

    await h.run();

    const captureIndex = h.log.indexOf('snapshot.capture');
    const reversalIndex = h.log.indexOf('executor.applyReversal');
    expect(captureIndex).toBeGreaterThan(-1);
    expect(reversalIndex).toBeGreaterThan(-1);
    expect(captureIndex).toBeLessThan(reversalIndex);
  });
});

describe('RollbackOrchestrator — recovery-on-delete-failure wiring (R5.4/R6.3)', () => {
  it('invokes recoveryCoordinator.recover when delete throws after the committed transaction', async () => {
    const h = makeHarness({ confirmResult: true, deleteThrows: true });

    const exit = await h.run();

    // The transaction committed (reversal ran), then the delete failed.
    expect(h.executor.applyReversalCount).toBe(1);
    expect(h.snapshotManager.deleteCount).toBe(1);
    // Recovery was initiated exactly once.
    expect(h.recovery.recoverCount).toBe(1);

    // Ordering: reversal → delete (fails) → recovery.
    const reversalIndex = h.log.indexOf('executor.applyReversal');
    const deleteIndex = h.log.indexOf('snapshot.delete');
    const recoveryIndex = h.log.indexOf('recovery.recover');
    expect(reversalIndex).toBeLessThan(deleteIndex);
    expect(deleteIndex).toBeLessThan(recoveryIndex);

    // A full-restore recovery report maps to exit 1.
    expect(exit).toBe(EXIT_VALIDATION);
  });
});

describe('RollbackOrchestrator — success (R5.5/R5.6)', () => {
  it('emits the full-rollback success message and exits 0 on the happy path', async () => {
    const h = makeHarness({ confirmResult: true });

    const exit = await h.run();

    expect(exit).toBe(EXIT_SUCCESS);
    expect(h.executor.applyReversalCount).toBe(1);
    expect(h.snapshotManager.deleteCount).toBe(1);
    expect(h.recovery.recoverCount).toBe(0);
    // Success message references the migration name and the completed rollback.
    expect(h.logger.has('info', MIGRATION_NAME)).toBe(true);
    expect(h.logger.has('info', 'fully rolled back')).toBe(true);
    // The connection was closed on the success path too.
    expect(h.conn.closeCount).toBe(1);
  });
});

describe('RollbackOrchestrator — snapshot-capture-failure abort (R6.2)', () => {
  it('aborts non-zero and NEVER deletes the folder when capture throws', async () => {
    const h = makeHarness({ confirmResult: true, captureThrows: true });

    const exit = await h.run();

    expect(exit).toBe(EXIT_EXECUTION_FAILURE);
    // Capture was attempted and failed; no destructive folder delete followed.
    expect(h.snapshotManager.captureCount).toBe(1);
    expect(h.snapshotManager.deleteCount).toBe(0);
    // No recovery is needed for a pre-destructive-action abort.
    expect(h.recovery.recoverCount).toBe(0);
    // The failure was reported and the connection closed.
    expect(h.logger.lines.some((l) => l.level === 'stepFailed')).toBe(true);
    expect(h.conn.closeCount).toBe(1);
  });
});
