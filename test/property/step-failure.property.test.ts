// Feature: prisma-true-rollback-cli, Property 19: Step failures are reported with step name and detail
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { ConsoleLogger } from '../../src/logger/logger.js';

/**
 * Property 19: Step failures are reported with step name and detail.
 *
 * For any step of the Rollback_Operation that fails, `stepFailed` SHALL write a
 * message to standard error that:
 *   - identifies the failing step by name,
 *   - includes the underlying error detail (the Error's message), and
 *   - indicates the operation was aborted.
 *
 * Output is captured via an injected `err` sink so no real process stream is
 * touched. A no-op redactor is injected so the assertion sees exactly the text
 * the logger emitted (the arbitrary step name and error message are not
 * credentials and must survive verbatim).
 *
 * Validates: Requirements 8.3
 */
describe('Property 19: Step failures are reported with step name and detail', () => {
  it('writes a stderr message with the step name, error detail, and an abort indication', () => {
    // Identity redactor: Property 4 covers redaction; here we assert the raw
    // step name / error detail are surfaced, so redaction must not interfere.
    const identityRedactor = { redact: (line: string) => line };

    fc.assert(
      fc.property(fc.string(), fc.string(), (stepName, errorMessage) => {
        const captured: string[] = [];
        const logger = new ConsoleLogger({
          redactor: identityRedactor,
          // out should never be used by stepFailed; capture separately to prove it.
          out: (line) => captured.push(`OUT:${line}`),
          err: (line) => captured.push(line),
        });

        const error = new Error(errorMessage);
        logger.stepFailed(stepName, error);

        // Exactly one line, written to stderr (the err sink), nothing to stdout.
        expect(captured).toHaveLength(1);
        const line = captured[0];
        expect(line.startsWith('OUT:')).toBe(false);

        // Identifies the failing step by name.
        expect(line).toContain(stepName);

        // Includes the underlying error detail. An empty-message Error falls
        // back to String(error) ("Error"), which the logger surfaces instead.
        const expectedDetail = errorMessage.length > 0 ? errorMessage : String(error);
        expect(line).toContain(expectedDetail);

        // Indicates the operation was aborted.
        expect(line.toLowerCase()).toContain('abort');

        return true;
      }),
      { numRuns: 100 },
    );
  });
});
