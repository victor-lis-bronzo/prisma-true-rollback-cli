// Feature: prisma-true-rollback-cli, Property 6: Production indicators always block
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { EnvironmentGuard } from '../../src/env/environment-guard.js';

/**
 * Property 6: Production indicators always block.
 *
 * For any invocation in which a Production_Indicator is present (NODE_ENV
 * equals "production" OR the connection target is designated production), the
 * guard SHALL classify the environment as `'production'` and terminate with a
 * non-zero exit code and no changes, regardless of whether the override flag is
 * supplied.
 *
 * A Production_Indicator is present when, after normalization, `NODE_ENV ===
 * 'production'` OR `connectionTargetDesignation === 'production'`.
 *
 * Strategy: generate arbitrary `nodeEnv` strings and connection-target
 * designations, then constrain them so that at least one signal is a
 * production indicator (either the normalized NODE_ENV is "production" — with
 * arbitrary surrounding whitespace and case — or the designation is
 * 'production'). The other signal is allowed to vary freely across its input
 * space so the production indicator dominates regardless of the counterpart.
 * First assert `classify()` genuinely returns `'production'` for the generated
 * input (so the property exercises the intended region of the input space),
 * then assert `evaluate('production', overrideFlag)` blocks for BOTH override
 * values.
 *
 * **Validates: Requirements 2.1**
 */
describe('Property 6: Production indicators always block', () => {
  /**
   * `nodeEnv` values whose normalized (trimmed + lowercased) form is exactly
   * "production": mixed case and arbitrary surrounding whitespace.
   */
  const productionNodeEnvArb: fc.Arbitrary<string> = fc
    .tuple(
      fc.stringOf(fc.constantFrom(' ', '\t', '\n'), { maxLength: 4 }),
      fc.constantFrom('production', 'PRODUCTION', 'Production', 'ProDuCtIoN'),
      fc.stringOf(fc.constantFrom(' ', '\t', '\n'), { maxLength: 4 }),
    )
    .map(([lead, word, trail]) => `${lead}${word}${trail}`);

  /** An arbitrary, possibly-undefined `nodeEnv` (unconstrained counterpart). */
  const anyNodeEnvArb: fc.Arbitrary<string | undefined> = fc.oneof(
    fc.string({ maxLength: 30 }),
    fc.constant(undefined),
  );

  /** An arbitrary, possibly-undefined connection-target designation. */
  const anyDesignationArb: fc.Arbitrary<
    'production' | 'development' | undefined
  > = fc.constantFrom('production', 'development', undefined);

  /**
   * Inputs guaranteed to contain a Production_Indicator, covering three cases:
   *  - NODE_ENV normalizes to "production", designation varies freely;
   *  - designation is 'production', NODE_ENV varies freely;
   *  - both signals indicate production.
   */
  const productionInputArb: fc.Arbitrary<{
    nodeEnv: string | undefined;
    connectionTargetDesignation: 'production' | 'development' | undefined;
  }> = fc.oneof(
    // NODE_ENV is the indicator; designation is arbitrary.
    fc.record({
      nodeEnv: productionNodeEnvArb,
      connectionTargetDesignation: anyDesignationArb,
    }),
    // Designation is the indicator; NODE_ENV is arbitrary.
    fc.record({
      nodeEnv: anyNodeEnvArb,
      connectionTargetDesignation: fc.constant('production' as const),
    }),
    // Both signals indicate production.
    fc.record({
      nodeEnv: productionNodeEnvArb,
      connectionTargetDesignation: fc.constant('production' as const),
    }),
  );

  it('classifies as production and blocks regardless of the override flag', () => {
    const guard = new EnvironmentGuard();

    fc.assert(
      fc.property(productionInputArb, fc.boolean(), (input, overrideFlag) => {
        // Precondition: a Production_Indicator forces the production class.
        const classification = guard.classify(input);
        expect(classification).toBe('production');

        // Blocks regardless of the override flag value.
        const decision = guard.evaluate('production', overrideFlag);
        expect(decision.allow).toBe(false);
        if (decision.allow === false) {
          expect(decision.reason).toBe('production');
          expect(decision.exitCode).not.toBe(0);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('blocks for both override=false and override=true explicitly', () => {
    const guard = new EnvironmentGuard();

    fc.assert(
      fc.property(productionInputArb, (input) => {
        expect(guard.classify(input)).toBe('production');

        for (const overrideFlag of [false, true]) {
          const decision = guard.evaluate('production', overrideFlag);
          expect(decision.allow).toBe(false);
          if (decision.allow === false) {
            expect(decision.reason).toBe('production');
            expect(decision.exitCode).not.toBe(0);
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});
