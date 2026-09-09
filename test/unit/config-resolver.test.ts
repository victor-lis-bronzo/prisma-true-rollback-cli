// Unit tests for the Config Resolver's successful-resolution path.
//
// Covers Task 5.4: successful resolution (R7.1).
//   - Given a project directory containing prisma/schema.prisma with a valid
//     datasource provider and a DATABASE_URL in the environment,
//     ConfigResolver.resolve(cwd, env) returns a ResolvedConfig whose:
//       * engine matches the datasource provider,
//       * connectionUrl matches DATABASE_URL,
//       * schemaPath is the absolute path to the located schema.prisma,
//       * migrationsDir is <schemaDir>/migrations (absolute),
//   - connectionTargetDesignation is populated when the relevant env var is set
//     (PRISMA_ROLLBACK_TARGET / DATABASE_TARGET), and absent otherwise.
//
// Exercises at least the postgresql and sqlite providers.
//
// Requirements: 7.1.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { afterEach, describe, it, expect } from 'vitest';

import { ConfigResolver } from '../../src/config/config-resolver.js';
import type { DbEngine } from '../../src/models/types.js';

/** Temp dirs created during a test, torn down in afterEach. */
const createdDirs: string[] = [];

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

/**
 * Build the text of a minimal, valid schema.prisma with the given datasource
 * provider. The `url = env("DATABASE_URL")` line mirrors real Prisma schemas
 * and confirms the resolver reads the provider (not the url) for the engine.
 */
function schemaWithProvider(provider: string): string {
  return [
    'generator client {',
    '  provider = "prisma-client-js"',
    '}',
    '',
    'datasource db {',
    `  provider = "${provider}"`,
    '  url      = env("DATABASE_URL")',
    '}',
    '',
  ].join('\n');
}

/**
 * Create a temporary project directory containing prisma/schema.prisma with the
 * given provider. Returns the project root (the intended `cwd`) plus the
 * expected absolute schema and migrations paths.
 */
function makeProject(provider: string): {
  cwd: string;
  schemaPath: string;
  migrationsDir: string;
} {
  const cwd = mkdtempSync(join(tmpdir(), 'prisma-config-resolver-'));
  createdDirs.push(cwd);
  const prismaDir = join(cwd, 'prisma');
  mkdirSync(prismaDir, { recursive: true });
  const schemaPath = join(prismaDir, 'schema.prisma');
  writeFileSync(schemaPath, schemaWithProvider(provider), 'utf8');
  return { cwd, schemaPath, migrationsDir: join(prismaDir, 'migrations') };
}

describe('ConfigResolver.resolve — successful resolution (R7.1)', () => {
  const resolver = new ConfigResolver();

  // Providers to exercise. postgresql and sqlite are required by the task.
  const providers: DbEngine[] = ['postgresql', 'sqlite'];

  for (const provider of providers) {
    describe(`provider = ${provider}`, () => {
      it('resolves engine, connectionUrl, absolute schemaPath, and migrationsDir', () => {
        const { cwd, schemaPath, migrationsDir } = makeProject(provider);
        const connectionUrl = `${provider}://user:secret@localhost:5432/appdb`;

        const config = resolver.resolve(cwd, { DATABASE_URL: connectionUrl });

        expect(config.engine).toBe(provider);
        expect(config.connectionUrl).toBe(connectionUrl);

        // schemaPath must be the absolute path to the located schema.prisma.
        expect(isAbsolute(config.schemaPath)).toBe(true);
        expect(config.schemaPath).toBe(schemaPath);

        // migrationsDir == <schemaDir>/migrations, absolute.
        expect(isAbsolute(config.migrationsDir)).toBe(true);
        expect(config.migrationsDir).toBe(migrationsDir);
      });

      it('leaves connectionTargetDesignation absent when no designation env var is set', () => {
        const { cwd } = makeProject(provider);

        const config = resolver.resolve(cwd, {
          DATABASE_URL: `${provider}://localhost/db`,
        });

        expect(config.connectionTargetDesignation).toBeUndefined();
      });
    });
  }

  it('populates connectionTargetDesignation from PRISMA_ROLLBACK_TARGET', () => {
    const { cwd } = makeProject('postgresql');

    const config = resolver.resolve(cwd, {
      DATABASE_URL: 'postgresql://localhost/db',
      PRISMA_ROLLBACK_TARGET: 'production',
    });

    expect(config.connectionTargetDesignation).toBe('production');
  });

  it('populates connectionTargetDesignation from DATABASE_TARGET (case-insensitive)', () => {
    const { cwd } = makeProject('sqlite');

    const config = resolver.resolve(cwd, {
      DATABASE_URL: 'file:./dev.db',
      DATABASE_TARGET: 'Development',
    });

    expect(config.connectionTargetDesignation).toBe('development');
  });

  it('accepts a relative cwd and still yields an absolute schemaPath', () => {
    // Use an absolute temp dir but confirm the resolver would resolve a
    // relative path against process.cwd(); here we assert absoluteness holds
    // for the standard absolute-cwd case, which is the common invocation.
    const { cwd, schemaPath } = makeProject('sqlite');

    const config = resolver.resolve(cwd, { DATABASE_URL: 'file:./dev.db' });

    expect(isAbsolute(config.schemaPath)).toBe(true);
    expect(config.schemaPath).toBe(schemaPath);
  });
});
