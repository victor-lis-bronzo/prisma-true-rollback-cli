/**
 * Config Resolver (design.md §"Config Resolver").
 *
 * Reads the `datasource` block from the project's `schema.prisma` file and the
 * `DATABASE_URL` environment variable, then produces a fully `ResolvedConfig`
 * (engine, connection URL, migrations directory, schema path, and connection
 * target designation).
 *
 * Requirement traceability:
 *   - R7.1: resolve the connection target by reading the datasource block from
 *           schema.prisma and the DATABASE_URL environment variable.
 *   - R7.2: when schema.prisma cannot be located OR DATABASE_URL is unset/empty
 *           (including whitespace-only), fail identifying the missing source.
 *   - R7.5: when the resolved engine is not postgresql/mysql/sqlite, fail naming
 *           the engine and listing the supported engines.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import {
  ConfigError,
  SUPPORTED_ENGINES,
  UnsupportedEngineError,
} from '../models/errors.js';
import type { DbEngine, ResolvedConfig } from '../models/types.js';

/**
 * Candidate relative locations for `schema.prisma`, resolved against `cwd` in
 * order. The conventional Prisma location is `prisma/schema.prisma`; a
 * top-level `schema.prisma` is accepted as a fallback (R7.1).
 */
const SCHEMA_CANDIDATE_RELATIVE_PATHS: readonly string[] = [
  join('prisma', 'schema.prisma'),
  'schema.prisma',
];

/** The set of engines the CLI supports, for membership testing (R7.5). */
const SUPPORTED_ENGINE_SET: ReadonlySet<string> = new Set(SUPPORTED_ENGINES);

/**
 * Resolves the datasource + connection configuration required to run a
 * Rollback_Operation.
 */
export class ConfigResolver {
  /**
   * Resolve the configuration from the filesystem (`schema.prisma`) and the
   * environment (`DATABASE_URL`).
   *
   * @param cwd - Absolute or relative working directory of the invocation.
   * @param env - The process environment (source of `DATABASE_URL`).
   * @returns a fully resolved configuration.
   * @throws {ConfigError} when `schema.prisma` is missing or `DATABASE_URL` is
   *   unset/empty/whitespace-only, identifying the missing source (R7.2).
   * @throws {UnsupportedEngineError} when the datasource provider is not one of
   *   the supported engines (R7.5).
   */
  resolve(cwd: string, env: NodeJS.ProcessEnv): ResolvedConfig {
    const baseDir = isAbsolute(cwd) ? cwd : resolve(cwd);

    // --- Locate schema.prisma (R7.1 / R7.2) ---------------------------------
    const schemaPath = this.locateSchema(baseDir);
    if (schemaPath === undefined) {
      throw new ConfigError(
        'schema.prisma',
        `Could not locate schema.prisma. Looked for ${SCHEMA_CANDIDATE_RELATIVE_PATHS.join(
          ' and '
        )} relative to ${baseDir}.`
      );
    }

    // --- Merge .env files (Prisma loads these automatically) ----------------
    // Variables already present in the process environment always win.
    const schemaDir = dirname(schemaPath);
    env = this.withDotEnv(env, [join(schemaDir, '.env'), join(baseDir, '.env')]);

    // --- Resolve DATABASE_URL (R7.2) ----------------------------------------
    const rawUrl = env.DATABASE_URL;
    if (rawUrl === undefined || rawUrl.trim() === '') {
      throw new ConfigError(
        'DATABASE_URL',
        'The DATABASE_URL environment variable is unset or empty.'
      );
    }
    let connectionUrl = rawUrl;

    // --- Parse the datasource provider (engine) -----------------------------
    const schemaContents = readFileSync(schemaPath, 'utf8');
    const provider = this.parseProvider(schemaContents);
    if (provider === undefined) {
      // No provider means we cannot determine a supported engine; surface it as
      // an unsupported engine with an empty/absent identifier (R7.5).
      throw new UnsupportedEngineError('(no datasource provider found)');
    }
    if (!SUPPORTED_ENGINE_SET.has(provider)) {
      throw new UnsupportedEngineError(provider);
    }
    const engine = provider as DbEngine;

    // Prisma resolves relative SQLite paths against the schema directory, not
    // the cwd; mirror that so the driver opens the same file Prisma does.
    if (engine === 'sqlite') {
      connectionUrl = this.absolutizeSqliteUrl(connectionUrl, schemaDir);
    }

    // --- Derive paths -------------------------------------------------------
    const migrationsDir = join(schemaDir, 'migrations');

    // --- Optional connection target designation -----------------------------
    const connectionTargetDesignation = this.detectTargetDesignation(env);

    const config: ResolvedConfig = {
      engine,
      connectionUrl,
      migrationsDir,
      schemaPath,
    };
    const shadow = env.SHADOW_DATABASE_URL?.trim();
    if (shadow) {
      config.shadowDatabaseUrl = shadow;
    }
    if (connectionTargetDesignation !== undefined) {
      config.connectionTargetDesignation = connectionTargetDesignation;
    }
    return config;
  }

  /**
   * Rewrite a relative SQLite URL (`file:./dev.db`, `file:dev.db`) to an absolute
   * `file:` path based on `schemaDir`. Absolute paths, `file://` URLs and
   * `:memory:` are returned unchanged.
   */
  private absolutizeSqliteUrl(url: string, schemaDir: string): string {
    const trimmed = url.trim();
    if (!trimmed.startsWith('file:') || trimmed.startsWith('file://')) {
      return url;
    }
    const rest = trimmed.slice('file:'.length);
    const queryIndex = rest.indexOf('?');
    const pathPart = queryIndex === -1 ? rest : rest.slice(0, queryIndex);
    const query = queryIndex === -1 ? '' : rest.slice(queryIndex);
    if (pathPart === '' || pathPart === ':memory:' || isAbsolute(pathPart)) {
      return url;
    }
    return `file:${resolve(schemaDir, pathPart)}${query}`;
  }

  /** Return `env` extended with variables from the first-found `.env` files (no overrides). */
  private withDotEnv(env: NodeJS.ProcessEnv, files: readonly string[]): NodeJS.ProcessEnv {
    const merged: NodeJS.ProcessEnv = { ...env };
    for (const file of files) {
      if (!existsSync(file)) {
        continue;
      }
      let contents: string;
      try {
        contents = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      for (const [key, value] of parseDotEnv(contents)) {
        if (merged[key] === undefined) {
          merged[key] = value;
        }
      }
    }
    return merged;
  }

  /**
   * Locate `schema.prisma` by checking each candidate location relative to the
   * working directory, returning the first that exists as an absolute path.
   */
  private locateSchema(baseDir: string): string | undefined {
    for (const relative of SCHEMA_CANDIDATE_RELATIVE_PATHS) {
      const candidate = join(baseDir, relative);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
    return undefined;
  }

  /**
   * Extract the `provider` value from the first `datasource` block in a
   * `schema.prisma` file.
   *
   * Handles single- or double-quoted values and arbitrary whitespace, and
   * scopes the search to the `datasource { ... }` block so a `provider` on a
   * `generator` block is not mistaken for the datasource provider.
   */
  private parseProvider(schemaContents: string): string | undefined {
    const datasourceBlock = this.extractDatasourceBlock(schemaContents);
    if (datasourceBlock === undefined) {
      return undefined;
    }
    const providerMatch = /\bprovider\s*=\s*["']([^"']+)["']/.exec(datasourceBlock);
    if (providerMatch === null) {
      return undefined;
    }
    return providerMatch[1]?.trim();
  }

  /**
   * Return the body of the first `datasource <name> { ... }` block, or
   * `undefined` when no datasource block is present.
   */
  private extractDatasourceBlock(schemaContents: string): string | undefined {
    const headerMatch = /\bdatasource\b[^{]*{/.exec(schemaContents);
    if (headerMatch === null) {
      return undefined;
    }
    const bodyStart = headerMatch.index + headerMatch[0].length;
    const closingIndex = schemaContents.indexOf('}', bodyStart);
    if (closingIndex === -1) {
      // Unterminated block; treat the remainder as the body so a provider on a
      // following line is still discoverable.
      return schemaContents.slice(bodyStart);
    }
    return schemaContents.slice(bodyStart, closingIndex);
  }

  /**
   * Determine the connection target designation from the environment, when
   * present. Consumed later by the Environment Guard (R2.1). A missing or
   * unrecognized value yields `undefined` so the guard can classify the
   * environment as ambiguous.
   */
  private detectTargetDesignation(
    env: NodeJS.ProcessEnv
  ): 'production' | 'development' | undefined {
    const designation = env.PRISMA_ROLLBACK_TARGET ?? env.DATABASE_TARGET;
    const normalized = designation?.trim().toLowerCase();
    if (normalized === 'production') {
      return 'production';
    }
    if (normalized === 'development') {
      return 'development';
    }
    return undefined;
  }
}

/** Minimal `.env` parser: `KEY=value`, optional `export`, quotes, `#` comments. */
function parseDotEnv(contents: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m === null) {
      continue;
    }
    let value = (m[2] ?? '').trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.lastIndexOf(quote) > 0) {
      value = value.slice(1, value.lastIndexOf(quote));
    } else {
      const hash = value.search(/\s#/);
      if (hash !== -1) {
        value = value.slice(0, hash).trim();
      }
    }
    out.push([m[1] as string, value]);
  }
  return out;
}
