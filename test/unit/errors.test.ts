// Unit tests for the typed error classes.
//
// Covers Task 2.3: verify each error class preserves its detail fields, is a
// proper `Error` subclass, and carries the correct `.name`.
//
// Requirements: 4.5 (failing statement + reason on abort), plus the broader
// error-model surface used for exit-code mapping and messaging.

import { describe, it, expect } from 'vitest';

import {
  RollbackError,
  ConfigError,
  UnsupportedEngineError,
  ReverseSqlError,
  TransactionAbortedError,
  UnsupportedDdlError,
  SnapshotError,
  FsDeleteError,
  RestoreError,
  StatementError,
  SUPPORTED_ENGINES,
} from '../../src/models/errors.js';

describe('error classes', () => {
  describe('TransactionAbortedError', () => {
    it('retains the failing statement and reason', () => {
      const err = new TransactionAbortedError('DROP TABLE "User";', 'relation does not exist');

      expect(err.failingStatement).toBe('DROP TABLE "User";');
      expect(err.reason).toBe('relation does not exist');
    });

    it('includes the failing statement and reason in the message (R4.5)', () => {
      const err = new TransactionAbortedError('ALTER TABLE t DROP COLUMN c;', 'permission denied');

      expect(err.message).toContain('ALTER TABLE t DROP COLUMN c;');
      expect(err.message).toContain('permission denied');
    });

    it('preserves the underlying cause', () => {
      const cause = new Error('root cause');
      const err = new TransactionAbortedError('SELECT 1;', 'boom', { cause });

      expect(err.cause).toBe(cause);
    });

    it('is a proper Error subclass with the correct name', () => {
      const err = new TransactionAbortedError('SELECT 1;', 'boom');

      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(RollbackError);
      expect(err).toBeInstanceOf(TransactionAbortedError);
      expect(err.name).toBe('TransactionAbortedError');
    });
  });

  describe('UnsupportedEngineError', () => {
    it('retains the engine and supported engines', () => {
      const err = new UnsupportedEngineError('oracle');

      expect(err.engine).toBe('oracle');
      expect(err.supportedEngines).toEqual(SUPPORTED_ENGINES);
    });

    it('accepts an explicit supported-engines list', () => {
      const supported = ['postgresql', 'sqlite'] as const;
      const err = new UnsupportedEngineError('mongodb', supported);

      expect(err.engine).toBe('mongodb');
      expect(err.supportedEngines).toEqual(supported);
    });

    it('names the engine and lists supported engines in its message (R7.5)', () => {
      const err = new UnsupportedEngineError('oracle');

      expect(err.message).toContain('oracle');
      for (const engine of SUPPORTED_ENGINES) {
        expect(err.message).toContain(engine);
      }
    });

    it('is a proper Error subclass with the correct name', () => {
      const err = new UnsupportedEngineError('oracle');

      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(RollbackError);
      expect(err).toBeInstanceOf(UnsupportedEngineError);
      expect(err.name).toBe('UnsupportedEngineError');
    });
  });

  describe('ConfigError', () => {
    it('retains the missing source (schema.prisma)', () => {
      const err = new ConfigError('schema.prisma');

      expect(err.missingSource).toBe('schema.prisma');
      expect(err.message).toBeTruthy();
    });

    it('retains the missing source (DATABASE_URL)', () => {
      const err = new ConfigError('DATABASE_URL');

      expect(err.missingSource).toBe('DATABASE_URL');
    });

    it('is a proper Error subclass with the correct name', () => {
      const err = new ConfigError('schema.prisma');

      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(RollbackError);
      expect(err).toBeInstanceOf(ConfigError);
      expect(err.name).toBe('ConfigError');
    });
  });

  describe('StatementError', () => {
    it('retains the statement text', () => {
      const err = new StatementError('DROP INDEX idx;');

      expect(err.statement).toBe('DROP INDEX idx;');
      expect(err.message).toContain('DROP INDEX idx;');
    });

    it('preserves the underlying cause', () => {
      const cause = new Error('syntax error');
      const err = new StatementError('BAD SQL', undefined, { cause });

      expect(err.cause).toBe(cause);
    });

    it('is a proper Error subclass with the correct name', () => {
      const err = new StatementError('SELECT 1;');

      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(RollbackError);
      expect(err).toBeInstanceOf(StatementError);
      expect(err.name).toBe('StatementError');
    });
  });

  describe('FsDeleteError', () => {
    it('retains the folder path and permission flag', () => {
      const err = new FsDeleteError('/migrations/20240101_init', undefined, {
        isPermissionError: true,
      });

      expect(err.folderPath).toBe('/migrations/20240101_init');
      expect(err.isPermissionError).toBe(true);
    });

    it('defaults isPermissionError to false', () => {
      const err = new FsDeleteError('/migrations/x');

      expect(err.folderPath).toBe('/migrations/x');
      expect(err.isPermissionError).toBe(false);
    });

    it('preserves the underlying cause', () => {
      const cause = new Error('EACCES');
      const err = new FsDeleteError('/migrations/x', undefined, { cause, isPermissionError: true });

      expect(err.cause).toBe(cause);
    });

    it('is a proper Error subclass with the correct name', () => {
      const err = new FsDeleteError('/migrations/x');

      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(RollbackError);
      expect(err).toBeInstanceOf(FsDeleteError);
      expect(err.name).toBe('FsDeleteError');
    });
  });

  describe('ReverseSqlError', () => {
    it('carries its documented rawSql field', () => {
      const err = new ReverseSqlError(undefined, { rawSql: '-- only a comment\n' });

      expect(err.rawSql).toBe('-- only a comment\n');
      expect(err.message).toBeTruthy();
    });

    it('preserves the underlying cause', () => {
      const cause = new Error('parse failure');
      const err = new ReverseSqlError('empty', { cause });

      expect(err.cause).toBe(cause);
    });

    it('is a proper Error subclass with the correct name', () => {
      const err = new ReverseSqlError();

      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(RollbackError);
      expect(err).toBeInstanceOf(ReverseSqlError);
      expect(err.name).toBe('ReverseSqlError');
    });
  });

  describe('SnapshotError', () => {
    it('carries its documented folderPath field', () => {
      const err = new SnapshotError(undefined, { folderPath: '/migrations/snap' });

      expect(err.folderPath).toBe('/migrations/snap');
      expect(err.message).toBeTruthy();
    });

    it('preserves the underlying cause', () => {
      const cause = new Error('io error');
      const err = new SnapshotError('capture failed', { cause });

      expect(err.cause).toBe(cause);
    });

    it('is a proper Error subclass with the correct name', () => {
      const err = new SnapshotError();

      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(RollbackError);
      expect(err).toBeInstanceOf(SnapshotError);
      expect(err.name).toBe('SnapshotError');
    });
  });

  describe('RestoreError', () => {
    it('carries its documented folderPath field', () => {
      const err = new RestoreError(undefined, { folderPath: '/migrations/restore' });

      expect(err.folderPath).toBe('/migrations/restore');
      expect(err.message).toBeTruthy();
    });

    it('preserves the underlying cause', () => {
      const cause = new Error('restore io error');
      const err = new RestoreError('restore failed', { cause });

      expect(err.cause).toBe(cause);
    });

    it('is a proper Error subclass with the correct name', () => {
      const err = new RestoreError();

      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(RollbackError);
      expect(err).toBeInstanceOf(RestoreError);
      expect(err.name).toBe('RestoreError');
    });
  });

  describe('UnsupportedDdlError', () => {
    it('carries its documented engine field', () => {
      const err = new UnsupportedDdlError('mysql');

      expect(err.engine).toBe('mysql');
      expect(err.message).toContain('mysql');
    });

    it('preserves the underlying cause', () => {
      const cause = new Error('implicit commit');
      const err = new UnsupportedDdlError('mysql', { cause });

      expect(err.cause).toBe(cause);
    });

    it('is a proper Error subclass with the correct name', () => {
      const err = new UnsupportedDdlError('mysql');

      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(RollbackError);
      expect(err).toBeInstanceOf(UnsupportedDdlError);
      expect(err.name).toBe('UnsupportedDdlError');
    });
  });
});
