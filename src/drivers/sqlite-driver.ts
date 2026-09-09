/**
 * SQLite implementation of the {@link DbDriver} abstraction.
 *
 * SQLite is a local, file-based engine, so "connecting" means opening the
 * database file resolved from the connection URL and there is effectively no
 * network handshake to time out. We still honor the {@link DbDriver.connect}
 * signature and apply the supplied timeout as a SQLite *busy timeout* (the
 * milliseconds SQLite will wait for a lock before erroring), which is the
 * closest local-file analogue.
 *
 * SQLite supports transactional DDL — `CREATE`/`ALTER`/`DROP` statements
 * participate in the surrounding transaction and are rolled back on failure —
 * so {@link SqliteDriver.supportsTransactionalDDL} is `true` and reverse-SQL +
 * tracking-record cleanup run atomically (R4.1).
 *
 * `better-sqlite3` is a synchronous binding; every method wraps its synchronous
 * work in a `Promise` so the async {@link DbDriver}/{@link Connection}/{@link Tx}
 * contract is satisfied.
 *
 * Requirement traceability:
 * - R4.1 — reverse SQL + tracking-record delete run in a single transaction that
 *   commits on success and rolls back on any failure.
 * - R4.5 — a failing statement rejects with a {@link StatementError} carrying the
 *   exact statement text and the underlying reason.
 * - R6.4 — {@link Tx.insertMigrationRecord} re-inserts a captured tracking record
 *   during compensating recovery.
 * - R7.3 — the supplied timeout is honored (as a SQLite busy timeout).
 * - R7.4 / R8.5 — {@link SqliteDriver.redactedTarget} returns a clean, credential-free
 *   file designation.
 * - R7.6 — {@link Connection.close} closes the underlying database handle.
 */

import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import type { DbEngine, MigrationRecord } from '../models/types.js';
import { StatementError } from '../models/errors.js';
import type { Connection, DbDriver, Tx } from './driver.js';

/** Row shape of the Prisma `_prisma_migrations` tracking table (snake_case columns). */
interface PrismaMigrationRow {
  id: string;
  checksum: string;
  finished_at: string | null;
  migration_name: string;
  logs: string | null;
  rolled_back_at: string | null;
  started_at: string;
  applied_steps_count: number;
}

/**
 * Maps a raw `_prisma_migrations` row to the CLI's {@link MigrationRecord}
 * (snake_case DB columns → camelCase model fields).
 */
function rowToRecord(row: PrismaMigrationRow): MigrationRecord {
  return {
    id: row.id,
    migrationName: row.migration_name,
    checksum: row.checksum,
    finishedAt: row.finished_at,
    startedAt: row.started_at,
    appliedStepsCount: row.applied_steps_count,
    logs: row.logs,
    rolledBackAt: row.rolled_back_at,
  };
}

/**
 * Resolves a SQLite connection URL to a filesystem path.
 *
 * Accepts both `file:`-scheme URLs (e.g. `file:./dev.db`, `file:/abs/dev.db`,
 * `file://host/dev.db`) and plain paths (e.g. `./dev.db`, `/abs/dev.db`), as
 * well as the special in-memory designation `:memory:`.
 */
function resolveSqlitePath(url: string): string {
  const trimmed = url.trim();

  if (trimmed === ':memory:') {
    return ':memory:';
  }

  if (trimmed.startsWith('file:')) {
    // Absolute file URLs (file:/... or file://...) can be resolved by the URL
    // machinery. Relative ones (file:./dev.db, file:dev.db) cannot, so strip
    // the scheme and any query string manually.
    if (trimmed.startsWith('file://') || /^file:\/[^/]/.test(trimmed)) {
      try {
        return fileURLToPath(trimmed);
      } catch {
        // Fall through to manual stripping below.
      }
    }
    const withoutScheme = trimmed.slice('file:'.length);
    // Drop any connection-string query parameters (e.g. ?connection_limit=1).
    const queryIndex = withoutScheme.indexOf('?');
    return queryIndex === -1 ? withoutScheme : withoutScheme.slice(0, queryIndex);
  }

  // Plain path — still strip a trailing query string defensively.
  const queryIndex = trimmed.indexOf('?');
  return queryIndex === -1 ? trimmed : trimmed.slice(0, queryIndex);
}

/**
 * A transaction-scoped handle backed by a synchronous `better-sqlite3` database.
 *
 * All statements execute against the connection's single database handle; the
 * BEGIN/COMMIT/ROLLBACK framing is managed by {@link SqliteConnection.transaction}.
 */
class SqliteTx implements Tx {
  constructor(private readonly db: Database.Database) {}

  exec(statement: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      try {
        this.db.exec(statement);
        resolve();
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        reject(new StatementError(statement, `Database statement failed: ${reason}`, { cause }));
      }
    });
  }

  queryLatestMigration(): Promise<MigrationRecord | null> {
    return new Promise<MigrationRecord | null>((resolve, reject) => {
      try {
        const row = this.db
          .prepare(
            `SELECT id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count
             FROM _prisma_migrations
             ORDER BY started_at DESC, migration_name DESC
             LIMIT 1`
          )
          .get() as PrismaMigrationRow | undefined;
        resolve(row ? rowToRecord(row) : null);
      } catch (cause) {
        reject(cause);
      }
    });
  }

  queryMigrationByName(name: string): Promise<MigrationRecord | null> {
    return new Promise<MigrationRecord | null>((resolve, reject) => {
      try {
        const row = this.db
          .prepare(
            `SELECT id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count
             FROM _prisma_migrations
             WHERE migration_name = ?
             ORDER BY started_at DESC
             LIMIT 1`
          )
          .get(name) as PrismaMigrationRow | undefined;
        resolve(row ? rowToRecord(row) : null);
      } catch (cause) {
        reject(cause);
      }
    });
  }

  deleteMigrationRecord(name: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      try {
        this.db.prepare(`DELETE FROM _prisma_migrations WHERE migration_name = ?`).run(name);
        resolve();
      } catch (cause) {
        reject(cause);
      }
    });
  }

  insertMigrationRecord(record: MigrationRecord): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      try {
        this.db
          .prepare(
            `INSERT INTO _prisma_migrations
               (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
             VALUES
               (@id, @checksum, @finishedAt, @migrationName, @logs, @rolledBackAt, @startedAt, @appliedStepsCount)`
          )
          .run({
            id: record.id,
            checksum: record.checksum,
            finishedAt: record.finishedAt,
            migrationName: record.migrationName,
            logs: record.logs,
            rolledBackAt: record.rolledBackAt,
            startedAt: record.startedAt,
            appliedStepsCount: record.appliedStepsCount,
          });
        resolve();
      } catch (cause) {
        reject(cause);
      }
    });
  }
}

/**
 * An open SQLite connection wrapping a synchronous `better-sqlite3` handle.
 */
class SqliteConnection implements Connection {
  constructor(private readonly db: Database.Database) {}

  async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const tx = new SqliteTx(this.db);
    this.db.exec('BEGIN');
    try {
      const result = await fn(tx);
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      // Roll back to restore the pre-transaction state (R4.4), then re-throw
      // the original error so the caller observes it (R4).
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // If ROLLBACK itself fails (e.g. no transaction is active), surface the
        // original error rather than masking it.
      }
      throw error;
    }
  }

  close(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      try {
        this.db.close();
        resolve();
      } catch (cause) {
        reject(cause);
      }
    });
  }
}

/**
 * SQLite {@link DbDriver}. Opens a local database file and runs the CLI's
 * reversal/recovery operations within a single transaction.
 */
export class SqliteDriver implements DbDriver {
  readonly engine: DbEngine = 'sqlite';
  readonly supportsTransactionalDDL = true;

  connect(url: string, timeoutMs: number): Promise<Connection> {
    return new Promise<Connection>((resolve, reject) => {
      try {
        const filePath = resolveSqlitePath(url);
        const db = new Database(filePath);
        // No network handshake for local files; apply the caller's timeout as a
        // busy timeout — the ms SQLite waits for a lock before erroring (R7.3).
        if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
          db.pragma(`busy_timeout = ${Math.floor(timeoutMs)}`);
        }
        resolve(new SqliteConnection(db));
      } catch (cause) {
        reject(cause);
      }
    });
  }

  redactedTarget(url: string): string {
    // SQLite URLs carry no credentials, but still return a clean file
    // designation (never the raw URL/query string) for logging (R7.4/R8.5).
    try {
      return `sqlite:${resolveSqlitePath(url)}`;
    } catch {
      return 'sqlite:<unknown>';
    }
  }
}
