// Feature: prisma-true-rollback-cli, Property 16: Missing migration-name argument is rejected
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { argParser } from '../../src/cli/arg-parser.js';

/**
 * Property 16: Missing migration-name argument is rejected.
 *
 * For any argument vector that contains no positional migration-name argument
 * (flags only), the CLI SHALL terminate with exit code 1, perform no changes,
 * and produce an error message identifying the missing migration-name argument.
 *
 * The generated argv is drawn exclusively from recognized non-positional flags
 * (in any order, with repetition). The version flags (--version / -v) are
 * deliberately excluded because they short-circuit parsing to
 * `{ kind: 'version' }` before the arity checks run.
 *
 * **Validates: Requirements 1.2**
 */
describe('Property 16: Missing migration-name argument is rejected', () => {
  // Recognized flags that are NOT positional and do NOT short-circuit parsing.
  const NON_POSITIONAL_FLAGS = ['--dry-run', '--yes', '-y', '--override', '--verbose'];

  it('rejects any flags-only argv with exit code 1 and a missing-argument message', () => {
    fc.assert(
      fc.property(
        // Arrays (including empty) of flags in any order/repetition.
        fc.array(fc.constantFrom(...NON_POSITIONAL_FLAGS), { maxLength: 12 }),
        (argv) => {
          const result = argParser.parse(argv);

          expect(result.kind).toBe('error');
          if (result.kind !== 'error') {
            return; // narrows type; unreachable after the assertion above
          }

          expect(result.exitCode).toBe(1);
          // The message must identify the missing migration-name argument.
          expect(result.message.toLowerCase()).toContain('migration-name');
          expect(result.message.toLowerCase()).toContain('missing');
        },
      ),
      { numRuns: 100 },
    );
  });
});
