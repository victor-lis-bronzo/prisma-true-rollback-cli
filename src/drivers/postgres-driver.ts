/**
 * PostgreSQL implementation of the {@link DbDriver} abstraction.
 *
 * Uses the `pg` library. PostgreSQL supports transactional DDL, so DDL executed
 * inside {@link Connection.transaction} is rolled back on failure alongside DML,
 * giving the DB half of a rollback operation inherent atomicity (R4, R4.6).
 *
 * Requirement traceability:
 * - R4.1  — reverse SQL + tracking-record cleanup run inside one transaction
 *           that commits on resolve and rolls back on throw.
 * - R4.5  — a failing statement surfaces its text via a {@link StatementError}.
 * - R7.3  — a connection timeout (default {@link DEFAULT_CONNECT_TIMEOUT_MS}) is
 *           applied on {@link connect}.
 * - R7.4  — on connection failure the target is reported host-only, credentials
 *           stripped, via {@link redactedTarget}.
 * - R7.6  — {@link Connection.close} always releases the underlying client.
 * - R6.4  — recovery re-inserts a saved tracking record via
 *           {@link Tx.insertMigrationRecord}.
 */

import { Client } from 'pg';
import type { QueryResultRow } from 'pg';

import type { Connection, DbDriver, Tx } from './driver.js';
import { DEFAULT_CONNECT_TIMEOUT_MS } from './driver.js';
import type { DbEngine, MigrationRecord } from '../models/types.js';
import { StatementError } from '../models/errors.js';

/**
 * Raw shape of a `_prisma_migrations` row as returned by `pg`. Column names are
 * the canonical Prisma tracking-table columns.
 */
interface PrismaMigrationRow extends QueryResultRow {
  id: string;
  checksum: string;
  finished_at: Date | string | null;
  migration_name: string;
  logs: string | null;
  rolled_back_at: Date | string | null;
  started_at: Date | string;
  applied_steps_count: number | string;
}

/** Column list selected for tracking-record queries (order-independent, mapped by name). */
const MIGRATION_COLUMNS =
  'id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count';

/** Normalizes a timestamp column (Date | string | null) to an ISO string or null. */
function toIsoOrNull(value: Date | string | null): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  // `pg` may return timestamps as strings when a custom parser is not installed.
  const asDate = new Date(value);
  return Number.isNaN(asDate.getTime()) ? String(value) : asDate.toISOString();
}

/** Normalizes a non-nullable timestamp column to an ISO string. */
function toIso(value: Date | string): string {
  return toIsoOrNull(value) ?? new Date(0).toISOString();
}

/**
 * Maps a raw `_prisma_migrations` row to the CLI's {@link MigrationRecord}.
 *
 * Column → field mapping:
 * - `id`                  → `id`
 * - `migration_name`      → `migrationName`
 * - `checksum`            → `checksum`
 * - `finished_at`         → `finishedAt`   (ISO string | null)
 * - `started_at`          → `startedAt`    (ISO string)
 * - `applied_steps_count` → `appliedStepsCount` (number)
 * - `logs`                → `logs`         (string | null)
 * - `rolled_back_at`      → `rolledBackAt` (ISO string | null)
 */
function mapRow(row: PrismaMigrationRow): MigrationRecord {
  return {
    id: row.id,
    migrationName: row.migration_name,
    checksum: row.checksum,
    finishedAt: toIsoOrNull(row.finished_at),
    startedAt: toIso(row.started_at),
    appliedStepsCount:
      typeof row.applied_steps_count === 'number'
        ? row.applied_steps_count
        : Number(row.applied_steps_count),
    logs: row.logs,
    rolledBackAt: toIsoOrNull(row.rolled_back_at),
  };
}

/**
 * Transaction-scoped handle backed by a `pg` {@link Client}. All methods run
 * within the transaction opened by {@link PostgresConnection.transaction}.
 */
class PostgresTx implements Tx {
  constructor(private readonly client: Client) {}

  async exec(statement: string): Promise<void> {
    try {
      await this.client.query(statement);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new StatementError(statement, `Database statement failed: ${reason}`, {
        cause: err,
      });
    }
  }

  async queryLatestMigration(): Promise<MigrationRecord | null> {
    const result = await this.client.query<PrismaMigrationRow>(
      `SELECT ${MIGRATION_COLUMNS} FROM "_prisma_migrations" ORDER BY started_at DESC, id DESC LIMIT 1`
    );
    const row = result.rows[0];
    return row ? mapRow(row) : null;
  }

  async queryMigrationByName(name: string): Promise<MigrationRecord | null> {
    const result = await this.client.query<PrismaMigrationRow>(
      `SELECT ${MIGRATION_COLUMNS} FROM "_prisma_migrations" WHERE migration_name = $1 LIMIT 1`,
      [name]
    );
    const row = result.rows[0];
    return row ? mapRow(row) : null;
  }

  async deleteMigrationRecord(name: string): Promise<void> {
    await this.client.query(
      `DELETE FROM "_prisma_migrations" WHERE migration_name = $1`,
      [name]
    );
  }

  async insertMigrationRecord(record: MigrationRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO "_prisma_migrations"
         (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        record.id,
        record.checksum,
        record.finishedAt,
        record.migrationName,
        record.logs,
        record.rolledBackAt,
        record.startedAt,
        record.appliedStepsCount,
      ]
    );
  }
}

/**
 * An open PostgreSQL connection wrapping a single `pg` {@link Client}.
 * The orchestrator guarantees {@link close} is called on every path (R7.6).
 */
class PostgresConnection implements Connection {
  constructor(private readonly client: Client) {}

  async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const tx = new PostgresTx(this.client);
    await this.client.query('BEGIN');
    try {
      const result = await fn(tx);
      await this.client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await this.client.query('ROLLBACK');
      } catch {
        // Preserve and rethrow the original failure; a rollback error must not
        // mask the real cause. The connection is closed by the orchestrator.
      }
      throw err;
    }
  }

  async close(): Promise<void> {
    await this.client.end();
  }
}

/**
 * PostgreSQL {@link DbDriver}. Stateless with respect to connections:
 * {@link connect} produces a fresh {@link Connection} each call.
 */
export class PostgresDriver implements DbDriver {
  readonly engine: DbEngine = 'postgresql';
  readonly supportsTransactionalDDL = true;

  async connect(
    url: string,
    timeoutMs: number = DEFAULT_CONNECT_TIMEOUT_MS
  ): Promise<Connection> {
    const client = new Client({
      connectionString: url,
      // `pg`'s own connection timeout; we additionally race a hard timeout below
      // so the promise always rejects within `timeoutMs` (R7.3/R7.4).
      connectionTimeoutMillis: timeoutMs,
    });

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Best-effort teardown of the half-open client; ignore teardown errors.
        void client.end().catch(() => undefined);
        reject(
          new Error(
            `Connection to ${this.redactedTarget(url)} timed out after ${timeoutMs}ms`
          )
        );
      }, timeoutMs);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
    });

    try {
      await Promise.race([client.connect(), timeout]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }

    return new PostgresConnection(client);
  }

  redactedTarget(url: string): string {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname || 'unknown-host';
      const port = parsed.port ? `:${parsed.port}` : '';
      // pathname is `/dbname`; strip the leading slash. Never include userinfo.
      const db = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : '';
      return `${host}${port}${db}`;
    } catch {
      // If the URL is unparseable, avoid leaking anything that could be a credential.
      return 'unknown-host';
    }
  }
}
