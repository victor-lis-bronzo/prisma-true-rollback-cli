/**
 * CLI Entrypoint / Argument Parser.
 *
 * Parses `argv`, handles the version flag (R1.7), and enforces the arity rules
 * for the migration-name argument (R1.1–R1.3). This component performs no
 * side effects: it only classifies the argument vector into an `ArgParseResult`
 * that the entrypoint acts on.
 *
 * Recognized flags:
 *   --version / -v   R1.7  request the CLI version (short-circuits everything)
 *   --dry-run        R3.4  print reverse SQL and exit without changes
 *   --yes / -y       R2.6  non-interactive confirmation
 *   --override       R2.2  authorize an ambiguous environment
 *   --verbose        R8.4  verbose (redacted) output
 *
 * Arity rules:
 *   exactly one positional migration name → { kind: 'run', args }        (R1.1)
 *   zero positional (flags only)          → { kind: 'error', ... }       (R1.2)
 *   more than one positional              → { kind: 'error', ... }       (R1.3)
 *   --version present                     → { kind: 'version' }          (R1.7)
 *
 * Requirement traceability: 1.1, 1.2, 1.3, 1.7, 2.2, 2.6, 3.4, 8.4.
 */

import type { ArgParseResult, ParsedArgs } from '../models/types.js';

/**
 * Set of tokens recognized as the version flag. When any of these appears
 * anywhere in `argv`, parsing short-circuits to `{ kind: 'version' }` before
 * any other validation (R1.7).
 */
const VERSION_FLAGS = new Set(['--version', '-v']);

/**
 * Maps every recognized non-version flag token to the `ParsedArgs.flags`
 * field it sets. Tokens absent from this map (and not a version flag) are
 * treated as positional arguments.
 */
const FLAG_ALIASES: Record<string, keyof ParsedArgs['flags']> = {
  '--dry-run': 'dryRun',
  '--yes': 'yes',
  '-y': 'yes',
  '--override': 'override',
  '--verbose': 'verbose',
};

/** Parses an argument vector into a discriminated `ArgParseResult`. */
export interface ArgParser {
  parse(argv: string[]): ArgParseResult;
}

/**
 * Concrete argument parser. Stateless — a single shared instance may be reused,
 * but `parse` never mutates instance state.
 */
export class DefaultArgParser implements ArgParser {
  parse(argv: string[]): ArgParseResult {
    // R1.7: --version short-circuits before any other check, including the
    // arity rules. A version request is valid regardless of positional args.
    if (argv.some((token) => VERSION_FLAGS.has(token))) {
      return { kind: 'version' };
    }

    const flags: ParsedArgs['flags'] = {
      version: false,
      dryRun: false,
      yes: false,
      override: false,
      verbose: false,
    };

    const positionals: string[] = [];

    for (const token of argv) {
      const flagField = FLAG_ALIASES[token];
      if (flagField !== undefined) {
        flags[flagField] = true;
      } else {
        positionals.push(token);
      }
    }

    // R1.2: no positional migration-name argument (flags only).
    if (positionals.length === 0) {
      return {
        kind: 'error',
        message:
          'Missing required migration-name argument. ' +
          'Provide exactly one migration name to roll back.',
        exitCode: 1,
      };
    }

    // R1.3: more than one positional migration-name argument.
    if (positionals.length > 1) {
      return {
        kind: 'error',
        message:
          `Received ${positionals.length} migration names ` +
          `(${positionals.join(', ')}), but only one migration name ` +
          'is accepted per invocation.',
        exitCode: 1,
      };
    }

    // R1.1: exactly one positional migration name → run.
    const args: ParsedArgs = {
      migrationName: positionals[0],
      flags,
    };
    return { kind: 'run', args };
  }
}

/** Shared default parser instance. */
export const argParser: ArgParser = new DefaultArgParser();
