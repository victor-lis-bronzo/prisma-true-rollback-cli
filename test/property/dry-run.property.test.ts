// Feature: prisma-true-rollback-cli, Property 9: Dry-run purity
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  RollbackOrchestrator,
  EXIT_SUCCESS,
  type OrchestratorDeps,
} from '../../src/orchestrator/rollback-orchestrator.js';
import type { TargetValidator } from '../../src/orchestrator/target-validator.js';
import type { ReverseSqlGenerator } from '../../src/reverse-sql/reverse-sql-generator.js';
import type { TransactionalExecutor } from '../../src/executor/transactional-executor.js';
import type { FsSnapshotManager } from '../../src/snapshot/fs-snapshot-manager.js';
import type { Logger } from '../../src/logger/logger.js';
import type { Connection, DbDriver } from '../../src/drivers/driver.js';
import type {
  ParsedArgs,
  ReverseSql,
  ResolvedConfig,
  MigrationRecord,
} from '../../src/models/types.js';

/**
 * Property 9: Dry-run purity.
 *
 * For any generated Reverse_SQL, invoking the orchestrator with the dry-run
 * flag (`args.flags.dryRun = true`) — and `--yes` to bypass the interactive
 * confirmation — SHALL:
 *   - emit the complete Reverse_SQL verbatim (the captured logger output
 *     contains `reverse.raw`),
 *   - perform ZERO changes to the Database or the file system (the mutating
 *     collaborators are NEVER called: `executor.applyReversal` stays 0, and the
 *     snapshot manager's `delete` stays 0; `capture` — which reads and thus
 *     would precede any destructive action — is likewise never reached), and
 *   - terminate with exit code 0 (R3.4).
 *
 * Strategy: inject fakes into {@link RollbackOrchestrator} via its constructor
 * deps —
 *   - a fake validator resolving a valid target (so pre-flight passes with no
 *     changes),
 *   - a fake reverse-SQL generator whose `generate` returns `{ raw, statements }`
 *     with an arbitrary `raw` string,
 *   - a fake executor whose `applyReversal` increments a counter that MUST stay
 *     0,
 *   - a fake snapshot manager whose `delete`/`capture` increment counters
 *     (`delete` MUST stay 0),
 *   - a capturing logger (identity — no redaction — so `raw` survives verbatim
 *     for the assertion),
 *   - a fake driver with `supportsTransactionalDDL: true` and a no-op
 *     connection.
 *
 * We generate arbitrary `raw` SQL strings across ≥100 iterations and assert
 * `run(...)` returns 0, the captured output contains the exact `raw` text, and
 * no mutating collaborator ran.
 *
 * Validates: Requirements 3.4
 */
describe('Property 9: Dry-run purity', () => {
  const cfg: ResolvedConfig = {
    engine: 'postgresql',
    connectionUrl: 'postgresql://user:pw@localhost:5432/db',
    migrationsDir: '/repo/prisma/migrations',
    schemaPath: '/repo/prisma/schema.prisma',
  };

  const args: ParsedArgs = {
    migrationName: '20240101000000_init',
    flags: {
      version: false,
      dryRun: true, // exercise the dry-run path (R3.4)
      yes: true, // bypass interactive confirmation
      override: false,
      verbose: false,
    },
  };

  const record: MigrationRecord = {
    id: 'rec-1',
    migrationName: args.migrationName,
    checksum: 'abc',
    finishedAt: '2024-01-01T00:00:00.000Z',
    startedAt: '2024-01-01T00:00:00.000Z',
    appliedStepsCount: 1,
    logs: null,
    rolledBackAt: null,
  };

  it('emits the reverse SQL verbatim, makes zero changes, and exits 0', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), async (raw) => {
        // ── Mutation counters (must all stay 0 on the dry-run path). ────────
        let applyReversalCount = 0;
        let deleteCount = 0;
        let captureCount = 0;

        // ── Identity redactor via a capturing logger. All output is collected
        //    so we can assert the raw SQL appears verbatim. ─────────────────
        const captured: string[] = [];
        const logger: Logger = {
          step: (i, n, name) => captured.push(`STEP ${i}/${n}: ${name}`),
          stepDone: (name) => captured.push(`DONE ${name}`),
          stepFailed: (name, error) => captured.push(`FAILED ${name}: ${String(error)}`),
          info: (m) => captured.push(m),
          warn: (m) => captured.push(m),
          verbose: (m) => captured.push(m),
          error: (m) => captured.push(m),
        };

        // ── Fake validator: resolves a valid target with its tracking record. ─
        const validator = {
          async validate() {
            return {
              target: {
                name: args.migrationName,
                folderPath: `${cfg.migrationsDir}/${args.migrationName}`,
              },
              record,
            };
          },
        } as unknown as TargetValidator;

        // ── Fake generator: returns { raw, statements } with the arbitrary raw. ─
        const reverseSqlGenerator = {
          async generate(): Promise<ReverseSql> {
            return { raw, statements: ['DROP TABLE "Foo";'] };
          },
        } as unknown as ReverseSqlGenerator;

        // ── Fake executor: applyReversal must never run on the dry-run path. ──
        const executor = {
          async applyReversal(): Promise<void> {
            applyReversalCount += 1;
          },
        } as unknown as TransactionalExecutor;

        // ── Fake snapshot manager: capture/delete must never run on dry-run. ──
        const snapshotManager = {
          async capture() {
            captureCount += 1;
            return { rootName: args.migrationName, files: [] };
          },
          async delete() {
            deleteCount += 1;
            return { kind: 'deleted' as const };
          },
        } as unknown as FsSnapshotManager;

        // ── Fake driver + no-op connection. ───────────────────────────────
        let closeCount = 0;
        const conn: Connection = {
          async transaction<T>(fn: (tx: never) => Promise<T>): Promise<T> {
            // Not exercised on the dry-run path; provide a permissive stub.
            return fn(undefined as never);
          },
          async close(): Promise<void> {
            closeCount += 1;
          },
        };
        const driver: DbDriver = {
          engine: 'postgresql',
          supportsTransactionalDDL: true,
          async connect(): Promise<Connection> {
            return conn;
          },
          redactedTarget(): string {
            return 'localhost:5432';
          },
        };

        const deps: OrchestratorDeps = {
          validator,
          reverseSqlGenerator,
          executor,
          snapshotManager,
          logger,
        };
        const orchestrator = new RollbackOrchestrator(deps);

        const exitCode = await orchestrator.run(args, cfg, driver);

        // Terminates with exit code 0 (R3.4).
        expect(exitCode).toBe(EXIT_SUCCESS);

        // Emits the complete Reverse_SQL verbatim — some captured line equals
        // the exact raw string the generator produced.
        expect(captured).toContain(raw);

        // ZERO changes to the Database or file system: no mutating collaborator
        // ran. `capture` is read-only but still precedes any destructive step,
        // so on the dry-run path it must not be reached either.
        expect(applyReversalCount).toBe(0);
        expect(deleteCount).toBe(0);
        expect(captureCount).toBe(0);

        // The connection is still closed exactly once on the dry-run path.
        expect(closeCount).toBe(1);

        return true;
      }),
      { numRuns: 100 },
    );
  });
});
