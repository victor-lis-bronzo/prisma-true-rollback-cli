// End-to-end integration test for the npx entrypoint (Task 15.2).
//
// This is a *true* end-to-end test: it builds the project and then drives the
// compiled binary (`node dist/index.js ...`) as a real child process, asserting
// the process exit code and stdout/stderr for representative flows. It is NOT a
// property test — it exercises 1–4 concrete, representative scenarios.
//
// Every scenario covered here is a non-destructive path (a terminal action or a
// pre-operation failure that returns before any driver is created or connection
// opened), so no database or filesystem changes can occur. The missing-config
// scenario is additionally run inside a throwaway temp directory whose contents
// are captured before and after the invocation and asserted unchanged, proving
// the "no FS changes on non-destructive paths" guarantee concretely.
//
// Coverage:
//   - `--version`            → prints a version string, exit 0            (R1.7)
//   - no args                → missing-arg error on stderr, exit 1        (R1.2)
//   - two positional names   → only-one-name error on stderr, exit 1      (R1.3)
//   - valid name, no config  → config error on stderr, exit 1, no changes (R7.2)
//
// Build requirement: a `beforeAll` runs `npm run build` so `dist/index.js` is
// up to date before any scenario runs. `npm run build && npm test` also builds
// first, but the in-test build keeps this file self-contained and robust.
//
// Requirements: 1.7, 1.2, 1.3, 7.2.

import { execFile } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

// Repo root is two levels up from this file (test/integration/ → repo root).
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const CLI_ENTRY = join(REPO_ROOT, 'dist', 'index.js');
const PKG_VERSION = (
  JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    version: string;
  }
).version;

// Generous, bounded timeouts: building TypeScript can take a while on cold
// caches, whereas each CLI invocation is a fast, non-destructive path.
const BUILD_TIMEOUT_MS = 120_000;
const CLI_TIMEOUT_MS = 20_000;

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the compiled CLI as a real child process and normalize the result so a
 * non-zero exit is captured (rather than rejected) alongside its output.
 */
async function runCli(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [CLI_ENTRY, ...args],
      {
        cwd: options.cwd ?? REPO_ROOT,
        env: options.env ?? process.env,
        timeout: CLI_TIMEOUT_MS,
        encoding: 'utf8',
      },
    );
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
      killed?: boolean;
      signal?: string;
    };
    if (e.killed || typeof e.code !== 'number') {
      // A timeout/signal kill is a genuine test failure, not a CLI exit code.
      throw err;
    }
    return {
      code: e.code,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
    };
  }
}

/** Sorted list of directory entry names, for before/after comparison. */
function listDir(dir: string): string[] {
  return readdirSync(dir).sort();
}

describe('npx entrypoint — end-to-end (Task 15.2)', () => {
  const tempDirs: string[] = [];

  beforeAll(async () => {
    // Ensure dist/index.js reflects the current source before driving it.
    await execFileAsync('npm', ['run', 'build'], {
      cwd: REPO_ROOT,
      timeout: BUILD_TIMEOUT_MS,
      encoding: 'utf8',
    });
  }, BUILD_TIMEOUT_MS + 10_000);

  afterAll(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir !== undefined) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('`--version` prints a version string and exits 0 (R1.7)', async () => {
    const { code, stdout, stderr } = await runCli(['--version']);

    expect(code).toBe(0);
    // Prints the packaged version, and it looks like a semantic version.
    expect(stdout.trim()).toBe(PKG_VERSION);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    expect(stderr).toBe('');
  });

  it('no arguments reports a missing-arg error on stderr and exits 1 (R1.2)', async () => {
    const { code, stdout, stderr } = await runCli([]);

    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr.toLowerCase()).toContain('missing');
    expect(stderr.toLowerCase()).toContain('migration');
  });

  it('two migration names report an only-one-name error on stderr and exits 1 (R1.3)', async () => {
    const { code, stdout, stderr } = await runCli(['first_migration', 'second_migration']);

    expect(code).toBe(1);
    expect(stdout).toBe('');
    // Message identifies that only a single migration name is accepted.
    expect(stderr.toLowerCase()).toContain('one migration name');
  });

  it('a valid name with no resolvable config fails (exit 1) without touching the filesystem (R7.2)', async () => {
    // Run inside an empty throwaway directory: there is no schema.prisma, so the
    // ConfigResolver fails before any driver is created or connection opened —
    // a non-destructive path. We snapshot the directory before/after to prove no
    // filesystem changes occur.
    const cwd = mkdtempSync(join(tmpdir(), 'prisma-e2e-noconfig-'));
    tempDirs.push(cwd);

    const before = listDir(cwd);
    expect(before).toEqual([]);

    const { code, stdout, stderr } = await runCli(['some_migration'], {
      cwd,
      env: { ...process.env, DATABASE_URL: '' },
    });

    expect(code).toBe(1);
    expect(stdout).toBe('');
    // Identifies the missing configuration source (schema.prisma).
    expect(stderr).toContain('schema.prisma');

    // No filesystem changes on this non-destructive path.
    expect(listDir(cwd)).toEqual(before);
  });
});
