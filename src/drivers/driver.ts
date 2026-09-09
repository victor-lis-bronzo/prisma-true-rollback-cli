/**
 * DB Connector / Driver Abstraction.
 *
 * A single interface implemented per engine (PostgreSQL, MySQL, SQLite). It
 * hides connection, transaction, capability, and statement-execution
 * differences behind one contract so the orchestrator is engine-agnostic.
 *
 * These are interface/type definitions only. The concrete per-engine drivers
 * are implemented in Tasks 7.2 (PostgreSQL), 7.3 (SQLite), and 7.4 (MySQL).
 *
 * Requirement traceability:
 * - R4.1 — reverse-SQL + tracking-record cleanup run inside a single
 *   transaction that commits on success and rolls back on failure.
 * - R4.5 — a failing statement surfaces its text via `Tx.exec`.
 * - R4.6 — engines are classified by transactional-DDL support so the
 *   orchestrator can guard non-transactional-DDL engines (MySQL) before any DDL.
 * - R6.4 — recovery re-inserts the saved tracking record via `Tx`.
 * - R7.3 / R7.4 — a 10-second connection timeout is applied on `connect`;
 *   `redactedTarget` yields a host-only, credential-stripped designation.
 * - R7.6 — an opened connection is always closed via `Connection.close`.
 */

import type { DbEngine, MigrationRecord } from '../models/types.js';

/**
 * Default connection timeout in milliseconds (R7.3).
 *
 * Passed by the orchestrator/entrypoint to {@link DbDriver.connect} as the
 * `timeoutMs` argument. Kept here so every driver and caller shares one value.
 */
export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

/**
 * A database driver for a single engine. Implementations are stateless with
 * respect to connections: {@link connect} produces a fresh {@link Connection}
 * each call.
 */
export interface DbDriver {
  /** The engine this driver targets. */
  readonly engine: DbEngine;

  /**
   * Whether the engine can roll back DDL statements within a transaction.
   *
   * `true` for PostgreSQL and SQLite; `false` for MySQL (which performs
   * implicit commits on DDL). When `false`, the orchestrator aborts before
   * executing any reverse SQL so no partial, non-rollback-able change occurs
   * (R4.6).
   */
  readonly supportsTransactionalDDL: boolean;

  /**
   * Opens a connection to `url`, rejecting if the connection is not
   * established within `timeoutMs` (R7.3/R7.4).
   *
   * On failure the orchestrator reports the failure together with
   * {@link redactedTarget} so no raw credentials are ever surfaced (R7.4).
   *
   * @param url       The database connection URL (held in memory only; never logged raw).
   * @param timeoutMs Connection timeout in milliseconds — see {@link DEFAULT_CONNECT_TIMEOUT_MS}.
   */
  connect(url: string, timeoutMs: number): Promise<Connection>;

  /**
   * Returns a redacted, host-only designation of `url` with all credentials
   * (username, password) stripped, suitable for logging (R7.4, R8.5).
   */
  redactedTarget(url: string): string;
}

/**
 * An open database connection. The orchestrator guarantees {@link close} is
 * called on every path (R7.6).
 */
export interface Connection {
  /**
   * Runs `fn` inside a single database transaction, passing it a {@link Tx}
   * handle. Commits when `fn` resolves and rolls back when `fn` throws, then
   * re-throws the original error so the caller observes it (R4).
   *
   * @typeParam T The value produced by `fn` and returned on commit.
   */
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;

  /** Closes the connection and releases its resources (R7.6). */
  close(): Promise<void>;
}

/**
 * A transaction-scoped handle exposing statement execution and the
 * tracking-table (`_prisma_migrations`) record operations the CLI needs.
 * All methods run within the transaction opened by
 * {@link Connection.transaction}.
 */
export interface Tx {
  /**
   * Executes a single SQL statement. On failure the returned promise rejects
   * with an error carrying the failing statement text and the underlying
   * reason, so the orchestrator can report both (R4.5).
   */
  exec(statement: string): Promise<void>;

  /**
   * Returns the most recently applied migration's tracking record, or `null`
   * when no migrations are recorded. Used for latest-migration eligibility
   * validation (R1.6).
   */
  queryLatestMigration(): Promise<MigrationRecord | null>;

  /**
   * Returns the tracking record for the migration named `name`, or `null` when
   * no such record exists (R1.5).
   */
  queryMigrationByName(name: string): Promise<MigrationRecord | null>;

  /**
   * Deletes the tracking record for the migration named `name` as part of the
   * reversal transaction (R4.1).
   */
  deleteMigrationRecord(name: string): Promise<void>;

  /**
   * Re-inserts a previously captured tracking record during compensating
   * recovery (R6.4).
   */
  insertMigrationRecord(record: MigrationRecord): Promise<void>;
}
