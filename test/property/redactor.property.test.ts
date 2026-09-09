// Feature: prisma-true-rollback-cli, Property 4: Credentials never appear in output
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { ConsoleLogger, type Sink } from '../../src/logger/logger.js';
import { REDACTION_PLACEHOLDER } from '../../src/logger/redactor.js';

/**
 * Property 4: Credentials never appear in output (design.md §Correctness
 * Property 4, Validates Requirements 8.4, 8.5).
 *
 * For any credential set (the DATABASE_URL value, username, password, host,
 * and port) and any carrier message, routing the message through the Redactor
 * via EVERY ConsoleLogger method (step, stepDone, stepFailed, info, warn,
 * verbose, error — with verbose enabled) must produce output that:
 *   1. contains NONE of the raw credential values, and
 *   2. contains the fixed redaction placeholder whenever a credential value
 *      was embedded in the message.
 *
 * Credentials are embedded in postgresql://, mysql:// and file: connection
 * URLs and in bare inline `user:pass@host:port` fragments. Output is captured
 * via injected sinks so no real process stream is touched.
 */
describe('Property 4: credentials never appear in Logger output', () => {
  // A credential token: non-trivial, no whitespace, no delimiter chars that
  // would break URL/inline-fragment boundaries. Realistic credentials begin
  // and end with an alphanumeric (so a word boundary anchors the value),
  // keeping generation inside the input space the Redactor is specified to
  // handle so the assertions stay meaningful.
  const token = (): fc.Arbitrary<string> =>
    fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._%+-]{1,18}[A-Za-z0-9]$/);

  // A host component: alphanumerics, dots and dashes (e.g. db.internal.example),
  // beginning and ending with an alphanumeric like a real DNS label.
  const host = (): fc.Arbitrary<string> =>
    fc.stringMatching(/^[A-Za-z0-9]([A-Za-z0-9.-]{1,30}[A-Za-z0-9])?$/);

  // A port: 1-65535 as a string.
  const port = (): fc.Arbitrary<string> =>
    fc.integer({ min: 1, max: 65535 }).map((n) => String(n));

  // A benign carrier prefix/suffix that itself contains no credentials.
  const carrier = (): fc.Arbitrary<string> =>
    fc.stringMatching(/^[A-Za-z0-9 ,.!:-]{0,40}$/);

  // The four ways the task asks us to embed the credentials.
  type Embedding = { name: string; scheme: string };
  const embeddings: Embedding[] = [
    { name: 'postgresql-url', scheme: 'postgresql' },
    { name: 'mysql-url', scheme: 'mysql' },
    { name: 'file-url', scheme: 'file' },
    { name: 'inline-fragment', scheme: 'inline' },
  ];

  it('redacts every credential value across all Logger methods (>=100 runs)', () => {
    fc.assert(
      fc.property(
        token(), // username
        token(), // password
        host(), // host
        port(), // port
        token(), // db name / file path segment
        carrier(),
        carrier(),
        fc.constantFrom(...embeddings),
        (username, password, hostName, portNum, dbName, pre, post, embedding) => {
          // Build the credential-bearing fragment and the set of raw values
          // that MUST NOT survive redaction.
          let fragment: string;
          const rawValues: string[] = [];

          switch (embedding.scheme) {
            case 'file': {
              // file: URLs carry no user/pass; the whole URL is the secret.
              fragment = `file:./${dbName}/dev.db`;
              // Only assert the path segment as the sensitive value; host/port
              // do not appear in a file URL.
              rawValues.push(fragment);
              break;
            }
            case 'inline': {
              // Bare `user:pass@host:port` fragment without a scheme prefix.
              fragment = `${username}:${password}@${hostName}:${portNum}`;
              rawValues.push(username, password, hostName, portNum);
              break;
            }
            default: {
              // Network connection URL: scheme://user:pass@host:port/db?...
              fragment =
                `${embedding.scheme}://${username}:${password}@` +
                `${hostName}:${portNum}/${dbName}?schema=public`;
              rawValues.push(username, password, hostName, portNum, dbName);
              break;
            }
          }

          const message = `${pre} ${fragment} ${post}`;

          // Capture every line written by every method via injected sinks.
          const lines: string[] = [];
          const sink: Sink = (line) => lines.push(line);
          const logger = new ConsoleLogger({
            verbose: true,
            out: sink,
            err: sink,
          });

          // Route the same credential-bearing message through EVERY method.
          logger.step(1, 3, message);
          logger.stepDone(message);
          logger.stepFailed(message, new Error(message));
          logger.info(message);
          logger.warn(message);
          logger.verbose(message);
          logger.error(message);

          // Every method must have produced output (verbose is enabled).
          expect(lines.length).toBeGreaterThanOrEqual(7);

          const output = lines.join('\n');

          // (1) No raw credential value may survive in ANY captured line.
          //     Guard against degenerate values that coincidentally appear in
          //     benign carrier text or the placeholder itself.
          const placeholderContains = (v: string): boolean =>
            REDACTION_PLACEHOLDER.includes(v);
          for (const raw of rawValues) {
            if (raw.length < 3) continue; // too short to assert meaningfully
            if (placeholderContains(raw)) continue;
            // Skip values that occur inside the benign carrier context, since
            // those are not the credential occurrence we are redacting.
            const inCarrier = `${pre} ${post}`.includes(raw);
            if (inCarrier) continue;
            expect(output).not.toContain(raw);
          }

          // (2) A credential was embedded, so the placeholder must be present.
          expect(output).toContain(REDACTION_PLACEHOLDER);

          return true;
        },
      ),
      { numRuns: 200 },
    );
  });
});
