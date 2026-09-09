// Unit tests for the Prisma Engine Runner (PrismaEngineRunner.runDiff).
//
// Covers Task 8.3: the timeout and binary-not-found terminal conditions, plus a
// success baseline, driven through the injectable SpawnFn so no real Prisma
// binary or child process is touched. All tests are deterministic and fast:
// the timeout case uses a tiny timeoutMs (and a fake process that never closes),
// so the suite never hangs.
//
//   - Timeout (R3.5): a fake process that never emits 'close' with a small
//     timeoutMs resolves to { kind: 'timeout' } and the fake's kill() is called.
//   - Binary not found (R3.6): a spawn that throws synchronously, or a child
//     that emits an ENOENT 'error' event, resolves to { kind: 'notFound' }.
//   - Success (R3.1): a fake process that emits stdout then closes with code 0
//     resolves to { kind: 'ok', sql, command } with sql === emitted stdout.
//
// Requirements: 3.5, 3.6 (with a 3.1 success baseline).

import { EventEmitter } from 'node:events';

import { describe, it, expect } from 'vitest';

import {
  PrismaEngineRunner,
  type SpawnFn,
  type SpawnedProcess,
  type RunDiffInput,
} from '../../src/engine/prisma-engine-runner.js';

/**
 * A controllable fake spawned process implementing the structural
 * {@link SpawnedProcess} surface the runner relies on. Tests drive it by
 * emitting on `stdout`/`stderr` and firing `error`/`close` on the process
 * itself, and assert on whether `kill()` was invoked.
 */
class FakeSpawnedProcess extends EventEmitter implements SpawnedProcess {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  killed = false;
  killSignal: NodeJS.Signals | number | undefined;

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    this.killSignal = signal;
    return true;
  }
}

/** A representative, valid runDiff input; `timeoutMs` is overridden per test. */
function makeInput(overrides: Partial<RunDiffInput> = {}): RunDiffInput {
  return {
    fromSchema: 'from-schema-datamodel',
    toState: 'to-schema-datamodel',
    engine: 'postgresql',
    timeoutMs: 30_000,
    ...overrides,
  };
}

describe('PrismaEngineRunner.runDiff', () => {
  describe('timeout — R3.5', () => {
    it('resolves to { kind: "timeout" } and kills the child when it never closes', async () => {
      const fake = new FakeSpawnedProcess();
      // Spawn succeeds, but the fake never emits data/close/error, so the only
      // path to resolution is the timeout timer.
      const spawnFn: SpawnFn = () => fake;
      const runner = new PrismaEngineRunner(spawnFn);

      // A tiny timeout keeps the test fast and deterministic without hanging.
      const result = await runner.runDiff(makeInput({ timeoutMs: 5 }));

      expect(result).toEqual({ kind: 'timeout' });
      // R3.5: the overrunning child must be terminated.
      expect(fake.killed).toBe(true);
      expect(fake.killSignal).toBe('SIGKILL');
    });

    it('ignores a late close arriving after the timeout already fired', async () => {
      const fake = new FakeSpawnedProcess();
      const spawnFn: SpawnFn = () => fake;
      const runner = new PrismaEngineRunner(spawnFn);

      const result = await runner.runDiff(makeInput({ timeoutMs: 5 }));

      expect(result).toEqual({ kind: 'timeout' });

      // A close racing in after the timer settled must not change the outcome
      // (the promise has already resolved). This should not throw.
      expect(() => fake.emit('close', 0)).not.toThrow();
      expect(result).toEqual({ kind: 'timeout' });
    });
  });

  describe('binary not found — R3.6', () => {
    it('resolves to { kind: "notFound" } when spawn throws synchronously', async () => {
      const spawnFn: SpawnFn = () => {
        const enoent = new Error('spawn prisma ENOENT') as NodeJS.ErrnoException;
        enoent.code = 'ENOENT';
        throw enoent;
      };
      const runner = new PrismaEngineRunner(spawnFn);

      const result = await runner.runDiff(makeInput());

      expect(result).toEqual({ kind: 'notFound' });
    });

    it('resolves to { kind: "notFound" } when the child emits an ENOENT error event', async () => {
      const fake = new FakeSpawnedProcess();
      const spawnFn: SpawnFn = () => fake;
      const runner = new PrismaEngineRunner(spawnFn);

      const pending = runner.runDiff(makeInput());

      // Simulate the asynchronous ENOENT surfaced by child_process.spawn.
      const enoent = new Error('spawn prisma ENOENT') as NodeJS.ErrnoException;
      enoent.code = 'ENOENT';
      fake.emit('error', enoent);

      await expect(pending).resolves.toEqual({ kind: 'notFound' });
    });
  });

  describe('success — R3.1', () => {
    it('resolves to { kind: "ok", sql, command } with sql equal to emitted stdout', async () => {
      const fake = new FakeSpawnedProcess();
      const spawnFn: SpawnFn = () => fake;
      const runner = new PrismaEngineRunner(spawnFn);

      const pending = runner.runDiff(makeInput());

      const emittedSql =
        '-- reverse migration\nDROP TABLE "User";\nALTER TABLE "Post" DROP COLUMN "authorId";\n';
      // Emit stdout in chunks to exercise accumulation, then close with 0.
      fake.stdout.emit('data', '-- reverse migration\n');
      fake.stdout.emit('data', 'DROP TABLE "User";\n');
      fake.stdout.emit('data', 'ALTER TABLE "Post" DROP COLUMN "authorId";\n');
      fake.emit('close', 0);

      const result = await pending;

      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        // R3.1: stdout is captured verbatim as the generated SQL.
        expect(result.sql).toBe(emittedSql);
        // The invoked command string is retained for verbose logging.
        expect(result.command).toContain('prisma');
        expect(result.command).toContain('migrate diff');
      }
      // A successful run must not kill the child.
      expect(fake.killed).toBe(false);
    });

    it('captures Buffer stdout chunks as a UTF-8 string', async () => {
      const fake = new FakeSpawnedProcess();
      const spawnFn: SpawnFn = () => fake;
      const runner = new PrismaEngineRunner(spawnFn);

      const pending = runner.runDiff(makeInput());

      fake.stdout.emit('data', Buffer.from('SELECT 1;\n', 'utf8'));
      fake.emit('close', 0);

      const result = await pending;

      expect(result).toEqual({
        kind: 'ok',
        sql: 'SELECT 1;\n',
        command: expect.stringContaining('prisma'),
      });
    });
  });
});
