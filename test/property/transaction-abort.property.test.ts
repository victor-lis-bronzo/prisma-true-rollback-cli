// Feature: prisma-true-rollback-cli, Property 11: Failing statement is reported on transaction abort
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { TransactionalExecutor } from '../../src/executor/transactional-executor.js';
import { StatementError, TransactionAbortedError } from '../../src/models/errors.js';
import type { Connection, Tx } from '../../src/drivers/driver.js';
import type { MigrationRecord } from '../../src/models/types.js';

/**
 * Property 11: Failing statement is reported on transaction abort.
 *
 * For any reversal transaction in which a database statement fails,
 * `TransactionalExecutor.applyReversal` SHALL reject (so the CLI terminates
 * with a non-zero exit code) with a `TransactionAbortedError` whose message
 * includes the text of the failing statement AND the underlying failure
 * reason, and whose `failingStatement` field equals the exact statement that
 * failed (R4.5).
 *
 * Strategy: build an in-memory fake `Connection`/`Tx`. `transaction(fn)` runs
 * `fn(tx)` and rethrows on error, simulating a driver that rolls back and
 * re-throws (per the driver contract). The fake `Tx.exec` throws a
 * `StatementError` (carrying the failing statement text + reason) exactly when
 * it reaches the randomly-chosen failing statement among the generated reverse
 * statements. `supportsTransactionalDDL` is `true` so the R4.6 guard is passed
 * and execution reaches the transaction body.
 *
 * We generate a non-empty array of distinct reverse statements plus a valid
 * failing index into it, plus an arbitrary reason string.
 *
 * Validates: Requirements 4.5
 */
describe('Property 11: Failing statement is reported on transaction abort', () => {
  const executor = new TransactionalExecutor();

  /**
   * Build a fake Connection whose single transaction runs the callback against
   * a fake Tx. The Tx's `exec` throws a `StatementError` (statement + reason)
   * when invoked with `failingStatement`, and otherwise resolves. On any throw
   * from the callback, `transaction` rethrows the error (simulating rollback +
   * re-throw), so `applyReversal` observes it.
   *
   * `execCalls` records the statements that were executed, letting us assert
   * that no statement after the failing one runs.
   */
  function makeFakeConnection(
    failingStatement: string,
    reason: string,
  ): { conn: Connection; execCalls: string[] } {
    const execCalls: string[] = [];

    const tx: Tx = {
      async exec(statement: string): Promise<void> {
        execCalls.push(statement);
        if (statement === failingStatement) {
          throw new StatementError(statement, reason);
        }
      },
      queryLatestMigration(): Promise<MigrationRecord | null> {
        return Promise.resolve(null);
      },
      queryMigrationByName(): Promise<MigrationRecord | null> {
        return Promise.resolve(null);
      },
      async deleteMigrationRecord(): Promise<void> {
        // Only reached if all statements succeed; irrelevant for this property.
      },
      async insertMigrationRecord(): Promise<void> {
        /* unused */
      },
    };

    const conn: Connection = {
      async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
        // Commit on resolve; roll back + rethrow on throw (driver contract, R4).
        return await fn(tx);
      },
      async close(): Promise<void> {
        /* unused */
      },
    };

    return { conn, execCalls };
  }

  it('rejects with a TransactionAbortedError carrying the failing statement + reason', async () => {
    // A single reverse statement token (kept distinct so a chosen failing
    // statement is unambiguous within the generated array).
    const statementArb = fc
      .string({ minLength: 1, maxLength: 40 })
      .filter((s) => s.trim().length > 0);

    const scenarioArb = fc
      .uniqueArray(statementArb, { minLength: 1, maxLength: 8 })
      .chain((statements) =>
        fc.record({
          statements: fc.constant(statements),
          failingIndex: fc.integer({ min: 0, max: statements.length - 1 }),
          reason: fc.string({ minLength: 1, maxLength: 60 }),
          targetMigration: fc
            .string({ minLength: 1, maxLength: 30 })
            .filter((s) => s.trim().length > 0),
        }),
      );

    await fc.assert(
      fc.asyncProperty(scenarioArb, async ({ statements, failingIndex, reason, targetMigration }) => {
        const failingStatement = statements[failingIndex];
        const { conn, execCalls } = makeFakeConnection(failingStatement, reason);

        const promise = executor.applyReversal(conn, {
          statements,
          targetMigration,
          supportsTransactionalDDL: true, // pass the R4.6 guard
        });

        // Must reject (non-zero exit semantics) with a TransactionAbortedError.
        await expect(promise).rejects.toBeInstanceOf(TransactionAbortedError);

        const error = await promise.catch((e: unknown) => e);
        expect(error).toBeInstanceOf(TransactionAbortedError);
        const aborted = error as TransactionAbortedError;

        // The failing statement field equals the exact chosen statement (R4.5).
        expect(aborted.failingStatement).toBe(failingStatement);

        // The message includes the failing statement text AND the reason (R4.5).
        expect(aborted.message).toContain(failingStatement);
        expect(aborted.message).toContain(reason);

        // Execution stopped at the failing statement — nothing after it ran.
        expect(execCalls).toEqual(statements.slice(0, failingIndex + 1));

        return true;
      }),
      { numRuns: 150 },
    );
  });
});
