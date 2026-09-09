// Feature: prisma-true-rollback-cli, Property 14: Unsupported engines are rejected
import { afterEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigResolver } from '../../src/config/config-resolver.js';
import { SUPPORTED_ENGINES, UnsupportedEngineError } from '../../src/models/errors.js';

/**
 * Property 14: Unsupported engines are rejected.
 *
 * For any resolved datasource provider that is NOT one of
 * {postgresql, mysql, sqlite}, `ConfigResolver.resolve` SHALL throw an
 * `UnsupportedEngineError` (exit-code-1 semantics) with a message that names
 * the offending engine and lists the supported engines.
 *
 * Strategy: generate an arbitrary provider string, place it in a real
 * `prisma/schema.prisma` inside a temp directory, supply a valid DATABASE_URL,
 * and assert that resolution rejects unsupported providers while accepting
 * supported ones (sanity check).
 *
 * **Validates: Requirements 7.5**
 */
describe('Property 14: Unsupported engines are rejected', () => {
  const supportedSet = new Set<string>(SUPPORTED_ENGINES);
  const createdDirs: string[] = [];

  /** Create an isolated temp project dir containing prisma/schema.prisma. */
  function makeProject(provider: string): string {
    const root = mkdtempSync(join(tmpdir(), 'ptr-cfg-'));
    createdDirs.push(root);
    const prismaDir = join(root, 'prisma');
    mkdirSync(prismaDir, { recursive: true });
    const schema = [
      'datasource db {',
      `  provider = "${provider}"`,
      '  url      = env("DATABASE_URL")',
      '}',
      '',
      'generator client {',
      '  provider = "prisma-client-js"',
      '}',
      '',
    ].join('\n');
    writeFileSync(join(prismaDir, 'schema.prisma'), schema, 'utf8');
    return root;
  }

  afterEach(() => {
    while (createdDirs.length > 0) {
      const dir = createdDirs.pop();
      if (dir !== undefined) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('throws UnsupportedEngineError naming the engine and listing supported engines', () => {
    fc.assert(
      fc.property(
        // Arbitrary provider identifiers that are NOT supported engines.
        fc
          .string({ minLength: 1, maxLength: 40 })
          // Restrict to a Prisma-provider-like charset (no quotes/newlines that
          // would break the schema block); still covers a huge unsupported space.
          .map((s) => s.replace(/["'\r\n{}]/g, ''))
          .filter((s) => s.trim().length > 0 && !supportedSet.has(s.trim())),
        (provider) => {
          const root = makeProject(provider);
          const resolver = new ConfigResolver();

          let thrown: unknown;
          try {
            resolver.resolve(root, { DATABASE_URL: 'postgresql://user:pass@localhost:5432/db' });
          } catch (err) {
            thrown = err;
          }

          // Must reject with the typed error (exit-code-1 semantics).
          expect(thrown).toBeInstanceOf(UnsupportedEngineError);
          const error = thrown as UnsupportedEngineError;

          // The parsed provider is what the resolver saw and rejected.
          expect(error.engine).toBe(provider.trim());

          // Message names the offending engine...
          expect(error.message).toContain(provider.trim());
          // ...and lists every supported engine.
          for (const supported of SUPPORTED_ENGINES) {
            expect(error.message).toContain(supported);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('does NOT throw UnsupportedEngineError for supported providers (sanity)', () => {
    fc.assert(
      fc.property(fc.constantFrom(...SUPPORTED_ENGINES), (provider) => {
        const root = makeProject(provider);
        const resolver = new ConfigResolver();

        const config = resolver.resolve(root, {
          DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
        });

        // Supported providers resolve cleanly to their engine.
        expect(config.engine).toBe(provider);
      }),
      { numRuns: 100 },
    );
  });
});
