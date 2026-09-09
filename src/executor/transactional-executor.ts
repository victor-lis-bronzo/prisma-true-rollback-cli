/**
 * Transactional Executor (design.md §"Transactional Executor").
 *
 * Executes the *database half* of the Rollback_Operation atomically and is
 * reused by the Compensating-Recovery Coordinator (Task 12) for the DB restore
 * path. Two operations are exposed:
 *
 *   - {@link TransactionalExecutor.applyReversal} — the point-of-no-return
 *     Step 3 of the operation: guard the engine's transactional-DDL support
 *     (R4.6), then, inside a single transaction, execute each reverse statement
 *     in order and delete the target migration's tracking record (R4.1, R4.2).
 *     The driver's transaction wrapper commits on resolve (R4.3) and rolls back
 *     on throw (R4.4); a statement failure is surfaced as a
 *     {@link TransactionAbortedError} carrying the failing statement + reason
 *     (R4.5).
 *
 *   - {@link TransactionalExecutor.restoreDatabase} — the recovery path (R6.4):
 *     re-apply the original migration's forward statements and re-insert the
 *     saved tracking record inside a single transaction, committing on success
 *     and rolling back + rethrowing on failure.
 *
 * ── Design note on the R4.6 guard input ─────────────────────────────────────
 * design.md models `applyReversal`'s input as `{ statements, targetMigration }`
 * and locates the transactional-DDL capability on the {@link DbDriver}
 * (`driver.supportsTransactionalDDL`). This component, however, operates on an
 * already-opened {@link Connection} (the orchestrator owns driver selection and
 * connection lifecycle), not on a driver. To keep the guard enforceable here —
 * and to keep the component trivially testable with a fake `Connection`/`Tx`
 * without also fabricating a fake driver — the capability flag is threaded
 * through the input object as `supportsTransactionalDDL`. The orchestrator
 * simply forwards `driver.supportsTransactionalDDL` into this field, so the
 * semantics are identical to reading it off the driver; only the plumbing
 * differs. The guard is evaluated FIRST, before the transaction is even opened,
 * guaranteeing zero reverse statements execute on a non-transactional-DDL
 * engine (R4.6, Property 12).
 */

import type { Connection, Tx } from '../drivers/driver.js';
import {
  StatementError,
  TransactionAbortedError,
  UnsupportedDdlError,
} from '../models/errors.js';
import type { MigrationRecord } from '../models/types.js';

/** Input to {@link TransactionalExecutor.applyReversal}. */
export interface ApplyReversalInput {
  /**
   * The parsed, executable reverse-SQL statements to apply in order (R4.1).
   * Produced by the Reverse-SQL Generator (Task 9).
   */
  statements: string[];
  /**
   * The Target_Migration name whose tracking record is removed after the
   * reverse statements succeed (R4.2).
   */
  targetMigration: string;
  /**
   * Whether the target engine supports transactional DDL. When `false` the
   * reversal is aborted BEFORE any statement executes (R4.6). The orchestrator
   * forwards `driver.supportsTransactionalDDL` here — see the module-level
   * design note.
   */
  supportsTransactionalDDL: boolean;
  /**
   * The engine identifier, used only for the {@link UnsupportedDdlError}
   * message when the guard blocks (R4.6). Optional; defaults to a generic label.
   */
  engine?: string;
}

/** Input to {@link TransactionalExecutor.restoreDatabase}. */
export interface RestoreDatabaseInput {
  /**
   * The original migration's forward statements (parsed from its
   * `migration.sql`), re-applied in order to restore the schema (R6.4).
   */
  forwardStatements: string[];
  /**
   * The previously captured tracking record, re-inserted to restore the
   * Tracking_Table row for the Target_Migration (R6.4).
   */
  record: MigrationRecord;
}

/**
 * Executes the atomic database reversion (R4) and the recovery DB restore
 * (R6.4). Stateless: every method operates entirely on the {@link Connection}
 * argument, so a single instance is safe to share.
 */
export class TransactionalExecutor {
  /**
   * Apply the reverse SQL and remove the tracking record for the
   * Target_Migration atomically (R4.1–R4.6).
   *
   * Control flow:
   *   1. **Guard first (R4.6).** If `supportsTransactionalDDL` is `false`, throw
   *      {@link UnsupportedDdlError} immediately — before opening a transaction
   *      or executing any statement — so zero reverse statements run on an
   *      engine that cannot roll back DDL (Property 12).
   *   2. Open a single transaction via `conn.transaction`. Inside it:
   *        - execute each reverse statement in order via `tx.exec` (R4.1), then
   *        - delete the Target_Migration's tracking record via
   *          `tx.deleteMigrationRecord` (R4.2).
   *   3. The driver's transaction wrapper commits when the callback resolves
   *      (R4.3) and rolls back when it throws (R4.4).
   *   4. A statement failure surfaces from the driver as a
   *      {@link StatementError} carrying the failing statement text. It is
   *      caught and rethrown as a {@link TransactionAbortedError} carrying the
   *      failing statement + underlying reason (R4.5); the throw propagates out
   *      of `conn.transaction`, so the transaction has already rolled back.
   *
   * @param conn  An open database connection (lifecycle owned by the caller).
   * @param input The reverse statements, target migration, and DDL capability.
   * @throws {UnsupportedDdlError} when the engine lacks transactional-DDL
   *   support (R4.6) — thrown before any statement executes.
   * @throws {TransactionAbortedError} when a statement fails and the
   *   transaction is rolled back (R4.4, R4.5).
   */
  async applyReversal(conn: Connection, input: ApplyReversalInput): Promise<void> {
    // 1. Guard FIRST — before any transaction or DDL (R4.6, Property 12).
    if (!input.supportsTransactionalDDL) {
      throw new UnsupportedDdlError(input.engine ?? 'unknown');
    }

    // 2–4. Single transaction: reverse statements, then tracking-record delete.
    // The driver's wrapper commits on resolve (R4.3) / rolls back on throw (R4.4).
    await conn.transaction(async (tx: Tx) => {
      for (const statement of input.statements) {
        try {
          await tx.exec(statement); // R4.1
        } catch (err) {
          // R4.5: rethrow as a TransactionAbortedError carrying the failing
          // statement + reason. Throwing here triggers the driver rollback
          // (R4.4) so DB + tracking match their pre-transaction state.
          throw this.toTransactionAborted(statement, err);
        }
      }
      // R4.2: remove the tracking record in the SAME transaction, AFTER the
      // reverse statements have all succeeded.
      await tx.deleteMigrationRecord(input.targetMigration);
    });
  }

  /**
   * Restore the database to its pre-operation state during Compensating_Recovery
   * (R6.4).
   *
   * Within a single transaction, re-apply the original migration's forward
   * statements in order and then re-insert the saved tracking record. The
   * driver's transaction wrapper commits on success and rolls back + rethrows on
   * any failure, so a failed restore leaves the database unchanged and lets the
   * Recovery Coordinator report the DB element as unrestored (R6.7).
   *
   * @param conn  An open database connection (lifecycle owned by the caller).
   * @param input The forward statements to re-apply and the record to re-insert.
   */
  async restoreDatabase(
    conn: Connection,
    input: RestoreDatabaseInput
  ): Promise<void> {
    await conn.transaction(async (tx: Tx) => {
      for (const statement of input.forwardStatements) {
        await tx.exec(statement); // re-apply forward SQL (R6.4)
      }
      // Restore the Tracking_Table row for the Target_Migration (R6.4).
      await tx.insertMigrationRecord(input.record);
    });
  }

  /**
   * Convert an error thrown while executing a reverse statement into a
   * {@link TransactionAbortedError} carrying the failing statement + reason
   * (R4.5), preserving the original error as the `cause`.
   *
   * When the driver surfaced a {@link StatementError}, its `statement` field is
   * authoritative for the failing statement text; otherwise the statement text
   * from this executor's loop is used. The reason is derived from the underlying
   * error's message where available.
   */
  private toTransactionAborted(
    statement: string,
    err: unknown,
  ): TransactionAbortedError {
    const failingStatement =
      err instanceof StatementError ? err.statement : statement;
    const reason =
      err instanceof Error && err.message.length > 0
        ? err.message
        : String(err);
    return new TransactionAbortedError(failingStatement, reason, { cause: err });
  }
}
