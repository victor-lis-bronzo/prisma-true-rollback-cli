// Unit tests for the CLI argument parser dispatch behavior.
//
// Covers Task 4.4: arg dispatch classification.
//   - Single valid positional name -> { kind: 'run', args } (R1.1)
//   - --version / -v -> { kind: 'version' } regardless of other tokens (R1.7)
//   - Each recognized flag maps to the correct ParsedArgs.flags field
//   - Flag combinations parse correctly and are order-independent
//
// Requirements: 1.1, 1.7 (plus flag mapping for 2.2, 2.6, 3.4, 8.4).

import { describe, it, expect } from 'vitest';

import { DefaultArgParser, argParser } from '../../src/cli/arg-parser.js';
import type { ArgParseResult } from '../../src/models/types.js';

/** Narrowing helper: assert a 'run' result and return its args. */
function expectRun(result: ArgParseResult) {
  expect(result.kind).toBe('run');
  if (result.kind !== 'run') {
    throw new Error(`expected run, got ${result.kind}`);
  }
  return result.args;
}

describe('DefaultArgParser.parse — dispatch', () => {
  const parser = new DefaultArgParser();

  describe('single positional migration name (R1.1)', () => {
    it('returns a run result with the migration name set', () => {
      const args = expectRun(parser.parse(['20240101_init']));
      expect(args.migrationName).toBe('20240101_init');
    });

    it('defaults every flag to false when only a name is provided', () => {
      const args = expectRun(parser.parse(['20240101_init']));
      expect(args.flags).toEqual({
        version: false,
        dryRun: false,
        yes: false,
        override: false,
        verbose: false,
      });
    });

    it('exposes a shared default parser instance with the same behavior', () => {
      const args = expectRun(argParser.parse(['some_migration']));
      expect(args.migrationName).toBe('some_migration');
    });
  });

  describe('version flag short-circuit (R1.7)', () => {
    it('returns version for --version', () => {
      expect(parser.parse(['--version'])).toEqual({ kind: 'version' });
    });

    it('returns version for the -v alias', () => {
      expect(parser.parse(['-v'])).toEqual({ kind: 'version' });
    });

    it('returns version even when a positional name is also present', () => {
      expect(parser.parse(['20240101_init', '--version'])).toEqual({ kind: 'version' });
    });

    it('returns version even alongside otherwise-invalid arity (multiple positionals)', () => {
      expect(parser.parse(['a', 'b', 'c', '-v'])).toEqual({ kind: 'version' });
    });

    it('returns version even when combined with other flags', () => {
      expect(parser.parse(['--dry-run', '--verbose', '--version'])).toEqual({ kind: 'version' });
    });

    it('short-circuits before the missing-argument (flags-only) check', () => {
      // Flags-only would normally be an error, but --version wins.
      expect(parser.parse(['--version'])).toEqual({ kind: 'version' });
    });
  });

  describe('individual flag parsing', () => {
    it('parses --dry-run into flags.dryRun', () => {
      const args = expectRun(parser.parse(['m', '--dry-run']));
      expect(args.flags.dryRun).toBe(true);
      expect(args.flags.yes).toBe(false);
      expect(args.flags.override).toBe(false);
      expect(args.flags.verbose).toBe(false);
    });

    it('parses --yes into flags.yes', () => {
      const args = expectRun(parser.parse(['m', '--yes']));
      expect(args.flags.yes).toBe(true);
    });

    it('parses the -y alias into flags.yes', () => {
      const args = expectRun(parser.parse(['m', '-y']));
      expect(args.flags.yes).toBe(true);
    });

    it('parses --override into flags.override', () => {
      const args = expectRun(parser.parse(['m', '--override']));
      expect(args.flags.override).toBe(true);
    });

    it('parses --verbose into flags.verbose', () => {
      const args = expectRun(parser.parse(['m', '--verbose']));
      expect(args.flags.verbose).toBe(true);
    });
  });

  describe('flag combinations', () => {
    it('parses all flags together with the positional name', () => {
      const args = expectRun(
        parser.parse(['migration_x', '--dry-run', '--yes', '--override', '--verbose']),
      );
      expect(args.migrationName).toBe('migration_x');
      expect(args.flags).toEqual({
        version: false,
        dryRun: true,
        yes: true,
        override: true,
        verbose: true,
      });
    });

    it('parses a subset of flags, leaving the rest false', () => {
      const args = expectRun(parser.parse(['m', '--dry-run', '-y']));
      expect(args.flags).toEqual({
        version: false,
        dryRun: true,
        yes: true,
        override: false,
        verbose: false,
      });
    });
  });

  describe('order independence of flags relative to the positional', () => {
    it('parses identically whether flags precede or follow the name', () => {
      const before = expectRun(parser.parse(['--dry-run', '--verbose', 'm']));
      const after = expectRun(parser.parse(['m', '--dry-run', '--verbose']));
      expect(before).toEqual(after);
    });

    it('parses identically when flags are interleaved around the name', () => {
      const interleaved = expectRun(parser.parse(['--yes', 'm', '--override']));
      expect(interleaved.migrationName).toBe('m');
      expect(interleaved.flags.yes).toBe(true);
      expect(interleaved.flags.override).toBe(true);
      expect(interleaved.flags.dryRun).toBe(false);
      expect(interleaved.flags.verbose).toBe(false);
    });

    it('treats the sole non-flag token as the positional regardless of position', () => {
      const a = expectRun(parser.parse(['name', '--override', '--yes', '--dry-run', '--verbose']));
      const b = expectRun(parser.parse(['--override', '--yes', '--dry-run', '--verbose', 'name']));
      expect(a).toEqual(b);
      expect(a.migrationName).toBe('name');
    });
  });
});
