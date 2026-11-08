/**
 * Prisma Engine Runner (design.md §"Prisma Engine Runner").
 *
 * Wraps the invocation of the Prisma engine (`prisma migrate diff`) as a child
 * process to produce the reverse-direction SQL that transforms the current
 * Database schema back to the schema state preceding the Target_Migration.
 *
 * Requirement traceability:
 *   - R3.1: invoke the Prisma_Engine as a child process to compute the
 *           Reverse_SQL. The invoked command string is captured for verbose
 *           logging (redacted before display).
 *   - R3.2: on a non-zero child exit, surface the complete stderr output.
 *   - R3.5: apply a 30-second timeout; on timeout, kill the child process and
 *           report the timeout.
 *   - R3.6: when the engine binary cannot be located (ENOENT), report that the
 *           binary was not found.
 *
 * The child-process spawn is injectable via the constructor so unit tests
 * (Task 8.3) and the property test (Task 8.2) can drive the runner
 * deterministically without a real Prisma binary.
 */

import {
  spawn as nodeSpawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process';

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { DbEngine, EngineResult } from '../models/types.js';

/**
 * Default timeout applied to the Prisma engine child process (R3.5).
 * The design specifies a 30-second budget for Reverse_SQL generation.
 */
export const DEFAULT_ENGINE_TIMEOUT_MS = 30_000;

/** The executable invoked when the project has no local Prisma install. */
const PRISMA_COMMAND = 'prisma';

/**
 * Resolve how to launch Prisma: the project's own install
 * (`node_modules/prisma/build/index.js`, run with the current Node — works on
 * every platform), falling back to `prisma` on the PATH.
 */
function resolvePrismaInvocation(projectDir: string): {
  command: string;
  prefixArgs: string[];
} {
  const script = join(projectDir, 'node_modules', 'prisma', 'build', 'index.js');
  if (existsSync(script)) {
    return { command: process.execPath, prefixArgs: [script] };
  }
  return { command: PRISMA_COMMAND, prefixArgs: [] };
}

/**
 * A minimal structural type describing the subset of a spawned child process
 * the runner relies on. It intentionally mirrors the shape of Node's
 * `ChildProcessWithoutNullStreams` so the real `child_process.spawn` satisfies
 * it, while a lightweight fake can be substituted in tests.
 */
export interface SpawnedProcess {
  /** Standard output stream carrying the generated SQL. */
  readonly stdout: NodeJS.EventEmitter;
  /** Standard error stream carrying engine diagnostics. */
  readonly stderr: NodeJS.EventEmitter;
  /** Emits `error` (e.g. ENOENT), `close`, and `exit` events. */
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  /** Terminate the child; used to enforce the timeout (R3.5). */
  kill(signal?: NodeJS.Signals | number): boolean;
}

/**
 * The injectable spawn function signature. Matches `child_process.spawn`'s
 * `(command, args, options)` overload closely enough that the real `spawn` can
 * be passed directly, while remaining trivial to fake in tests.
 */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio
) => SpawnedProcess;

/**
 * The real Node `spawn`, adapted to the injectable {@link SpawnFn} signature.
 * `ChildProcessWithoutNullStreams` is structurally compatible with
 * {@link SpawnedProcess}.
 */
const defaultSpawn: SpawnFn = (command, args, options): SpawnedProcess =>
  nodeSpawn(command, args as string[], options) as ChildProcessWithoutNullStreams;

/** Input to {@link PrismaEngineRunner.runDiff}. */
export interface RunDiffInput {
  /** Live database URL: the current applied state (the "from" side). */
  fromUrl: string;
  /** Migrations directory WITHOUT the Target_Migration (the "to" side). */
  toMigrationsDir: string;
  /** Optional shadow database URL (required by Prisma for PostgreSQL/MySQL). */
  shadowDatabaseUrl?: string;
  /** Resolved database engine. */
  engine: DbEngine;
  /** Timeout budget in milliseconds (30_000 by default, R3.5). */
  timeoutMs: number;
}

/**
 * Runs the Prisma engine (`prisma migrate diff`) as a child process to generate
 * reverse-direction SQL, applying a timeout and normalizing every terminal
 * condition into an {@link EngineResult}.
 */
export class PrismaEngineRunner {
  private readonly spawnFn: SpawnFn;
  private readonly projectDir: string;

  /**
   * @param spawnFn - Optional injectable spawn function. Defaults to the real
   *   `child_process.spawn`; tests supply a deterministic fake.
   * @param projectDir - Project root used to locate the local Prisma install
   *   (defaults to the current working directory).
   */
  constructor(spawnFn: SpawnFn = defaultSpawn, projectDir: string = process.cwd()) {
    this.spawnFn = spawnFn;
    this.projectDir = projectDir;
  }

  /**
   * Invoke `prisma migrate diff` to produce the reverse-direction SQL.
   *
   * The diff is computed from the current applied schema (`fromSchema`) to the
   * schema state preceding the Target_Migration (`toState`), emitting a SQL
   * script on stdout. The child is spawned with the configured timeout; if it
   * does not complete in time it is killed and a `timeout` result is returned.
   *
   * @returns a normalized {@link EngineResult}:
   *   - `{ kind: 'ok', sql, command }` on a zero exit (stdout captured as `sql`,
   *     `command` retained for verbose logging — R3.1).
   *   - `{ kind: 'nonzero', exitCode, stderr }` on a non-zero exit, carrying the
   *     complete stderr (R3.2).
   *   - `{ kind: 'timeout' }` if the child does not complete within `timeoutMs`
   *     (the child is killed — R3.5).
   *   - `{ kind: 'notFound' }` if the engine binary is missing / ENOENT (R3.6).
   */
  runDiff(input: RunDiffInput): Promise<EngineResult> {
    const args = this.buildArgs(input);
    const invocation = resolvePrismaInvocation(this.projectDir);
    const spawnArgs = [...invocation.prefixArgs, ...args];
    const command = this.formatCommand(PRISMA_COMMAND, args);
    const timeoutMs =
      input.timeoutMs > 0 ? input.timeoutMs : DEFAULT_ENGINE_TIMEOUT_MS;

    return new Promise<EngineResult>((resolveResult) => {
      let child: SpawnedProcess;
      try {
        child = this.spawnFn(invocation.command, spawnArgs, {
          shell: false,
          cwd: this.projectDir,
        });
      } catch {
        // A synchronous spawn failure (e.g. ENOENT surfaced synchronously)
        // maps to the binary-not-found outcome (R3.6). Any other synchronous
        // failure is likewise treated as the engine being unavailable.
        resolveResult({ kind: 'notFound' });
        return;
      }

      let settled = false;
      let stdout = '';
      let stderr = '';

      // Guards against emitting more than one terminal EngineResult when
      // multiple events race (e.g. a `close` arriving after the timeout fired).
      const settle = (result: EngineResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolveResult(result);
      };

      const timer = setTimeout(() => {
        // R3.5: the child overran its budget — kill it and report a timeout.
        try {
          child.kill('SIGKILL');
        } catch {
          // Ignore kill failures; the process may already be gone.
        }
        settle({ kind: 'timeout' });
      }, timeoutMs);
      // Do not keep the event loop alive solely for this timer.
      if (typeof (timer as { unref?: () => void }).unref === 'function') {
        (timer as { unref: () => void }).unref();
      }

      child.stdout.on('data', (chunk: unknown) => {
        stdout += this.chunkToString(chunk);
      });
      child.stderr.on('data', (chunk: unknown) => {
        stderr += this.chunkToString(chunk);
      });

      child.on('error', () => {
        // ENOENT on spawn means the Prisma binary was not found (R3.6). Any
        // other spawn-level error also means the engine could not run, so we
        // treat it as not-found for the caller's purposes.
        settle({ kind: 'notFound' });
      });

      child.on('close', (code: unknown) => {
        const exitCode = typeof code === 'number' ? code : 0;
        if (exitCode === 0) {
          // R3.1: success — stdout carries the generated SQL; retain the command
          // string for verbose logging (redacted before display).
          settle({ kind: 'ok', sql: stdout, command });
        } else {
          // R3.2: non-zero exit — surface the complete stderr output.
          settle({ kind: 'nonzero', exitCode, stderr });
        }
      });
    });
  }

  /**
   * Build the argument vector for `prisma migrate diff`.
   *
   * Diffs the live database (`--from-url`) against the migrations directory
   * without the target migration (`--to-migrations`), emitting a plain SQL
   * script on stdout via `--script`.
   */
  private buildArgs(input: RunDiffInput): string[] {
    const args = [
      'migrate',
      'diff',
      '--from-url',
      input.fromUrl,
      '--to-migrations',
      input.toMigrationsDir,
    ];
    if (input.shadowDatabaseUrl !== undefined && input.shadowDatabaseUrl !== '') {
      args.push('--shadow-database-url', input.shadowDatabaseUrl);
    }
    args.push('--script');
    return args;
  }

  /**
   * Produce a human-readable command string for verbose logging (R3.1). The
   * Logger/Redactor is responsible for stripping any credentials before this
   * string is displayed.
   */
  private formatCommand(command: string, args: readonly string[]): string {
    return [command, ...args]
      .map((part) => (/\s/.test(part) ? JSON.stringify(part) : part))
      .join(' ');
  }

  /** Normalize a stream chunk (Buffer or string) to a string. */
  private chunkToString(chunk: unknown): string {
    if (typeof chunk === 'string') {
      return chunk;
    }
    if (chunk instanceof Uint8Array || Buffer.isBuffer(chunk)) {
      return Buffer.from(chunk as Uint8Array).toString('utf8');
    }
    return String(chunk);
  }
}
