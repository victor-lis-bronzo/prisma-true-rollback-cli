// Feature: prisma-true-rollback-cli, Property 10: Engine failure output is surfaced
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import fc from 'fast-check';

import {
  PrismaEngineRunner,
  type SpawnFn,
  type SpawnedProcess,
} from '../../src/engine/prisma-engine-runner.js';
import type { DbEngine } from '../../src/models/types.js';

/**
 * Property 10: Engine failure output is surfaced.
 *
 * For any non-zero exit of the Prisma_Engine child process with arbitrary error
 * output, `PrismaEngineRunner.runDiff` SHALL resolve to a failure result
 * (`{ kind: 'nonzero', exitCode, stderr }`) that carries the exact, complete
 * engine stderr output and the exact non-zero exit code — so the caller can
 * abort with a non-zero exit and surface the full engine diagnostics (R3.2).
 *
 * The child process is driven deterministically through the injectable
 * {@link SpawnFn}: a fake {@link SpawnedProcess} built from real EventEmitters
 * emits the arbitrary stderr text on its `stderr` stream, then emits `close`
 * with the arbitrary non-zero exit code. Emission is deferred so the runner has
 * registered its `data`/`close` listeners before any event fires.
 *
 * Validates: Requirements 3.2
 */
describe('Property 10: Engine failure output is surfaced', () => {
  /**
   * Build a fake SpawnedProcess that emits `stderr` in one or more chunks and
   * then closes with `exitCode`. `stdout`/`stderr` are real EventEmitters;
   * `on` delegates to an internal emitter for `close`/`error`; `kill` is a
   * no-op recorded for completeness.
   */
  function makeFakeSpawn(stderrText: string, exitCode: number): SpawnFn {
    return (): SpawnedProcess => {
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      const control = new EventEmitter();

      const proc: SpawnedProcess = {
        stdout,
        stderr,
        on(event: string, listener: (...args: unknown[]) => void): unknown {
          control.on(event, listener);
          return proc;
        },
        kill(): boolean {
          return true;
        },
      };

      // Defer emission until after runDiff attaches its listeners. Emit the
      // full stderr text (as a Buffer, mirroring a real child stream), then
      // close with the non-zero exit code.
      setImmediate(() => {
        if (stderrText.length > 0) {
          stderr.emit('data', Buffer.from(stderrText, 'utf8'));
        }
        control.emit('close', exitCode);
      });

      return proc;
    };
  }

  it('resolves to { kind: "nonzero", exitCode, stderr } carrying the complete engine stderr', async () => {
    const engineArb = fc.constantFrom<DbEngine>('postgresql', 'mysql', 'sqlite');

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 255 }), // arbitrary non-zero exit code
        fc.string(), // arbitrary engine stderr text
        fc.string(),
        fc.string(),
        engineArb,
        async (exitCode, stderrText, fromSchema, toState, engine) => {
          const runner = new PrismaEngineRunner(makeFakeSpawn(stderrText, exitCode));

          const result = await runner.runDiff({
            fromSchema,
            toState,
            engine,
            timeoutMs: 30_000,
          });

          // Failure is surfaced as a non-zero result (not ok/timeout/notFound).
          expect(result.kind).toBe('nonzero');
          if (result.kind !== 'nonzero') {
            return false;
          }

          // The exact non-zero exit code is preserved.
          expect(result.exitCode).toBe(exitCode);

          // The complete, exact engine stderr output is carried through.
          expect(result.stderr).toBe(stderrText);

          return true;
        },
      ),
      { numRuns: 100 },
    );
  });
});
