// Unit tests for per-engine driver credential redaction and capability flags.
//
// Covers Task 7.5: verify `redactedTarget` strips credentials to a host-only
// (or file-path for SQLite) designation across all three drivers, verify the
// `supportsTransactionalDDL` capability flags, and verify the `engine` fields.
//
// These are pure unit tests — they only call `redactedTarget` and read the
// readonly capability/engine flags. No real database connections are opened.
//
// Requirements: 7.4 (credential-stripped, host-only target for logging),
// 4.6 (transactional-DDL capability classification), 8.5 (no raw credentials
// in output).

import { describe, it, expect } from 'vitest';

import { PostgresDriver } from '../../src/drivers/postgres-driver.js';
import { MysqlDriver } from '../../src/drivers/mysql-driver.js';
import { SqliteDriver } from '../../src/drivers/sqlite-driver.js';

describe('driver redactedTarget — credential stripping (R7.4, R8.5)', () => {
  describe('PostgresDriver', () => {
    const driver = new PostgresDriver();

    it('strips username and password, keeps host and port', () => {
      const target = driver.redactedTarget('postgresql://user:secret@host:5432/db');

      expect(target).not.toContain('user');
      expect(target).not.toContain('secret');
      expect(target).toContain('host');
      expect(target).toContain('5432');
      expect(target).toContain('/db');
    });

    it('does not leak credentials even without a port or database', () => {
      const target = driver.redactedTarget('postgresql://admin:p@ssw0rd@dbhost');

      expect(target).not.toContain('admin');
      expect(target).not.toContain('p@ssw0rd');
      expect(target).toContain('dbhost');
    });

    it('returns a safe placeholder for an unparseable URL', () => {
      const target = driver.redactedTarget('not a url with creds :secret@');

      expect(target).not.toContain('secret');
      expect(target).toBe('unknown-host');
    });
  });

  describe('MysqlDriver', () => {
    const driver = new MysqlDriver();

    it('strips username and password, keeps host and port', () => {
      const target = driver.redactedTarget('mysql://root:pw@localhost:3306/app');

      expect(target).not.toContain('root');
      expect(target).not.toContain('pw');
      expect(target).toContain('localhost');
      expect(target).toContain('3306');
      expect(target).toContain('/app');
    });

    it('produces a mysql:// prefixed, credential-free designation', () => {
      const target = driver.redactedTarget('mysql://svc:sup3r-secret@db.internal:3306/orders');

      expect(target).toMatch(/^mysql:\/\//);
      expect(target).not.toContain('svc');
      expect(target).not.toContain('sup3r-secret');
      expect(target).toContain('db.internal');
    });

    it('returns a safe placeholder for an unparseable URL', () => {
      const target = driver.redactedTarget('%%% not-a-url :secret@');

      expect(target).not.toContain('secret');
      expect(target).toBe('mysql://<redacted>');
    });
  });

  describe('SqliteDriver', () => {
    const driver = new SqliteDriver();

    it('returns a clean sqlite: file path with no credentials', () => {
      const target = driver.redactedTarget('file:./dev.db');

      expect(target).toMatch(/^sqlite:/);
      expect(target).toContain('./dev.db');
      // A file: URL carries no userinfo, but assert the scheme is not leaked raw.
      expect(target).not.toContain('file:');
    });

    it('strips a connection-string query and returns the bare file path', () => {
      const target = driver.redactedTarget('file:./dev.db?connection_limit=1');

      expect(target).toBe('sqlite:./dev.db');
      expect(target).not.toContain('connection_limit');
    });

    it('handles the in-memory designation cleanly', () => {
      const target = driver.redactedTarget(':memory:');

      expect(target).toBe('sqlite::memory:');
    });
  });
});

describe('driver supportsTransactionalDDL capability flags (R4.6)', () => {
  it('PostgresDriver supports transactional DDL', () => {
    expect(new PostgresDriver().supportsTransactionalDDL).toBe(true);
  });

  it('SqliteDriver supports transactional DDL', () => {
    expect(new SqliteDriver().supportsTransactionalDDL).toBe(true);
  });

  it('MysqlDriver does NOT support transactional DDL', () => {
    expect(new MysqlDriver().supportsTransactionalDDL).toBe(false);
  });
});

describe('driver engine fields', () => {
  it('PostgresDriver reports engine "postgresql"', () => {
    expect(new PostgresDriver().engine).toBe('postgresql');
  });

  it('MysqlDriver reports engine "mysql"', () => {
    expect(new MysqlDriver().engine).toBe('mysql');
  });

  it('SqliteDriver reports engine "sqlite"', () => {
    expect(new SqliteDriver().engine).toBe('sqlite');
  });
});
