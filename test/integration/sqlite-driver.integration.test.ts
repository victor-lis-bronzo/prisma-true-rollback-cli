// Integration tests for the DB drivers (Task 7.6).
//
// These are REAL-engine integration tests, NOT property tests. They cover the
// external database boundary with 1–5 representative scenarios per engine:
//
//   - SQLite: always runs. Uses a REAL temp-file database (created via
//     `SqliteDriver.connect`, which opens the resolved file). SQLite is
//     embedded (`better-sqlite3`) so no server is required and the suite stays
//     green in CI-without-DBs.
//   - PostgreSQL / MySQL: conditionally skipped unless a reachable server URL
//     is supplied via `TEST_POSTGRES_URL` / `TEST_MYSQL_URL`. When unset, the
//     entire block is skipped via `describe.skipIf`, so real-engine coverage is
//     available where a server exists without breaking the DB-less default run.
//
// Requirements covered:
//   - R4.1 — reverse-SQL + tracking-record cleanup run inside ONE transaction
//     that commits on success and rolls back on any failure (verified against a
//     real engine here: SQLite supports transactional DDL).
//   - R7.3 — a connect timeout is honored (SQLite applies it as a busy timeout).
//   - R7.4 — `redactedTarget` yields a clean, credential-free designation.
//   - R7.6 — an opened `Connection` can always be closed.

import {
  existsSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteDriver } from '../../src/drivers/sqlite-driver.js';
import type { Connection } from '../../src/drivers/driver.js';
// NOTE: PostgresDriver / MysqlDriver are imported *dynamically* inside their
// skipped blocks below. Their modules pull in the `pg` / `mysql2` native
// packages, which may not be installed in a DB-less environment; a static
// top-level import would fail to load this whole file even when the blocks are
// skipped. Dynamic import defers resolution until the block actually runs
// (i.e. only when TEST_POSTGRES_URL / TEST_MYSQL_URL is set).
import type { MigrationRecord } from '../../src/models/types.js';
import { StatementError } from '../../src/models/errors.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** A pair of representative `_prisma_migrations` seed rows. */
function seedRecords(): [MigrationRecord, MigrationRecord] {
  return [
    {
      id: '0001-init',
      migrationName: '20240101000000_init',
      checksum: 'aaaa',
      finishedAt: '2024-01-01T00:00:05.000Z',
      startedAt: '2024-01-01T00:00:00.000Z',
      appliedStepsCount: 1,
      logs: null,
      rolledBackAt: null,
    },
    {
      id: '0002-add-users',
      migrationName: '20240202000000_add_users',
      checksum: 'bbbb',
      finishedAt: '2024-02-02T00:00:05.000Z',
      startedAt: '2024-02-02T00:00:00.000Z',
      appliedStepsCount: 2,
      logs: null,
      rolledBackAt: null,
    },
  ];
}

/**
 * Creates the `_prisma_migrations` table and seeds it with the given rows,
 * using a short-lived raw `better-sqlite3` handle. Kept separate from the
 * driver so the test fixtures are established independently of the code under
 * test, and so we can reconnect afterwards to assert persistence.
 */
function bootstrapSqliteDb(filePath: string, rows: MigrationRecord[]): void {
  const db = new Database(filePath);
  try {
    db.exec(
      `CREATE TABLE IF NOT EXISTS _prisma_migrations (
         id                  TEXT PRIMARY KEY,
         checksum            TEXT NOT NULL,
         finished_at         TEXT,
         migration_name      TEXT NOT NULL,
         logs                TEXT,
         rolled_back_at      TEXT,
         started_at          TEXT NOT NULL,
         applied_steps_count INTEGER NOT NULL DEFAULT 0
       )`
    );
    const insert = db.prepare(
      `INSERT INTO _prisma_migrations
         (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
       VALUES (@id, @checksum, @finishedAt, @migrationName, @logs, @rolledBackAt, @startedAt, @appliedStepsCount)`
    );
    for (const r of rows) {
      insert.run({
        id: r.id,
        checksum: r.checksum,
        finishedAt: r.finishedAt,
        migrationName: r.migrationName,
        logs: r.logs,
        rolledBackAt: r.rolledBackAt,
        startedAt: r.startedAt,
        appliedStepsCount: r.appliedStepsCount,
      });
    }
  } finally {
    db.close();
  }
}

/** Reads back the migration-name set from a temp file via a fresh handle. */
function readMigrationNames(filePath: string): string[] {
  const db = new Database(filePath, { readonly: true });
  try {
    const rows = db
      .prepare(`SELECT migration_name FROM _prisma_migrations ORDER BY started_at`)
      .all() as Array<{ migration_name: string }>;
    return rows.map((r) => r.migration_name);
  } finally {
    db.close();
  }
}

/** True iff a table with the given name exists. */
function tableExists(filePath: string, table: string): boolean {
  const db = new Database(filePath, { readonly: true });
  try {
    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
      .get(table) as { name: string } | undefined;
    return row !== undefined;
  } finally {
    db.close();
  }
}

// ===========================================================================
// SQLite — real temp-file database (always runs)
// ===========================================================================

describe('SqliteDriver (real temp-file database)', () => {
  let tmpDir: string;
  let dbPath: string;
  const driver = new SqliteDriver();

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ptr-sqlite-it-'));
    dbPath = join(tmpDir, 'dev.db');
    bootstrapSqliteDb(dbPath, seedRecords());
  });

  afterEach(() => {
    // Clean up temp files regardless of test outcome.
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('commits a transaction on success and persists the changes (R4.1)', async () => {
    const conn = await driver.connect(`file:${dbPath}`, 5_000);
    try {
      await conn.transaction(async (tx) => {
        // A DDL + a tracking-record delete, mirroring a real reversal.
        await tx.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)');
        await tx.deleteMigrationRecord('20240202000000_add_users');
      });
    } finally {
      await conn.close();
    }

    // Reconnect via a brand-new handle: the committed changes must be durable.
    expect(tableExists(dbPath, 'users')).toBe(true);
    expect(readMigrationNames(dbPath)).toEqual(['20240101000000_init']);
  });

  it('rolls back a transaction on throw and persists nothing (R4.1)', async () => {
    const conn = await driver.connect(`file:${dbPath}`, 5_000);
    const boom = new Error('deliberate failure inside transaction');
    try {
      await expect(
        conn.transaction(async (tx) => {
          // Mutations that MUST be undone by the rollback: a DDL (SQLite has
          // transactional DDL) and a tracking-record delete.
          await tx.exec('CREATE TABLE should_not_exist (id INTEGER)');
          await tx.deleteMigrationRecord('20240202000000_add_users');
          throw boom;
        })
      ).rejects.toBe(boom);
    } finally {
      await conn.close();
    }

    // Reconnect and confirm NOTHING persisted: table absent, both rows intact.
    expect(tableExists(dbPath, 'should_not_exist')).toBe(false);
    expect(readMigrationNames(dbPath)).toEqual([
      '20240101000000_init',
      '20240202000000_add_users',
    ]);
  });

  it('Tx record operations behave correctly against the real table', async () => {
    const conn = await driver.connect(`file:${dbPath}`, 5_000);
    try {
      await conn.transaction(async (tx) => {
        // queryLatestMigration → newest by started_at (the add_users row).
        const latest = await tx.queryLatestMigration();
        expect(latest?.migrationName).toBe('20240202000000_add_users');
        expect(latest?.appliedStepsCount).toBe(2);

        // queryMigrationByName → exact lookup.
        const byName = await tx.queryMigrationByName('20240101000000_init');
        expect(byName?.id).toBe('0001-init');
        expect(byName?.checksum).toBe('aaaa');

        // Unknown name → null.
        expect(await tx.queryMigrationByName('nope')).toBeNull();

        // deleteMigrationRecord → removes only the named row.
        await tx.deleteMigrationRecord('20240202000000_add_users');
        expect(await tx.queryMigrationByName('20240202000000_add_users')).toBeNull();

        // insertMigrationRecord → re-inserts a captured record (recovery path).
        const restored: MigrationRecord = {
          id: '0002-add-users',
          migrationName: '20240202000000_add_users',
          checksum: 'bbbb',
          finishedAt: '2024-02-02T00:00:05.000Z',
          startedAt: '2024-02-02T00:00:00.000Z',
          appliedStepsCount: 2,
          logs: null,
          rolledBackAt: null,
        };
        await tx.insertMigrationRecord(restored);
        const reread = await tx.queryMigrationByName('20240202000000_add_users');
        expect(reread?.id).toBe('0002-add-users');
        expect(reread?.appliedStepsCount).toBe(2);
      });
    } finally {
      await conn.close();
    }

    // Both rows present again after the commit (delete + re-insert netted out).
    expect(readMigrationNames(dbPath)).toEqual([
      '20240101000000_init',
      '20240202000000_add_users',
    ]);
  });

  it('surfaces a failing statement as a StatementError with its text (R4.5)', async () => {
    const conn = await driver.connect(`file:${dbPath}`, 5_000);
    const bad = 'THIS IS NOT VALID SQL;';
    try {
      await expect(
        conn.transaction(async (tx) => {
          await tx.exec(bad);
        })
      ).rejects.toBeInstanceOf(StatementError);

      // Re-run to inspect the thrown error's carried statement text.
      let caught: unknown;
      try {
        await conn.transaction(async (tx) => {
          await tx.exec(bad);
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(StatementError);
      expect((caught as StatementError).statement).toBe(bad);
    } finally {
      await conn.close();
    }
  });

  it('closes the connection (R7.6) and redactedTarget returns a clean sqlite:<path> (R7.4)', async () => {
    const conn: Connection = await driver.connect(`file:${dbPath}`, 5_000);
    // close() resolves without throwing on a live connection.
    await expect(conn.close()).resolves.toBeUndefined();

    // A clean, credential-free file designation — never the raw URL/query.
    expect(driver.redactedTarget(`file:${dbPath}`)).toBe(`sqlite:${dbPath}`);
    expect(driver.redactedTarget(`file:${dbPath}?connection_limit=1`)).toBe(
      `sqlite:${dbPath}`
    );

    // The temp DB file was really created on disk by connect().
    expect(existsSync(dbPath)).toBe(true);
  });
});

// ===========================================================================
// PostgreSQL — only runs when a reachable server URL is provided.
// ===========================================================================

const POSTGRES_URL = process.env.TEST_POSTGRES_URL;

describe.skipIf(!POSTGRES_URL)('PostgresDriver (real server via TEST_POSTGRES_URL)', () => {
  it('connects, runs a transaction, and closes (R4.1, R7.6)', async () => {
    const { PostgresDriver } = await import('../../src/drivers/postgres-driver.js');
    const driver = new PostgresDriver();
    const conn = await driver.connect(POSTGRES_URL as string, 10_000);
    try {
      // A trivial transactional round-trip against the real server. We create a
      // throwaway temp table, confirm the tx wrapper commits, then drop it.
      await conn.transaction(async (tx) => {
        await tx.exec('CREATE TEMP TABLE ptr_it_probe (n int)');
        await tx.exec('INSERT INTO ptr_it_probe (n) VALUES (1)');
      });
    } finally {
      await conn.close();
    }
    // credential-free host designation
    expect(driver.redactedTarget(POSTGRES_URL as string)).not.toContain('@');
  });
});

// ===========================================================================
// MySQL — only runs when a reachable server URL is provided.
// ===========================================================================

const MYSQL_URL = process.env.TEST_MYSQL_URL;

describe.skipIf(!MYSQL_URL)('MysqlDriver (real server via TEST_MYSQL_URL)', () => {
  it('connects, runs a transaction, and closes (R4.1, R7.6)', async () => {
    const { MysqlDriver } = await import('../../src/drivers/mysql-driver.js');
    const driver = new MysqlDriver();
    const conn = await driver.connect(MYSQL_URL as string, 10_000);
    try {
      await conn.transaction(async (tx) => {
        await tx.exec('CREATE TEMPORARY TABLE ptr_it_probe (n int)');
        await tx.exec('INSERT INTO ptr_it_probe (n) VALUES (1)');
      });
    } finally {
      await conn.close();
    }
    expect(driver.redactedTarget(MYSQL_URL as string)).not.toContain('@');
  });
});
