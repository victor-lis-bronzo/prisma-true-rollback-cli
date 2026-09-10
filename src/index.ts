#!/usr/bin/env node
/**
 * prisma-true-rollback — npx entrypoint (Task 15.1; design.md §"CLI Entrypoint /
 * Argument Parser", §1 "CLI Entrypoint / Argument Parser", §11 "Rollback
 * Orchestrator", and §"Error Handling").
 *
 * This module wires the previously built, single-responsibility components into
 * the executable the `prisma-true-rollback` bin resolves to:
 *
 *   1. Parse argv          — {@link argParser} (kinds: run | version | error).
 *   2. Resolve config      — {@link ConfigResolver} (schema.prisma + DATABASE_URL).
 *   3. Guard environment   — {@link EnvironmentGuard} (classify + evaluate).
 *   4. Select driver       — engine → Postgres/MySQL/SQLite driver.
 *   5. Delegate            — {@link RollbackOrchestrator}.run(args, cfg, driver).
 *
 * All pre-orchestrator failures print a redacted message to stderr and return a
 * non-zero exit code *before any operation*, and every user-facing message
 * routes through the {@link ConsoleLogger} (or, for errors that occur before the
 * logger's verbosity is known, through the shared {@link redact} helper) so
 * connection credentials never leak (R8.5).
 *
 * Requirement traceability:
 *   - R1.1  invocation surface (exactly one migration name → run).
 *   - R1.2  missing migration-name argument → stderr + exit 1.
 *   - R1.3  more than one migration name → stderr + exit 1.
 *   - R1.7  --version → print version, exit 0, no operation.
 *   - R2.1  production indicator → block, non-zero, no changes.
 *   - R2.2  ambiguous environment without override → block, non-zero, no changes.
 *   - R7.1  resolve engine + connection from schema.prisma + DATABASE_URL.
 *   - R7.2  missing schema / empty DATABASE_URL → stderr + exit 1.
 *   - R7.3/R7.4  connection timeout + redacted target (handled by the orchestrator).
 *   - R7.5  unsupported engine → stderr + exit 1.
 *   - R7.6  connection always closed (guaranteed by the orchestrator's finally).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { argParser } from './cli/arg-parser.js';
import { ConfigResolver } from './config/config-resolver.js';
import type { DbDriver } from './drivers/driver.js';
import { EnvironmentGuard } from './env/environment-guard.js';
import { ConsoleLogger } from './logger/logger.js';
import { redact } from './logger/redactor.js';
import { ConfigError, UnsupportedEngineError } from './models/errors.js';
import { RollbackOrchestrator } from './orchestrator/rollback-orchestrator.js';
import type { DbEngine, ParsedArgs, ResolvedConfig } from './models/types.js';

/** Non-zero exit code used for every pre-orchestrator failure (R1.2/1.3, R7.2/7.5). */
const EXIT_FAILURE = 1;
/** Exit code for a successful, no-op terminal action (--version, R1.7). */
const EXIT_OK = 0;

/**
 * Lazily construct the concrete {@link DbDriver} for a resolved {@link DbEngine}.
 *
 * The engine value is already constrained to the supported set by the
 * {@link ConfigResolver} (anything else throws {@link UnsupportedEngineError}),
 * so this map is total over the values that can reach it.
 *
 * Each driver module is loaded via a dynamic `import()` *only when its engine is
 * actually selected*. This is deliberate: the driver modules statically depend
 * on native/optional client libraries (`pg`, `mysql2`, `better-sqlite3`), and
 * loading them eagerly at entrypoint import time would make a terminal action
 * (`--version`, R1.7) or any pre-driver failure (missing arg R1.2/1.3, config
 * error R7.2/7.5, or an environment-guard block R2.1/2.2) crash at module-load
 * if a client library it never needs is absent. Deferring the load keeps those
 * paths driver-free — "no operation before the error" — and means a missing
 * client dependency surfaces only for the specific engine the user targets.
 */
const DRIVER_FACTORIES: Record<DbEngine, () => Promise<DbDriver>> = {
  postgresql: async () =>
    new (
      await importDriverModule<typeof import('./drivers/postgres-driver.js')>(
        'postgresql',
        'pg',
        './drivers/postgres-driver.js',
      )
    ).PostgresDriver(),
  mysql: async () =>
    new (
      await importDriverModule<typeof import('./drivers/mysql-driver.js')>(
        'mysql',
        'mysql2',
        './drivers/mysql-driver.js',
      )
    ).MysqlDriver(),
  sqlite: async () =>
    new (
      await importDriverModule<typeof import('./drivers/sqlite-driver.js')>(
        'sqlite',
        'better-sqlite3',
        './drivers/sqlite-driver.js',
      )
    ).SqliteDriver(),
};

/** Node error codes emitted when a module (or its native binding) is missing. */
const MODULE_MISSING_CODES = new Set([
  'MODULE_NOT_FOUND',
  'ERR_MODULE_NOT_FOUND',
  'ERR_DLOPEN_FAILED',
]);

/**
 * Dynamically import a driver module, translating a missing client library into
 * a clear, actionable error.
 *
 * The database drivers (`pg`, `mysql2`, `better-sqlite3`) are declared as
 * OPTIONAL dependencies: a user only needs the one client for the engine their
 * project targets, and `better-sqlite3` in particular requires a native build
 * toolchain that may be unavailable. If the client for the selected engine is
 * not installed (or its native binding failed to build), the dynamic import
 * fails with a module-not-found error — we catch it here and tell the user
 * exactly which package to install, rather than surfacing a cryptic stack.
 */
async function importDriverModule<T>(
  engine: DbEngine,
  clientPackage: string,
  modulePath: string,
): Promise<T> {
  try {
    return (await import(modulePath)) as T;
  } catch (err) {
    const code = (err as { code?: string } | undefined)?.code;
    if (code !== undefined && MODULE_MISSING_CODES.has(code)) {
      throw new Error(
        `The "${clientPackage}" client is required to roll back a ${engine} database, ` +
          `but it is not installed. Install it in your project, e.g. "npm install ${clientPackage}", ` +
          `then re-run the command.`,
      );
    }
    throw err;
  }
}

/**
 * Read the CLI version string from the packaged `package.json` (R1.7).
 *
 * `package.json` lives one directory above the compiled entrypoint
 * (`dist/index.js` → `../package.json`) and, in source, two levels above
 * (`src/index.ts` → `../package.json`). Because it sits outside `rootDir`, it
 * is read at runtime rather than imported, so the version is always the value
 * shipped alongside the running binary. Falls back to `'0.0.0'` if it cannot be
 * read or parsed, so `--version` never crashes.
 */
function readCliVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, '..', 'package.json');
    const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      version?: unknown;
    };
    if (typeof parsed.version === 'string' && parsed.version.length > 0) {
      return parsed.version;
    }
  } catch {
    // Fall through to the default below; --version must never throw.
  }
  return '0.0.0';
}

/** Write a redacted line to standard error (pre-logger errors, R8.5). */
function printError(message: string): void {
  // eslint-disable-next-line no-console
  console.error(redact(message));
}

/** Write a line to standard output (used only for the version string, R1.7). */
function printLine(message: string): void {
  // eslint-disable-next-line no-console
  console.log(message);
}

/**
 * The CLI entrypoint. Returns the intended process exit code rather than
 * calling `process.exit`, so it is directly testable (the direct-invocation
 * guard below performs the actual exit).
 *
 * @param argv Arguments after `node <script>` (defaults to `process.argv`
 *   sliced to the user-supplied tokens).
 */
export async function main(
  argv: string[] = process.argv.slice(2),
): Promise<number> {
  try {
    // ── 1. Parse argv (R1.1/1.2/1.3/1.7). ─────────────────────────────────
    const parsed = argParser.parse(argv);

    if (parsed.kind === 'version') {
      // R1.7: print the version and exit 0 without starting any operation.
      printLine(readCliVersion());
      return EXIT_OK;
    }

    if (parsed.kind === 'error') {
      // R1.2/1.3: report the arity error to stderr and exit — before any
      // operation, no database or file-system access.
      printError(parsed.message);
      return parsed.exitCode;
    }

    const args: ParsedArgs = parsed.args;

    // ── 2. Resolve configuration from schema.prisma + DATABASE_URL (R7.1). ─
    let cfg: ResolvedConfig;
    try {
      cfg = new ConfigResolver().resolve(process.cwd(), process.env);
    } catch (err) {
      if (err instanceof ConfigError) {
        // R7.2: identify the specific missing configuration source, exit 1.
        printError(err.message);
        return EXIT_FAILURE;
      }
      if (err instanceof UnsupportedEngineError) {
        // R7.5: name the unsupported engine + list the supported engines, exit 1.
        printError(err.message);
        return EXIT_FAILURE;
      }
      throw err;
    }

    // ── 3. Environment guard: classify then evaluate against --override. ───
    //    A block occurs BEFORE any driver is created or connection is opened,
    //    so no DB/FS change can happen on a blocked invocation (R2.1/R2.2).
    const guard = new EnvironmentGuard();
    const classification = guard.classify({
      nodeEnv: process.env.NODE_ENV,
      connectionTargetDesignation: cfg.connectionTargetDesignation,
    });
    const decision = guard.evaluate(classification, args.flags.override);
    if (!decision.allow) {
      if (decision.reason === 'production') {
        // R2.1: production indicator present → block regardless of override.
        printError(
          'Rollback is blocked: a production environment was detected ' +
            '(NODE_ENV=production or a production-designated connection target). ' +
            'This destructive operation is permitted only in development ' +
            'environments; no changes were made.',
        );
      } else {
        // R2.2: ambiguous environment and no override supplied.
        printError(
          'Rollback is blocked: the environment could not be determined to be a ' +
            'development environment (NODE_ENV is unset/unrecognized and no ' +
            'connection target designation is present). Re-run with --override to ' +
            'explicitly authorize this destructive operation; no changes were made.',
        );
      }
      return decision.exitCode;
    }

    // ── 4. Select the driver by resolved engine (total over supported set). ─
    //    Loaded lazily so no client library is required until an engine that
    //    needs it is actually selected (see DRIVER_FACTORIES).
    const driver = await DRIVER_FACTORIES[cfg.engine]();

    // ── 5. Delegate to the orchestrator, honoring --verbose for logging. ───
    //    The orchestrator owns connection open/close (R7.6), step sequencing,
    //    confirmation, dry-run, atomic reversal, cleanup, and recovery, and
    //    returns the process exit code.
    const logger = new ConsoleLogger({ verbose: args.flags.verbose });
    const orchestrator = new RollbackOrchestrator({ logger });
    return await orchestrator.run(args, cfg, driver);
  } catch (err) {
    // ── 6. Top-level safety net: any unexpected error is reported (redacted)
    //    to stderr and mapped to a non-zero exit code so credentials never
    //    leak and the process never crashes with an unhandled rejection. ────
    const detail = err instanceof Error ? err.message : String(err);
    printError(`Unexpected error: ${detail}. The rollback operation was aborted.`);
    return EXIT_FAILURE;
  }
}

// Only run when invoked directly as the CLI (not when imported in tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  main().then((code) => process.exit(code));
}
