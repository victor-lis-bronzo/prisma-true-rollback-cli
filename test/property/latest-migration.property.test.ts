// Feature: prisma-true-rollback-cli, Property 5: Only the most recently applied migration is rollback-eligible
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  TargetValidator,
  TargetValidationError,
  type DirectoryProbe,
} from '../../src/orchestrator/target-validator.js';
import type { Connection, Tx } from '../../src/drivers/driver.js';
import type { MigrationRecord } from '../../src/models/types.js';

/**
 * Property 5: Only the most recently applied migration is rollback-eligible.
 *
 * For any Tracking_Table history (an ordered list of applied migrations), a
 * Target_Migration that is NOT the most recently applied recorded migration
 * SHALL be rejected with exit code 1 and no changes (a `TargetValidationError`
 * with reason `'not-latest'`), while the most recently applied migration SHALL
 * pass the eligibility guard (R1.6).
 *
 * Strategy: generate a non-empty, distinct, ordered list of applied migration
 * names — the LAST element is, by construction, the most recently applied
 * (`latest`). We drive `TargetValidator.validate` with fakes so the only check
 * that can fire is the latest-migration guard:
 *   - `DirectoryProbe.isDirectory` always reports `true`, so the unknown-folder
 *     check (R1.4) never trips.
 *   - `Tx.queryMigrationByName(name)` returns the matching record for any name
 *     present in the history (so the not-recorded check R1.5 never trips), and
 *     `null` otherwise.
 *   - `Tx.queryLatestMigration()` returns the record for `latest` (the last
 *     applied), matching the ordered history.
 *   - `Connection.transaction` runs the callback and returns its result; the
 *     fake `Tx` never mutates anything, so "no changes" holds structurally.
 *
 * For each generated history we test BOTH directions:
 *   1. A non-latest pick (any element other than the last) MUST be rejected
 *      with a `TargetValidationError` whose `reason === 'not-latest'`.
 *   2. The latest pick MUST pass the eligibility guard (resolve to the target +
 *      its record) with no error.
 *
 * **Validates: Requirements 1.6**
 */
describe('Property 5: Only the most recently applied migration is rollback-eligible', () => {
  const MIGRATIONS_DIR = '/repo/prisma/migrations';

  /** A DirectoryProbe that reports every folder exists (R1.4 never fires). */
  const existsProbe: DirectoryProbe = {
    isDirectory(): Promise<boolean> {
      return Promise.resolve(true);
    },
  };

  const validator = new TargetValidator(existsProbe);

  /** Build a MigrationRecord for `name` — the only field the guard reads. */
  function recordFor(name: string): MigrationRecord {
    return {
      id: `id-${name}`,
      migrationName: name,
      checksum: `checksum-${name}`,
      finishedAt: '2024-01-01T00:00:00.000Z',
      startedAt: '2024-01-01T00:00:00.000Z',
      appliedStepsCount: 1,
      logs: null,
      rolledBackAt: null,
    };
  }

  /**
   * Fake Connection over an ordered history of applied migration names.
   * `queryMigrationByName` returns the matching record (or null if unknown);
   * `queryLatestMigration` returns the record for the last-applied migration
   * (the tail of `history`). The Tx performs no mutations.
   */
  function makeFakeConnection(history: string[]): Connection {
    const latestName = history[history.length - 1];
    const known = new Set(history);

    const tx: Tx = {
      exec(): Promise<void> {
        return Promise.reject(new Error('exec must not be called during validation'));
      },
      queryLatestMigration(): Promise<MigrationRecord | null> {
        return Promise.resolve(recordFor(latestName));
      },
      queryMigrationByName(name: string): Promise<MigrationRecord | null> {
        return Promise.resolve(known.has(name) ? recordFor(name) : null);
      },
      deleteMigrationRecord(): Promise<void> {
        return Promise.reject(new Error('deleteMigrationRecord must not be called during validation'));
      },
      insertMigrationRecord(): Promise<void> {
        return Promise.reject(new Error('insertMigrationRecord must not be called during validation'));
      },
    };

    return {
      async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
        return await fn(tx);
      },
      async close(): Promise<void> {
        /* unused */
      },
    };
  }

  /**
   * Arbitrary ordered histories of >= 2 distinct migration names (>= 2 so a
   * distinct non-latest pick always exists), plus the index of a non-latest
   * pick into that history.
   */
  const scenarioArb = fc
    .uniqueArray(
      fc.string({ minLength: 1, maxLength: 24 }).filter((s) => s.trim().length > 0),
      { minLength: 2, maxLength: 10 },
    )
    .chain((history) =>
      fc.record({
        history: fc.constant(history),
        // A non-latest index in [0, history.length - 2].
        nonLatestIndex: fc.integer({ min: 0, max: history.length - 2 }),
      }),
    );

  it('rejects any non-latest target (exit 1, no changes) and passes the latest target', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async ({ history, nonLatestIndex }) => {
        const conn = makeFakeConnection(history);
        const latestName = history[history.length - 1];
        const nonLatestName = history[nonLatestIndex];

        // 1. Non-latest pick MUST be rejected with reason 'not-latest'.
        const rejectPromise = validator.validate(MIGRATIONS_DIR, conn, nonLatestName);
        await expect(rejectPromise).rejects.toBeInstanceOf(TargetValidationError);

        const error = await rejectPromise.catch((e: unknown) => e);
        expect(error).toBeInstanceOf(TargetValidationError);
        const validationError = error as TargetValidationError;
        expect(validationError.reason).toBe('not-latest');
        expect(validationError.migrationName).toBe(nonLatestName);

        // 2. Latest pick MUST pass the eligibility guard.
        const validated = await validator.validate(MIGRATIONS_DIR, conn, latestName);
        expect(validated.target.name).toBe(latestName);
        expect(validated.record.migrationName).toBe(latestName);

        return true;
      }),
      { numRuns: 150 },
    );
  });
});
