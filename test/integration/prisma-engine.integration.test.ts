// Integration test for the Prisma Engine Runner (Task 8.4).
//
// The real Prisma CLI is not (and need not be) installed here: the task
// explicitly permits "the real engine (or a stub binary)". This suite uses a
// *stub binary* so it remains a genuine child-process integration test — a real
// process is spawned via node:child_process.spawn and the runner's
// stdout/stderr/close/error plumbing is exercised end-to-end — without any
// dependency on Prisma.
//
// How it stays "real":
//   - We write small executable Node scripts (with a shebang, chmod +x) to a
//     temp dir. One prints a fixed SQL string to stdout and exits 0; another
//     prints diagnostics to stderr and exits non-zero.
//   - We inject a SpawnFn that uses the *real* child_process.spawn to run the
//     stub (`node <stub>`). It is NOT a fake EventEmitter — the runner drives an
//     actual OS process and observes actual stdout/stderr/close events. The
//     injected SpawnFn also records the (command, args) the runner asked for so
//     we can assert the invoked command string is captured.
//   - For the not-found case we spawn a non-existent path with the real spawn,
//     producing a genuine ENOENT 'error' event.
//
// This is NOT a property test — it exercises 1–4 concrete, representative
// scenarios. Requirements: 3.1 (with 3.2 / 3.6 boundaries surfaced by the run).

import {
  spawn as nodeSpawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  PrismaEngineRunner,
  type RunDiffInput,
  type SpawnFn,
  type SpawnedProcess,
} from '../../src/engine/prisma-engine-runner.js';

// The SQL the "success" stub prints verbatim to stdout. The runner must capture
// this exactly as the generated reverse SQL.
const STUB_SQL =
  '-- reverse migration (stub)\nDROP TABLE "User";\nALTER TABLE "Post" DROP COLUMN "authorId";\n';

// The diagnostics the "failure" stub prints to stderr before exiting non-zero.
const STUB_STDERR = 'Error: P3006 stub engine failure\nmigration could not be diffed\n';
const STUB_EXIT_CODE = 3;

let tempDir: string;
let successStub: string;
let failureStub: string;

/**
 * A SpawnFn that ignores the runner's fixed `prisma` command/args and instead
 * spawns the provided stub script with the *real* child_process.spawn, so a real
 * OS process is created and its real stdout/stderr/close events flow back into
 * the runner. The (command, args) the runner requested are recorded for
 * assertions.
 */
function makeStubSpawn(nodeArgs: string[]): SpawnFn & {
  invokedCommand?: string;
  invokedArgs?: readonly string[];
} {
  const spawnFn = ((
    command: string,
    args: readonly string[],
    options: SpawnOptionsWithoutStdio,
  ): SpawnedProcess => {
    // Record what the runner asked for (so the invoked command string / args
    // are observable), then run the stub via the real spawn instead.
    spawnFn.invokedCommand = command;
    spawnFn.invokedArgs = args;
    return nodeSpawn(process.execPath, nodeArgs, {
      ...options,
      shell: false,
    }) as ChildProcessWithoutNullStreams;
  }) as SpawnFn & { invokedCommand?: string; invokedArgs?: readonly string[] };
  return spawnFn;
}

/** A representative, valid runDiff input; timeout is generous for a real spawn. */
function makeInput(overrides: Partial<RunDiffInput> = {}): RunDiffInput {
  return {
    fromSchema: 'from-schema-datamodel',
    toState: 'to-schema-datamodel',
    engine: 'postgresql',
    timeoutMs: 15_000,
    ...overrides,
  };
}

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'prisma-engine-int-'));

  // Success stub: print the fixed SQL to stdout and exit 0.
  successStub = join(tempDir, 'stub-prisma-success.mjs');
  writeFileSync(
    successStub,
    `#!/usr/bin/env node\n` +
      `process.stdout.write(${JSON.stringify(STUB_SQL)});\n` +
      `process.exit(0);\n`,
    'utf8',
  );
  chmodSync(successStub, 0o755);

  // Failure stub: print diagnostics to stderr and exit non-zero.
  failureStub = join(tempDir, 'stub-prisma-failure.mjs');
  writeFileSync(
    failureStub,
    `#!/usr/bin/env node\n` +
      `process.stderr.write(${JSON.stringify(STUB_STDERR)});\n` +
      `process.exit(${STUB_EXIT_CODE});\n`,
    'utf8',
  );
  chmodSync(failureStub, 0o755);
});

afterAll(() => {
  if (tempDir !== undefined) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe('PrismaEngineRunner.runDiff — real child process against a stub binary (Task 8.4)', () => {
  it('success stub → { kind: "ok", sql, command } with sql equal to the stub stdout (R3.1)', async () => {
    const spawnFn = makeStubSpawn([successStub]);
    const runner = new PrismaEngineRunner(spawnFn);

    const result = await runner.runDiff(makeInput());

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      // stdout of the real child process is captured verbatim as the SQL.
      expect(result.sql).toBe(STUB_SQL);
      // The invoked command string is captured for verbose logging.
      expect(result.command).toContain('prisma');
      expect(result.command).toContain('migrate diff');
    }

    // The runner asked to invoke the `prisma migrate diff` command with the
    // expected argument vector (even though we redirected the real spawn to the
    // stub). This proves the command/args plumbing is exercised end-to-end.
    expect(spawnFn.invokedCommand).toBe('prisma');
    expect(spawnFn.invokedArgs).toEqual([
      'migrate',
      'diff',
      '--from-schema-datamodel',
      'from-schema-datamodel',
      '--to-schema-datamodel',
      'to-schema-datamodel',
      '--script',
    ]);
  });

  it('failure stub → { kind: "nonzero", exitCode, stderr } carrying the stub stderr (R3.2)', async () => {
    const spawnFn = makeStubSpawn([failureStub]);
    const runner = new PrismaEngineRunner(spawnFn);

    const result = await runner.runDiff(makeInput());

    expect(result.kind).toBe('nonzero');
    if (result.kind === 'nonzero') {
      // The real child's non-zero exit code is surfaced.
      expect(result.exitCode).toBe(STUB_EXIT_CODE);
      // The complete stderr output of the real child is surfaced (R3.2).
      expect(result.stderr).toBe(STUB_STDERR);
    }
  });

  it('non-existent binary path → { kind: "notFound" } from a real ENOENT (R3.6)', async () => {
    // Spawn a path that does not exist using the real spawn, producing a genuine
    // asynchronous ENOENT 'error' event that the runner maps to notFound.
    const missing = join(tempDir, 'definitely-not-a-real-binary-xyz');
    const spawnFn: SpawnFn = (_command, _args, options) =>
      nodeSpawn(missing, [], {
        ...options,
        shell: false,
      }) as ChildProcessWithoutNullStreams;
    const runner = new PrismaEngineRunner(spawnFn);

    const result = await runner.runDiff(makeInput());

    expect(result).toEqual({ kind: 'notFound' });
  });
});
