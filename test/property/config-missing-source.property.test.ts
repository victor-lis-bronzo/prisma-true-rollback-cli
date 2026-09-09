// Feature: prisma-true-rollback-cli, Property 15: Missing configuration sources are identified
import { afterAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigResolver } from '../../src/config/config-resolver.js';
import { ConfigError } from '../../src/models/errors.js';

/**
 * Property 15: Missing configuration sources are identified.
 *
 * For any configuration in which the schema.prisma file cannot be located, or
 * the DATABASE_URL environment variable is unset or empty (including
 * whitespace-only), the CLI SHALL terminate with exit code 1 (ConfigError,
 * exit-code-1 semantics) and produce a message that identifies the specific
 * missing configuration source.
 *
 * Strategy:
 *   - Each iteration provisions a fresh temp directory. It EITHER omits
 *     `prisma/schema.prisma` (schema missing) OR writes a valid schema and then
 *     supplies an unset / empty / whitespace-only DATABASE_URL. Both branches
 *     MUST raise a `ConfigError` whose `missingSource` names the correct source.
 *   - When the schema is missing, that failure is detected first (the resolver
 *     locates the schema before consulting DATABASE_URL), so we hold
 *     DATABASE_URL valid in that branch to prove the schema is what is reported.
 *
 * Temp directories are tracked and removed in `afterAll` so no state leaks.
 *
 * **Validates: Requirements 7.2**
 */
describe('Property 15: Missing configuration sources are identified', () => {
  const resolver = new ConfigResolver();
  const createdDirs: string[] = [];

  /** Create a fresh, tracked temp directory. */
  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'prtr-config-'));
    createdDirs.push(dir);
    return dir;
  }

  /** Write a minimal, valid schema.prisma with a supported provider. */
  function writeValidSchema(dir: string): void {
    const prismaDir = join(dir, 'prisma');
    // mkdtempSync gave us `dir`; create the nested prisma/ folder.
    mkdirSync(prismaDir, { recursive: true });
    writeFileSync(
      join(prismaDir, 'schema.prisma'),
      'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n',
      'utf8',
    );
  }

  afterAll(() => {
    for (const dir of createdDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports schema.prisma as the missing source when the schema is absent', () => {
    fc.assert(
      fc.property(
        // A valid DATABASE_URL so the schema is unambiguously the missing source.
        fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0),
        (databaseUrl) => {
          const dir = makeTempDir(); // no schema.prisma written
          const env: NodeJS.ProcessEnv = { DATABASE_URL: databaseUrl };

          let thrown: unknown;
          try {
            resolver.resolve(dir, env);
          } catch (err) {
            thrown = err;
          }

          expect(thrown).toBeInstanceOf(ConfigError);
          expect((thrown as ConfigError).missingSource).toBe('schema.prisma');
          // The message must identify the specific missing source.
          expect((thrown as ConfigError).message).toContain('schema.prisma');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('reports DATABASE_URL as the missing source when it is unset/empty/whitespace-only', () => {
    // Generators for values that must all be treated as "missing":
    //  - undefined (env var entirely absent)
    //  - empty string
    //  - whitespace-only strings (spaces, tabs, newlines, mixed)
    const whitespaceOnly = fc
      .stringOf(fc.constantFrom(' ', '\t', '\n', '\r', '\v', '\f'), { minLength: 1, maxLength: 8 });
    const missingUrlArb = fc.oneof(
      fc.constant(undefined),
      fc.constant(''),
      whitespaceOnly,
    );

    fc.assert(
      fc.property(missingUrlArb, (databaseUrl) => {
        const dir = makeTempDir();
        writeValidSchema(dir); // schema present so DATABASE_URL is the only fault

        const env: NodeJS.ProcessEnv = {};
        if (databaseUrl !== undefined) {
          env.DATABASE_URL = databaseUrl;
        }

        let thrown: unknown;
        try {
          resolver.resolve(dir, env);
        } catch (err) {
          thrown = err;
        }

        expect(thrown).toBeInstanceOf(ConfigError);
        expect((thrown as ConfigError).missingSource).toBe('DATABASE_URL');
        expect((thrown as ConfigError).message).toContain('DATABASE_URL');
      }),
      { numRuns: 100 },
    );
  });
});
