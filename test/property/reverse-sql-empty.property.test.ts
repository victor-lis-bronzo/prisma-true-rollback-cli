// Feature: prisma-true-rollback-cli, Property 8: Empty reverse-SQL detection
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { ReverseSqlGenerator } from '../../src/reverse-sql/reverse-sql-generator.js';
import { PrismaEngineRunner } from '../../src/engine/prisma-engine-runner.js';
import { ReverseSqlError } from '../../src/models/errors.js';
import type {
  EngineResult,
  ResolvedConfig,
  TargetMigration,
} from '../../src/models/types.js';

/**
 * Property 8: Empty reverse-SQL detection.
 *
 * For any generated reverse-SQL script consisting solely of whitespace and SQL
 * comments (interleaved `--` line comments and `/* ... *\/` block comments),
 * `isEffectivelyEmpty` SHALL return true, and — when such a script is what the
 * engine returns — `generate` SHALL reject it with a `ReverseSqlError`
 * (non-zero-exit semantics, R3.3).
 *
 * Conversely, for any script that contains at least one executable statement
 * (a non-comment token embedded among comments/whitespace), `isEffectivelyEmpty`
 * SHALL return false, and `generate` SHALL succeed, returning a `ReverseSql`
 * whose `statements` array is non-empty.
 *
 * Strategy: build two fast-check generators — one that composes comment-only
 * scripts from whitespace + line/block comments, and one that additionally
 * embeds at least one genuine executable statement. A fake `PrismaEngineRunner`
 * whose `runDiff` resolves `{ kind: 'ok', sql, command }` with the generated
 * script is injected so no real Prisma binary is spawned.
 *
 * Validates: Requirements 3.3
 */
describe('Property 8: Empty reverse-SQL detection', () => {
  const cfg: ResolvedConfig = {
    engine: 'postgresql',
    connectionUrl: 'postgresql://user:pass@localhost:5432/db',
    migrationsDir: '/tmp/migrations',
    schemaPath: '/tmp/schema.prisma',
  };
  const target: TargetMigration = {
    name: '20240101000000_init',
    folderPath: '/tmp/migrations/20240101000000_init',
  };

  /**
   * A fake PrismaEngineRunner that always resolves `runDiff` with an `ok`
   * result carrying the supplied script. Structurally substitutes for the real
   * runner (the generator only calls `runDiff`).
   */
  function fakeRunner(sql: string): PrismaEngineRunner {
    const runner = {
      runDiff(): Promise<EngineResult> {
        return Promise.resolve({
          kind: 'ok',
          sql,
          command: 'prisma migrate diff --script',
        });
      },
    };
    return runner as unknown as PrismaEngineRunner;
  }

  // ---------------------------------------------------------------------------
  // Generators
  // ---------------------------------------------------------------------------

  /** Whitespace runs (spaces, tabs, newlines, CRs) — never executable. */
  const whitespace = fc
    .array(fc.constantFrom(' ', '\t', '\n', '\r\n', '  ', '\n\n'), {
      maxLength: 4,
    })
    .map((parts) => parts.join(''));

  /**
   * A `--` line comment: body has no newline (so the comment ends at the line),
   * followed by a newline to terminate it.
   */
  const lineComment = fc
    .string()
    .map((s) => s.replace(/[\r\n]/g, ' '))
    .map((body) => `--${body}\n`);

  /**
   * A `/* ... *\/` block comment: body must not contain the closing `*\/`
   * sequence (otherwise the comment would end early and the remainder could be
   * executable content).
   */
  const blockComment = fc
    .string()
    .map((body) => body.replace(/\*\//g, '* /'))
    .map((body) => `/*${body}*/`);

  /** A single comment-or-whitespace fragment (all non-executable). */
  const commentOrWhitespace = fc.oneof(whitespace, lineComment, blockComment);

  /**
   * Comment-only script: an interleaving of whitespace and SQL comments with a
   * guaranteed leading whitespace chunk so nothing is accidentally executable.
   * Contains zero executable statements by construction.
   */
  const commentOnlyScript = fc
    .array(commentOrWhitespace, { minLength: 0, maxLength: 8 })
    .chain((fragments) =>
      whitespace.map((lead) => lead + fragments.join('')),
    );

  /**
   * A genuine executable statement token: a non-empty run of characters that
   * are NOT comment/whitespace/quote/semicolon starters, so after comment- and
   * whitespace-stripping at least one non-empty statement survives.
   */
  const executableToken = fc
    .stringOf(
      fc.constantFrom(
        ...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_().='.split(
          '',
        ),
      ),
      { minLength: 1, maxLength: 20 },
    )
    // Ensure the token, once trimmed, is genuinely non-empty and not just
    // characters that vanish; the charset above already excludes whitespace.
    .filter((t) => t.trim().length > 0);

  /**
   * Script that contains at least one executable statement embedded among
   * comment/whitespace noise. The executable token is placed at a random
   * position between the noise fragments.
   */
  const scriptWithStatement = fc
    .tuple(
      fc.array(commentOrWhitespace, { maxLength: 5 }),
      executableToken,
      fc.array(commentOrWhitespace, { maxLength: 5 }),
    )
    .map(([before, token, after]) => {
      // Wrap the token with whitespace so it cannot fuse with adjacent comment
      // syntax (e.g. a preceding "--" would otherwise comment it out).
      return `${before.join('')} ${token} ;${after.join('')}`;
    });

  // ---------------------------------------------------------------------------
  // Comment-only scripts → effectively empty + generate rejects
  // ---------------------------------------------------------------------------

  it('classifies comment/whitespace-only scripts as empty and generate throws ReverseSqlError', async () => {
    await fc.assert(
      fc.asyncProperty(commentOnlyScript, async (sql) => {
        const generator = new ReverseSqlGenerator(fakeRunner(sql));

        // isEffectivelyEmpty must classify a comment-only script as empty.
        expect(generator.isEffectivelyEmpty(sql)).toBe(true);

        // generate must reject with ReverseSqlError (R3.3, non-zero exit).
        await expect(generator.generate(cfg, target)).rejects.toBeInstanceOf(
          ReverseSqlError,
        );
      }),
      { numRuns: 150 },
    );
  });

  // ---------------------------------------------------------------------------
  // Scripts with a statement → non-empty + generate succeeds
  // ---------------------------------------------------------------------------

  it('classifies scripts with an executable statement as non-empty and generate returns statements', async () => {
    await fc.assert(
      fc.asyncProperty(scriptWithStatement, async (sql) => {
        const generator = new ReverseSqlGenerator(fakeRunner(sql));

        // isEffectivelyEmpty must classify a script with a statement as non-empty.
        expect(generator.isEffectivelyEmpty(sql)).toBe(false);

        // generate must succeed and return at least one parsed statement.
        const result = await generator.generate(cfg, target);
        expect(result.raw).toBe(sql);
        expect(Array.isArray(result.statements)).toBe(true);
        expect(result.statements.length).toBeGreaterThan(0);
      }),
      { numRuns: 150 },
    );
  });
});
