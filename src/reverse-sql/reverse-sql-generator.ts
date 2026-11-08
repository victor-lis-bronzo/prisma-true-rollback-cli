/**
 * Reverse-SQL Generator (design.md §"Reverse-SQL Generator").
 *
 * A thin post-processor over the {@link PrismaEngineRunner}. It orchestrates
 * reverse-SQL generation (invoking the engine as a child process), then parses
 * the engine's raw output into a {@link ReverseSql} value carrying the verbatim
 * script (`raw`, shown in dry-run — R3.4) and the list of executable statements
 * (`statements`, with SQL comments and whitespace stripped).
 *
 * Requirement traceability:
 *   - R3.1: the engine child process is invoked (via the injected runner) to
 *           compute the Reverse_SQL that transforms the current Database schema
 *           back to the state preceding the Target_Migration.
 *   - R3.2 / R3.5 / R3.6: engine failure / timeout / binary-not-found outcomes
 *           produced by the runner are surfaced as a {@link ReverseSqlError}
 *           carrying the underlying detail.
 *   - R3.3: an *effectively empty* script (only whitespace + SQL comments, i.e.
 *           zero executable statements) is rejected with a {@link ReverseSqlError}
 *           reporting that no reversal statements were generated.
 *   - R3.4: the exact engine output is preserved verbatim as `raw` for the
 *           orchestrator's dry-run display (the orchestrator owns the dry-run
 *           control flow; this component only exposes `raw`).
 *
 * The {@link PrismaEngineRunner} is injectable via the constructor so unit tests
 * (Task 9.x) and the Property 8 test (Task 9.2) can supply a deterministic fake
 * runner without spawning a real Prisma binary.
 */

import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PrismaEngineRunner } from '../engine/prisma-engine-runner.js';
import { ReverseSqlError } from '../models/errors.js';
import type {
  ResolvedConfig,
  ReverseSql,
  TargetMigration,
} from '../models/types.js';

/**
 * Timeout budget applied to the Prisma engine child process during reverse-SQL
 * generation (R3.5). The design specifies a 30-second budget.
 */
const ENGINE_TIMEOUT_MS = 30_000;

/**
 * Post-processes the Prisma engine's raw diff output into a structured
 * {@link ReverseSql}, classifying effectively-empty scripts (R3.3).
 */
export class ReverseSqlGenerator {
  private readonly engineRunner: PrismaEngineRunner;

  /**
   * @param engineRunner - Optional injectable engine runner. Defaults to a new
   *   {@link PrismaEngineRunner}; tests supply a deterministic fake.
   */
  constructor(engineRunner: PrismaEngineRunner = new PrismaEngineRunner()) {
    this.engineRunner = engineRunner;
  }

  /**
   * Generate the reverse-direction SQL for the given target migration.
   *
   * Orchestrates the engine invocation (R3.1) and post-processes the result:
   *   - `ok`      → parse `raw` into `statements`; if the script is effectively
   *                 empty, throw {@link ReverseSqlError} (R3.3).
   *   - `nonzero` → throw {@link ReverseSqlError} carrying the complete engine
   *                 stderr output (R3.2).
   *   - `timeout` → throw {@link ReverseSqlError} reporting the timeout (R3.5).
   *   - `notFound`→ throw {@link ReverseSqlError} reporting the missing binary
   *                 (R3.6).
   *
   * @param cfg - Resolved configuration (engine + schema location).
   * @param target - The migration whose changes are to be reversed.
   * @returns the parsed {@link ReverseSql} on success.
   * @throws {ReverseSqlError} on any engine failure or an effectively-empty
   *   script.
   */
  async generate(
    cfg: ResolvedConfig,
    target: TargetMigration
  ): Promise<ReverseSql> {
    // The diff runs from the live database back to the migration history
    // WITHOUT the Target_Migration (R3.1): stage a temp copy of the migrations
    // directory that omits the target and diff against it.
    const stagedDir = this.stageMigrationsWithout(cfg.migrationsDir, target.name);
    let result;
    try {
      result = await this.engineRunner.runDiff({
        fromUrl: cfg.connectionUrl,
        toMigrationsDir: stagedDir,
        ...(cfg.shadowDatabaseUrl !== undefined
          ? { shadowDatabaseUrl: cfg.shadowDatabaseUrl }
          : {}),
        engine: cfg.engine,
        timeoutMs: ENGINE_TIMEOUT_MS,
      });
    } finally {
      rmSync(stagedDir, { recursive: true, force: true });
    }

    switch (result.kind) {
      case 'ok': {
        const raw = result.sql;
        if (this.isEffectivelyEmpty(raw)) {
          // R3.3: nothing to reverse — the script has zero executable statements.
          throw new ReverseSqlError(undefined, { rawSql: raw });
        }
        const statements = this.parseStatements(raw);
        return { raw, statements };
      }
      case 'nonzero':
        // R3.2: surface the complete engine error output.
        throw new ReverseSqlError(
          `Reverse-SQL generation failed: the Prisma engine exited with status ${result.exitCode}. Engine output:\n${result.stderr}`
        );
      case 'timeout':
        // R3.5: the engine overran its 30-second budget.
        throw new ReverseSqlError(
          'Reverse-SQL generation timed out: the Prisma engine did not complete within 30 seconds.'
        );
      case 'notFound':
        // R3.6: the engine binary could not be located.
        throw new ReverseSqlError(
          'Reverse-SQL generation failed: the Prisma engine binary was not found.'
        );
    }
  }

  /**
   * Copy every entry of `migrationsDir` (including `migration_lock.toml`) except
   * the folder named `excluded` into a fresh temp directory, returning its path.
   */
  private stageMigrationsWithout(migrationsDir: string, excluded: string): string {
    const staged = mkdtempSync(join(tmpdir(), 'prisma-true-rollback-'));
    try {
      // A missing directory stages as empty (the validator already ran).
      const entries = existsSync(migrationsDir) ? readdirSync(migrationsDir) : [];
      for (const entry of entries) {
        if (entry !== excluded) {
          cpSync(join(migrationsDir, entry), join(staged, entry), { recursive: true });
        }
      }
    } catch (err) {
      rmSync(staged, { recursive: true, force: true });
      throw err;
    }
    return staged;
  }

  /**
   * Determine whether a reverse-SQL script is *effectively empty* — i.e. it
   * contains zero executable statements, consisting only of whitespace and SQL
   * comments (R3.3).
   *
   * Comment handling covers both SQL comment forms:
   *   - `--` line comments (to end of line)
   *   - `/* ... *&#47;` block comments (which may span multiple lines)
   *
   * After stripping comments and whitespace, the script is effectively empty
   * iff nothing remains. This is the robustness anchor for Property 8.
   *
   * @param sql - The raw reverse-SQL script.
   * @returns true iff the script has no executable statements.
   */
  isEffectivelyEmpty(sql: string): boolean {
    return this.stripComments(sql).trim().length === 0;
  }

  /**
   * Parse a reverse-SQL script into its list of executable statements, with
   * comments and surrounding whitespace stripped.
   *
   * Comments are removed first (so a `;` inside a comment cannot split a
   * statement, and a comment does not become a spurious empty statement), then
   * the remainder is split on `;`. Blank fragments (e.g. a trailing `;` or
   * comment-only regions) are discarded so the result contains only genuine
   * executable statements.
   *
   * The terminating `;` is not re-appended: callers execute each statement via
   * the driver's `exec`, and the design models `statements` as the parsed,
   * comment/whitespace-stripped list rather than raw script fragments.
   */
  private parseStatements(sql: string): string[] {
    const withoutComments = this.stripComments(sql);
    return withoutComments
      .split(';')
      .map((fragment) => fragment.trim())
      .filter((fragment) => fragment.length > 0);
  }

  /**
   * Remove SQL comments from a script, preserving all other characters
   * (including newlines) so subsequent whitespace/statement analysis is exact.
   *
   * A single left-to-right scan is used rather than a regex so the two comment
   * forms and string literals are handled without catastrophic backtracking or
   * mis-parsing:
   *   - Inside a single- or double-quoted string literal, `--` and `/*` are
   *     ordinary characters and are NOT treated as comment starts (so a literal
   *     that happens to contain comment-like text still counts as executable
   *     content).
   *   - `--` outside a string starts a line comment consumed through the next
   *     newline (the newline itself is preserved).
   *   - `/* ... *&#47;` outside a string starts a block comment consumed through
   *     the closing `*&#47;`; an unterminated block comment consumes the rest of
   *     the input.
   */
  private stripComments(sql: string): string {
    let out = '';
    let i = 0;
    const n = sql.length;
    // Tracks the opening quote character when inside a string literal, else null.
    let quote: "'" | '"' | null = null;

    while (i < n) {
      const ch = sql[i];
      const next = i + 1 < n ? sql[i + 1] : '';

      if (quote !== null) {
        // Inside a string literal: copy verbatim until the matching close quote.
        out += ch;
        if (ch === quote) {
          // A doubled quote ('') is an escaped quote and stays inside the string.
          if (next === quote) {
            out += next;
            i += 2;
            continue;
          }
          quote = null;
        }
        i += 1;
        continue;
      }

      // Not inside a string literal.
      if (ch === "'" || ch === '"') {
        quote = ch;
        out += ch;
        i += 1;
        continue;
      }

      if (ch === '-' && next === '-') {
        // Line comment: skip through (but keep) the terminating newline.
        i += 2;
        while (i < n && sql[i] !== '\n') {
          i += 1;
        }
        if (i < n) {
          out += '\n';
          i += 1;
        }
        continue;
      }

      if (ch === '/' && next === '*') {
        // Block comment: skip through the closing '*/', if any.
        i += 2;
        while (i < n && !(sql[i] === '*' && i + 1 < n && sql[i + 1] === '/')) {
          i += 1;
        }
        // Consume the closing '*/' when present; otherwise the comment ran to EOF.
        i = i < n ? i + 2 : n;
        continue;
      }

      out += ch;
      i += 1;
    }

    return out;
  }
}
