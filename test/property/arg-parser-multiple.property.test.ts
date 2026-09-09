// Feature: prisma-true-rollback-cli, Property 17: Multiple migration-name arguments are rejected

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { argParser } from '../../src/cli/arg-parser.js';

/**
 * Property 17: Multiple migration-name arguments are rejected.
 *
 * For any argument vector that contains two or more positional migration-name
 * arguments (arbitrary non-flag tokens), optionally interleaved with arbitrary
 * recognized flags (but NOT the version flag, which short-circuits parsing),
 * `argParser.parse` returns `{ kind: 'error', exitCode: 1 }` with a message
 * reporting that only one migration name is accepted per invocation.
 *
 * Validates: Requirements 1.3
 */

/**
 * Every token the parser recognizes. Generated positionals must avoid these so
 * they are actually treated as positional migration names. The version flags
 * (`--version`, `-v`) are additionally excluded from interleaved flags because
 * their presence short-circuits parsing to `{ kind: 'version' }`.
 */
const RECOGNIZED_TOKENS = new Set([
  '--version',
  '-v',
  '--dry-run',
  '--yes',
  '-y',
  '--override',
  '--verbose',
]);

/** Recognized flags that do NOT short-circuit parsing (version excluded). */
const NON_VERSION_FLAGS = ['--dry-run', '--yes', '-y', '--override', '--verbose'];

/**
 * Arbitrary for a positional token that is not a recognized flag. Prefixing an
 * arbitrary string with a letter guarantees it can never equal a recognized
 * flag token (all of which start with `-`), while still exercising a wide range
 * of migration-name-like values.
 */
const positionalArb = fc
  .string()
  .map((s) => `m${s}`)
  .filter((s) => !RECOGNIZED_TOKENS.has(s));

const flagArb = fc.constantFrom(...NON_VERSION_FLAGS);

describe('ArgParser.parse — Property 17: multiple migration names rejected', () => {
  it('rejects any argv with two or more positional migration names', () => {
    fc.assert(
      fc.property(
        // Two or more positionals.
        fc.array(positionalArb, { minLength: 2, maxLength: 6 }),
        // Zero or more interleaved non-version flags.
        fc.array(flagArb, { minLength: 0, maxLength: 5 }),
        // A seed to shuffle positionals and flags into an arbitrary order.
        fc.array(fc.double({ min: 0, max: 1, noNaN: true }), {
          minLength: 0,
          maxLength: 11,
        }),
        (positionals, flags, order) => {
          // Interleave positionals and flags in an arbitrary but deterministic
          // order while preserving that all positionals are present.
          const tokens = [...positionals, ...flags];
          const argv = tokens
            .map((tok, i) => ({ tok, key: order[i] ?? i }))
            .sort((a, b) => a.key - b.key)
            .map((e) => e.tok);

          const result = argParser.parse(argv);

          expect(result.kind).toBe('error');
          if (result.kind !== 'error') return false;
          expect(result.exitCode).toBe(1);
          // Message reports that only one migration name is accepted.
          expect(result.message.toLowerCase()).toContain('only one');
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });
});
