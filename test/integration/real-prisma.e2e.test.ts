// End-to-end test against a REAL Prisma project (SQLite) — no stubs. Guards the
// regressions from issue #6: bin invoked through the node_modules/.bin symlink,
// relative `file:./dev.db` URLs, dry-run without prompting, and a working
// `prisma migrate diff` invocation.

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PRISMA_JS = join(REPO_ROOT, 'node_modules', 'prisma', 'build', 'index.js');
const hasPrisma = existsSync(PRISMA_JS);

const BASE_SCHEMA = `datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}
generator client {
  provider = "prisma-client-js"
}
model User {
  id    Int    @id @default(autoincrement())
  email String @unique
}
`;
const POST_MODEL = `model Post {
  id    Int    @id @default(autoincrement())
  title String
}
`;

let proj: string;
const env = (): NodeJS.ProcessEnv => ({
  ...process.env,
  NODE_ENV: 'development',
  DATABASE_URL: 'file:./dev.db', // relative on purpose (issue #6, item 2)
});

function prisma(args: string[]): void {
  const r = spawnSync(process.execPath, [PRISMA_JS, ...args], {
    cwd: proj,
    env: env(),
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    throw new Error(`prisma ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
  }
}

/** Run the CLI through the node_modules/.bin symlink with closed stdin. */
function cli(args: string[]) {
  const bin = join(proj, 'node_modules', '.bin', 'prisma-true-rollback');
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: proj,
    env: env(),
    input: '',
    encoding: 'utf8',
    timeout: 60_000,
  });
}

function tables(): string[] {
  const db = new Database(join(proj, 'prisma', 'dev.db'), { readonly: true });
  try {
    return (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
  } finally {
    db.close();
  }
}

describe.skipIf(!hasPrisma)('real Prisma project (SQLite)', () => {
  beforeAll(() => {
    const build = spawnSync('npm', ['run', 'build'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
    if (build.status !== 0) throw new Error(`build failed:\n${build.stdout}${build.stderr}`);

    proj = mkdtempSync(join(tmpdir(), 'ptr-real-'));
    mkdirSync(join(proj, 'prisma'));
    mkdirSync(join(proj, 'node_modules', '.bin'), { recursive: true });
    for (const dep of ['prisma', '@prisma']) {
      symlinkSync(join(REPO_ROOT, 'node_modules', dep), join(proj, 'node_modules', dep), 'junction');
    }
    symlinkSync(
      join(REPO_ROOT, 'dist', 'cli.js'),
      join(proj, 'node_modules', '.bin', 'prisma-true-rollback'),
    );

    const schema = join(proj, 'prisma', 'schema.prisma');
    writeFileSync(schema, BASE_SCHEMA);
    prisma(['migrate', 'dev', '--name', 'init', '--skip-generate']);
    writeFileSync(schema, BASE_SCHEMA + POST_MODEL);
    prisma(['migrate', 'dev', '--name', 'add_post', '--skip-generate']);
  }, 180_000);

  afterAll(() => {
    if (proj) rmSync(proj, { recursive: true, force: true });
  });

  const latest = (): string =>
    // migration dirs are timestamp-prefixed; the add_post one is the latest.
    readdirSync(join(proj, 'prisma', 'migrations')).filter((n) =>
      n.endsWith('_add_post'),
    )[0] as string;

  it('--dry-run (no --yes, stdin closed) prints the reverse SQL and changes nothing', () => {
    const r = cli([latest(), '--dry-run']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout + r.stderr).toContain('DROP TABLE "Post"');
    expect(tables()).toContain('Post');
    expect(existsSync(join(proj, 'prisma', 'migrations', latest()))).toBe(true);
  }, 90_000);

  it('--yes rolls back the migration: table, tracking row and folder are gone', () => {
    const name = latest();
    const r = cli([name, '--yes']);
    expect(r.status, r.stdout + r.stderr).toBe(0);

    expect(tables()).not.toContain('Post');
    expect(existsSync(join(proj, 'prisma', 'migrations', name))).toBe(false);
    expect(existsSync(join(proj, 'dev.db'))).toBe(false); // no stray database

    const db = new Database(join(proj, 'prisma', 'dev.db'), { readonly: true });
    const names = (
      db.prepare('SELECT migration_name FROM _prisma_migrations').all() as {
        migration_name: string;
      }[]
    ).map((x) => x.migration_name);
    db.close();
    expect(names).toHaveLength(1);
    expect(names[0]).not.toBe(name);
  }, 90_000);
});
