/**
 * MySQL implementation of the {@link DbDriver} abstraction.
 *
 * Connects via `mysql2/promise`, applying a connection timeout (R7.3/R7.4),
 * exposes a transaction wrapper (BEGIN / COMMIT / ROLLBACK) and the
 * `_prisma_migrations` tracking-table operations the CLI needs.
 *
 * IMPORTANT — transactional DDL: MySQL performs *implicit commits* on DDL
 * statements, so DDL cannot be rolled back inside a transaction. This driver
 * therefore reports `supportsTransactionalDDL = false`. The transaction wrapper
 * below is still implemented faithfully (COMMIT on resolve, ROLLBACK on throw)
 * for the DML operations it performs (tracking-record changes), but the
 * orchestrator uses the `supportsTransactionalDDL` flag to abort *before* any
 * reverse DDL is ever executed (R4.6), avoiding an unrecoverable partial change.
 *
 * Requirement traceability:
 * - R4.1 — reverse-SQL + tracking-record cleanup run inside a single transaction.
 * - R4.5 — a failing statement surfaces its text + reason via `Tx.exec`
 *   (`StatementError`).
 * - R4.6 — `supportsTransactionalDDL = false` lets the orchestrator guard MySQL.
 * - R6.4 — recovery re-inserts the saved tracking record via `Tx`.
 * - R7.3 / R7.4 — connection timeout applied on `connect`; `redactedTarget`
 *   yields a host/port/db-only, credential-stripped designation.
 * - R7.6 — an opened connection is always closable via `Connection.close`.
 */

import mysql from 'mysql2/promise';

import type { Connection, DbDriver, Tx } from './driver.js';
import { DEFAULT_CONNECT_TIMEOUT_MS } from './driver.js';
import type { DbEngine, MigrationRecord } from '../models/types.js';
import { StatementError } from '../models/errors.js';

/**
 * The tracking table Prisma maintains for applied migrations. All record
 * operations target this fixed table name.
 */
const MIGRATIONS_TABLE = '_prisma_migrations';

/**
 * Shape of a `_prisma_migrations` row as returned by `mysql2`. Column names
 * mirror Prisma's schema for the tracking table; all are nullable at the wire
 * level except the primary key, so each is typed defensively.
 */
interface PrismaMigrationRow {
  id: string;
  checksum: string;
  migration_name: string;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  applied_steps_count: number | bigint | null;
  logs: string | null;
  rolled_back_at: Date | string | null;
}

/** Normalizes a MySQL date/datetime column into an ISO string (or `null`). */
function toIso(value: Date | string | null): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  // `mysql2` may return DATETIME columns as strings when `dateStrings` is set;
  // pass those through as-is.
  return String(value);
}

/** Maps a raw `_prisma_migrations` row onto the domain {@link MigrationRecord}. */
function rowToRecord(row: PrismaMigrationRow): MigrationRecord {
  const startedAt = toIso(row.started_at);
  return {
    id: row.id,
    migrationName: row.migration_name,
    checksum: row.checksum,
    finishedAt: toIso(row.finished_at),
    // `started_at` is NOT NULL in Prisma's schema; fall back to empty string
    // only to satisfy the non-nullable domain type if the driver ever yields null.
    startedAt: startedAt ?? '',
    appliedStepsCount: Number(row.applied_steps_count ?? 0),
    logs: row.logs,
    rolledBackAt: toIso(row.rolled_back_at),
  };
}

/**
 * Transaction-scoped handle over a `mysql2` connection. All operations run
 * within the transaction opened by {@link MysqlConnection.transaction}.
 */
class MysqlTx implements Tx {
  constructor(private readonly conn: mysql.Connection) {}

  async exec(statement: string): Promise<void> {
    try {
      await this.conn.query(statement);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new StatementError(statement, `Database statement failed: ${reason}`, {
        cause,
      });
    }
  }

  async queryLatestMigration(): Promise<MigrationRecord | null> {
    const [rows] = await this.conn.query(
      `SELECT id, checksum, migration_name, started_at, finished_at, applied_steps_count, logs, rolled_back_at
       FROM \`${MIGRATIONS_TABLE}\`
       ORDER BY started_at DESC, id DESC
       LIMIT 1`
    );
    const list = rows as PrismaMigrationRow[];
    if (list.length === 0) {
      return null;
    }
    return rowToRecord(list[0]);
  }

  async queryMigrationByName(name: string): Promise<MigrationRecord | null> {
    const [rows] = await this.conn.query(
      `SELECT id, checksum, migration_name, started_at, finished_at, applied_steps_count, logs, rolled_back_at
       FROM \`${MIGRATIONS_TABLE}\`
       WHERE migration_name = ?
       LIMIT 1`,
      [name]
    );
    const list = rows as PrismaMigrationRow[];
    if (list.length === 0) {
      return null;
    }
    return rowToRecord(list[0]);
  }

  async deleteMigrationRecord(name: string): Promise<void> {
    await this.conn.query(
      `DELETE FROM \`${MIGRATIONS_TABLE}\` WHERE migration_name = ?`,
      [name]
    );
  }

  async insertMigrationRecord(record: MigrationRecord): Promise<void> {
    await this.conn.query(
      `INSERT INTO \`${MIGRATIONS_TABLE}\`
         (id, checksum, migration_name, started_at, finished_at, applied_steps_count, logs, rolled_back_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.checksum,
        record.migrationName,
        record.startedAt,
        record.finishedAt,
        record.appliedStepsCount,
        record.logs,
        record.rolledBackAt,
      ]
    );
  }
}

/**
 * An open MySQL connection wrapping a single `mysql2` connection. The
 * orchestrator guarantees {@link close} is called on every path (R7.6).
 */
class MysqlConnection implements Connection {
  constructor(private readonly conn: mysql.Connection) {}

  async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    await this.conn.beginTransaction();
    const tx = new MysqlTx(this.conn);
    try {
      const result = await fn(tx);
      await this.conn.commit();
      return result;
    } catch (err) {
      // Best-effort rollback; the original error is always re-thrown so the
      // caller observes the true failure cause (R4).
      try {
        await this.conn.rollback();
      } catch {
        // Ignore rollback failures — surfacing the original error matters more.
      }
      throw err;
    }
  }

  async close(): Promise<void> {
    await this.conn.end();
  }
}

/**
 * MySQL driver. Stateless with respect to connections: {@link connect} produces
 * a fresh {@link Connection} on each call.
 */
export class MysqlDriver implements DbDriver {
  readonly engine: DbEngine = 'mysql';

  /**
   * MySQL performs implicit commits on DDL, so DDL cannot be rolled back. This
   * flag lets the orchestrator abort before executing any reverse SQL (R4.6).
   */
  readonly supportsTransactionalDDL = false;

  async connect(
    url: string,
    timeoutMs: number = DEFAULT_CONNECT_TIMEOUT_MS
  ): Promise<Connection> {
    // `connectTimeout` bounds establishing the underlying socket/handshake
    // (R7.3/R7.4). `mysql2` rejects `createConnection`'s promise on timeout.
    const conn = await mysql.createConnection({
      uri: url,
      connectTimeout: timeoutMs,
    });
    return new MysqlConnection(conn);
  }

  redactedTarget(url: string): string {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname || 'unknown-host';
      const port = parsed.port ? `:${parsed.port}` : '';
      // Path is `/dbname`; strip the leading slash. Empty when absent.
      const db = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : '';
      return `mysql://${host}${port}${db}`;
    } catch {
      // Never surface a raw, potentially credential-bearing URL on parse failure.
      return 'mysql://<redacted>';
    }
  }
}
