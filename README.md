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

## Supported databases

PostgreSQL, MySQL, and SQLite. (MySQL lacks transactional DDL, so the CLI guards against non-atomic reversion on that engine.)

## Status

🚧 Early development. The specification (requirements, design, and implementation plan) lives under [`.kiro/specs/prisma-true-rollback-cli/`](.kiro/specs/prisma-true-rollback-cli/).

## Tech stack

TypeScript · Node.js · invoked via `npx` · property-based testing with `fast-check`.
