# Prisma True Rollback CLI

An unofficial command-line extension for the Prisma ecosystem that performs a **true, destructive rollback** of the most recently applied Prisma migration in **development environments**.

Prisma follows a strict "roll-forward" philosophy and offers no practical native support for reverting migrations. When you apply a migration locally and then spot a modeling flaw, the native flow forces you to create a *new* corrective migration — polluting your repository history and CI/CD pipeline. This tool erases the trace of an unwanted migration from both the database and the file system, while keeping Prisma's migration tracking internally consistent.

> ⚠️ **This is a destructive, development-only tool.** It permanently deletes schema changes, the `_prisma_migrations` record, and the migration folder. It refuses to run against production and includes safeguards, atomic execution, and compensating recovery so a partial failure never leaves your project half-reverted.

## How it works

The CLI orchestrates a fixed, ordered sequence:

1. **Generate reverse SQL** — invokes the Prisma engine (`prisma migrate diff`) as a child process to compute the SQL that undoes the target migration.
2. **Capture a pre-operation snapshot** — records the tracking-table row and the full migration folder contents (used for recovery).
3. **Apply the reversal atomically** — runs the reverse SQL and deletes the `_prisma_migrations` record inside a single database transaction.
4. **Delete the migration folder** — physically removes the migration folder from `prisma/migrations/`.

If any step fails after the point of no return, **compensating recovery** restores the database and the migration folder to their prior state.

## Installation & usage

The tool is invoked via `npx` from the root of your Prisma project (where your `prisma/schema.prisma` and `DATABASE_URL` live):

```bash
npx prisma-true-rollback <migration-name> [flags]
```

`<migration-name>` is the timestamped folder name of the migration under `prisma/migrations/` — and it must be the **most recently applied** migration.

### CLI commands & flags

| Command / Flag        | Alias | Description                                                                                       |
| --------------------- | ----- | ------------------------------------------------------------------------------------------------- |
| `<migration-name>`    | —     | The target migration to roll back. Must be the most recently applied migration. Exactly one required. |
| `--dry-run`           | —     | Print the generated reverse SQL and exit **without making any change** to the database or files.  |
| `--yes`               | `-y`  | Skip the interactive confirmation prompt (non-interactive mode).                                  |
| `--override`          | —     | Authorize the rollback when the environment cannot be determined to be a development environment. |
| `--verbose`           | —     | Print executed database statements and the invoked Prisma engine command (credentials redacted).  |
| `--version`           | `-v`  | Print the CLI version and exit.                                                                   |

### Examples

| Goal                                                   | Command                                                          |
| ------------------------------------------------------ | --------------------------------------------------------------- |
| Preview the reverse SQL without changing anything      | `npx prisma-true-rollback 20240101120000_add_users --dry-run`   |
| Roll back the latest migration (with confirmation)     | `npx prisma-true-rollback 20240101120000_add_users`             |
| Roll back without the interactive prompt               | `npx prisma-true-rollback 20240101120000_add_users --yes`       |
| Roll back in an ambiguous environment, with verbose logs| `npx prisma-true-rollback 20240101120000_add_users --override --verbose` |
| Check the installed version                            | `npx prisma-true-rollback --version`                            |

### Safeguards & exit codes

- Refuses to run when a **production indicator** is detected (`NODE_ENV=production` or a production-designated connection target).
- Blocks **ambiguous** environments unless `--override` is supplied.
- Requires interactive confirmation unless `--yes` is passed; declining (or a 60s timeout) exits cleanly with **no changes**.
- Exit code `0` on success or a safe no-op (dry-run, declined confirmation); non-zero on validation, configuration, execution, or recovery outcomes.

## Development

Clone the repo and install dependencies, then use the npm scripts below:

| Script                | Command             | Description                                              |
| --------------------- | ------------------- | -------------------------------------------------------- |
| Build                 | `npm run build`     | Compile TypeScript to `dist/`.                           |
| Type-check            | `npm run typecheck` | Run the TypeScript compiler with no emit.                |
| Test                  | `npm test`          | Run the full test suite once (Vitest).                   |
| Test (watch)          | `npm run test:watch`| Run the test suite in watch mode.                        |
| Lint                  | `npm run lint`      | Lint the TypeScript sources with ESLint.                 |

The test suite includes unit tests, integration tests (real SQLite, a stubbed Prisma engine child process, and an end-to-end entrypoint run), and **19 correctness properties** validated with property-based testing (`fast-check`). The PostgreSQL and MySQL integration tests are skipped unless a reachable server URL is provided via `TEST_POSTGRES_URL` / `TEST_MYSQL_URL`.

## Supported databases & drivers

PostgreSQL, MySQL, and SQLite. (MySQL lacks transactional DDL, so the CLI guards against non-atomic reversion on that engine.)

The database clients are declared as **optional dependencies**, because you only need the one that matches your project's engine:

| Engine     | Client package   | Notes                                                                  |
| ---------- | ---------------- | ---------------------------------------------------------------------- |
| PostgreSQL | `pg`             | Pure JavaScript — no build toolchain required.                         |
| MySQL      | `mysql2`         | Pure JavaScript — no build toolchain required.                         |
| SQLite     | `better-sqlite3` | Native module — needs a C/C++ build toolchain if no prebuilt binary is available for your platform/Node version. |

Because they are optional, a failure to install one (for example, `better-sqlite3` not finding a build toolchain on Windows) does **not** break installation of the CLI. Install only the client for your engine, e.g.:

```bash
npm install pg          # PostgreSQL
npm install mysql2      # MySQL
npm install better-sqlite3   # SQLite (requires a native build toolchain)
```

If you run the CLI against an engine whose client is not installed, it exits with a clear message telling you exactly which package to install — no cryptic native-build stack traces.

## Specification

The full specification — requirements, technical design, and the implementation plan — lives under [`.kiro/specs/prisma-true-rollback-cli/`](.kiro/specs/prisma-true-rollback-cli/).

## Tech stack

TypeScript · Node.js · invoked via `npx` · property-based testing with `fast-check`.

## Publishing to npm

This package is configured to be published to npm. The build is produced from TypeScript into `dist/`, and only `dist/` (plus `package.json`, `README.md`, and `LICENSE`) is included in the published tarball. A `prepare` script builds automatically on install/publish, and `prepublishOnly` runs the type-check and test suite as a safety gate.

To publish (requires an npm account and being logged in):

| Step                    | Command                        | Notes                                                            |
| ----------------------- | ------------------------------ | ---------------------------------------------------------------- |
| Log in to npm           | `npm login`                    | One-time per machine/session; authenticates your npm account.    |
| Preview the tarball     | `npm pack --dry-run`           | Lists exactly what will be published without uploading anything. |
| Bump the version        | `npm version patch\|minor\|major` | Updates `package.json` and creates a git tag.                    |
| Publish                 | `npm publish`                  | Runs `prepublishOnly` (typecheck + tests) and `prepare` (build), then uploads. `publishConfig.access` is `public`. |

After publishing, anyone can run it without cloning:

```bash
npx prisma-true-rollback <migration-name> --dry-run
```

## Author & motivation

Authored by **Victor Lis Bronzo**. I built this project to explore and test the potential of **Kiro** — the AI-powered development assistant — driving a complete spec-to-implementation workflow: from requirements and technical design through a fully tested, working CLI.
