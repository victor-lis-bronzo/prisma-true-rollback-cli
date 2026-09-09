// Feature: prisma-true-rollback-cli, Property 7: Ambiguous environments require an override
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { EnvironmentGuard } from '../../src/env/environment-guard.js';

/**
 * Property 7: Ambiguous environments require an override.
 *
 * For any invocation whose environment classifies as ambiguous, the guard SHALL
 * block with a non-zero exit code and no changes when no override flag is
 * supplied, and SHALL be permitted to proceed when the override flag is
 * supplied.
 *
 * An environment classifies as ambiguous when the resolved `NODE_ENV` is
 * unset/empty/unrecognized AND the connection-target designation is undefined.
 *
 * Strategy: generate `nodeEnv` values that are guaranteed NOT to be recognized
 * (i.e. not one of {production, development, test} after normalization) plus
 * undefined / empty / whitespace, always paired with an undefined
 * connection-target designation. First assert `classify()` genuinely returns
 * `'ambiguous'` for the generated input (so the property tests the intended
 * region of the input space), then assert the block-without-override /
 * allow-with-override behavior of `evaluate('ambiguous', ...)`.
 *
 * **Validates: Requirements 2.2**
 */
describe('Property 7: Ambiguous environments require an override', () => {
  const RECOGNIZED = new Set(['production', 'development', 'test']);

  /**
   * Arbitrary `nodeEnv` values that drive the ambiguous classification: an
   * unrecognized non-empty string, or undefined, or empty/whitespace-only.
   */
  const ambiguousNodeEnvArb: fc.Arbitrary<string | undefined> = fc.oneof(
    // Unrecognized strings (exclude the recognized set after normalization).
    fc
      .string({ minLength: 1, maxLength: 30 })
      .filter((s) => !RECOGNIZED.has(s.trim().toLowerCase())),
    // Absent.
    fc.constant(undefined),
    // Empty / whitespace-only (treated as unrecognized).
    fc.constantFrom('', '   ', '\t', '\n', '  \t \n '),
  );

  it('classifies as ambiguous, then blocks without override and allows with override', () => {
    const guard = new EnvironmentGuard();

    fc.assert(
      fc.property(ambiguousNodeEnvArb, (nodeEnv) => {
        // The connection-target designation is undefined for the ambiguous case.
        const classification = guard.classify({
          nodeEnv,
          connectionTargetDesignation: undefined,
        });

        // Precondition: the generated input truly classifies as ambiguous.
        expect(classification).toBe('ambiguous');

        // Without an override, the guard blocks with a non-zero exit code.
        const blocked = guard.evaluate('ambiguous', false);
        expect(blocked.allow).toBe(false);
        if (blocked.allow === false) {
          expect(blocked.reason).toBe('ambiguous');
          expect(blocked.exitCode).not.toBe(0);
        }

        // With an override, the guard permits the operation to proceed.
        const allowed = guard.evaluate('ambiguous', true);
        expect(allowed.allow).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});
