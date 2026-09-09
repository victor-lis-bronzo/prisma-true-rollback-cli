# Implementation Plan: Prisma True Rollback CLI

## Overview

This plan builds the **Prisma True Rollback CLI** — a TypeScript/Node.js command-line tool (invoked via `npx`) that performs a true, destructive rollback of the most recently applied Prisma migration in development environments.

The implementation is incremental and test-driven. It starts with project scaffolding and shared data models, then builds leaf components (logger/redactor, arg parser, config resolver, environment guard), the driver abstraction and per-engine drivers, the Prisma engine runner and reverse-SQL generator, the transactional executor, the filesystem snapshot/cleanup manager, and the compensating-recovery coordinator. Everything is finally wired together by the rollback orchestrator and the `npx` bin entrypoint. Each component ships with unit tests, and — where the design defines a Correctness Property — a `fast-check` property-based test (minimum 100 iterations). Integration tests cover the external boundaries (Prisma engine child process, real DB engines).

**Language & tooling:** TypeScript + Node.js. Property-based testing uses `fast-check`. Property tests are tagged `// Feature: prisma-true-rollback-cli, Property {number}: {property_text}` and run ≥100 iterations. Property-based testing MUST NOT be implemented from scratch.

## Tasks

- [x] 1. Project scaffolding and test harness
  - Create `package.json` with the `bin` field mapping the CLI name to `dist/index.js` (npx entrypoint), and scripts for build/test.
  - Add TypeScript config (`tsconfig.json`) targeting Node.js with strict mode.
  - Install and configure the test runner and `fast-check` for property-based testing (≥100 iterations default).
  - Create a `bin` wiring stub (`src/index.ts`) that will later delegate to the orchestrator (no behavior yet beyond a placeholder).
  - Establish the `src/` layout for components and a `test/` layout for unit/property/integration tests.
  - _Requirements: 1.1 (invocation surface), 7 (project runs via npx)_

- [x] 2. Define shared data models, types, and error classes
  - [x] 2.1 Define core data model types
    - `DbEngine`, `ResolvedConfig`, `TargetMigration`, `MigrationRecord`.
    - `FileEntry`, `FolderSnapshot`, `PreOperationSnapshot`.
    - `StepName`, `StepResult`, `OperationOutcome`, `RecoveryReport`, `UnrestoredElement`, `GuardDecision`, `EnvClassification`, `DeleteOutcome`, `EngineResult`, `ArgParseResult`, `ParsedArgs`.
    - _Requirements: 4, 5, 6, 7, 8 (shared model surface)_

  - [x] 2.2 Define typed error classes
    - `ConfigError`, `UnsupportedEngineError`, `ReverseSqlError`, `TransactionAbortedError` (carries failing statement + reason), `UnsupportedDdlError`, `SnapshotError`, `FsDeleteError`, `RestoreError`, `StatementError`.
    - Ensure each error carries the fields needed for exit-code mapping and messaging.
    - _Requirements: 3.2, 3.3, 4.5, 4.6, 5.4, 6.2, 7.2, 7.5_

  - [ ]* 2.3 Write unit tests for error classes
    - Verify each error preserves its detail fields (e.g., `TransactionAbortedError` retains the failing statement text and reason).
    - _Requirements: 4.5_

- [x] 3. Implement Logger / Redactor
  - [x] 3.1 Implement the Redactor
    - Replace the DATABASE_URL value, username, password, host, and port with a fixed redaction placeholder for arbitrary carrier text.
    - _Requirements: 8.4, 8.5_

  - [x] 3.2 Implement the Logger routing all output through the Redactor
    - Implement `step` (R8.1 "Step X of N: name"), `stepDone` (R8.2), `stepFailed`→stderr (R8.3), `info`, `warn` (R2.3), `verbose` (R8.4, only when verbose), `error`→stderr.
    - Every method passes its message through `Redactor.redact` before writing so redaction cannot be bypassed.
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 2.3_

  - [ ]* 3.3 Write property test for credential redaction
    - **Property 4: Credentials never appear in output** — for any credential set and any carrier message routed through every Logger method (including verbose), no raw credential value appears and the placeholder is present.
    - **Validates: Requirements 8.4, 8.5**

  - [ ]* 3.4 Write property test for step-failure reporting
    - **Property 19: Step failures are reported with step name and detail** — for any failing step, `stepFailed` writes to stderr a message identifying the step by name, including the error detail, and indicating the operation was aborted.
    - **Validates: Requirements 8.3**

  - [ ]* 3.5 Write unit tests for step-message formatting
    - Verify step start/success message text and ordering ("Step X of N: <name>", success indicator).
    - _Requirements: 8.1, 8.2_

- [x] 4. Implement CLI Argument Parser
  - [x] 4.1 Implement `ArgParser.parse`
    - Parse `argv`; recognize flags `--version/-v`, `--dry-run`, `--yes/-y`, `--override`, `--verbose`.
    - Enforce arity: exactly one positional migration name → `run`; zero positional → `error` (missing arg); >1 positional → `error` (only one accepted); `--version` short-circuits to `version`.
    - _Requirements: 1.1, 1.2, 1.3, 1.7, 2.2 (override flag), 2.6 (yes flag), 3.4 (dry-run flag), 8.4 (verbose flag)_

  - [ ]* 4.2 Write property test for missing migration-name argument
    - **Property 16: Missing migration-name argument is rejected** — for any argv containing no positional name (flags only), parsing yields an error with exit code 1 and a missing-argument message.
    - **Validates: Requirements 1.2**

  - [ ]* 4.3 Write property test for multiple migration-name arguments
    - **Property 17: Multiple migration-name arguments are rejected** — for any argv containing two or more positional names, parsing yields an error with exit code 1 and a one-name-only message.
    - **Validates: Requirements 1.3**

  - [ ]* 4.4 Write unit tests for arg dispatch
    - Single valid name → `run` (R1.1); `--version` → `version` kind, exit 0 (R1.7); flag combinations parsed correctly.
    - _Requirements: 1.1, 1.7_

- [x] 5. Implement Config Resolver
  - [x] 5.1 Implement `ConfigResolver.resolve`
    - Read the `datasource` block from `schema.prisma` and `DATABASE_URL`; produce `ResolvedConfig` (engine, connectionUrl, migrationsDir, schemaPath, connectionTargetDesignation).
    - Throw `ConfigError` when `schema.prisma` is missing or `DATABASE_URL` is unset/empty/whitespace-only, identifying the missing source.
    - Throw `UnsupportedEngineError` when the engine is not postgresql/mysql/sqlite, naming the engine and listing supported engines.
    - _Requirements: 7.1, 7.2, 7.5_

  - [ ]* 5.2 Write property test for missing configuration sources
    - **Property 15: Missing configuration sources are identified** — for any config where `schema.prisma` is absent or `DATABASE_URL` is unset/empty (including whitespace-only), resolve fails with exit code 1 and identifies the specific missing source.
    - **Validates: Requirements 7.2**

  - [ ]* 5.3 Write property test for unsupported engine rejection
    - **Property 14: Unsupported engines are rejected** — for any engine identifier not in {postgresql, mysql, sqlite}, resolve fails with exit code 1 and produces a message naming the engine and listing supported engines.
    - **Validates: Requirements 7.5**

  - [ ]* 5.4 Write unit test for successful resolution
    - Resolve engine + connection target from a valid `schema.prisma` + `DATABASE_URL` (R7.1).
    - _Requirements: 7.1_

- [x] 6. Implement Environment Guard
  - [x] 6.1 Implement `EnvironmentGuard.classify` and `evaluate`
    - Classify: `NODE_ENV === 'production'` OR production connection designation ⇒ `production`; missing/unrecognized NODE_ENV AND absent designation ⇒ `ambiguous`; otherwise `development`.
    - Evaluate: `production` blocks regardless of override (R2.1); `ambiguous` blocks unless override supplied (R2.2); `development` allows.
    - _Requirements: 2.1, 2.2_

  - [ ]* 6.2 Write property test for production always blocking
    - **Property 6: Production indicators always block** — for any invocation with a Production_Indicator present, the guard blocks with a non-zero exit code and no changes, regardless of override.
    - **Validates: Requirements 2.1**

  - [ ]* 6.3 Write property test for ambiguous-environment override
    - **Property 7: Ambiguous environments require an override** — for any ambiguous classification, guard blocks (non-zero, no changes) without override and permits proceeding with override.
    - **Validates: Requirements 2.2**

- [x] 7. Implement DB driver abstraction and per-engine drivers
  - [x] 7.1 Define `DbDriver`, `Connection`, and `Tx` interfaces
    - Include `supportsTransactionalDDL` capability, `connect(url, timeoutMs)`, `redactedTarget(url)`, `transaction`, `close`, and `Tx` statement/record operations.
    - _Requirements: 4.1, 4.6, 7.3, 7.4, 7.6_

  - [x] 7.2 Implement PostgreSQL driver
    - `supportsTransactionalDDL = true`; 10s connect timeout; `redactedTarget` returns host only with credentials stripped; transaction wrapper commits on resolve / rolls back on throw; `Tx` operations for the tracking table.
    - _Requirements: 4.1, 7.3, 7.4, 7.6_

  - [x] 7.3 Implement SQLite driver
    - `supportsTransactionalDDL = true`; connect/close/transaction/`Tx` semantics as above.
    - _Requirements: 4.1, 7.3, 7.4, 7.6_

  - [x] 7.4 Implement MySQL driver
    - `supportsTransactionalDDL = false` (implicit DDL commits); connect/close/transaction/`Tx` semantics as above.
    - _Requirements: 4.1, 4.6, 7.3, 7.4, 7.6_

  - [ ]* 7.5 Write unit tests for `redactedTarget` and capability flags
    - Verify `redactedTarget` strips credentials to host-only across engines; verify `supportsTransactionalDDL` is true for Postgres/SQLite and false for MySQL.
    - _Requirements: 7.4, 4.6, 8.5_

  - [ ]* 7.6 Write integration tests for real DB engines
    - Against ephemeral PostgreSQL, MySQL, and SQLite: single-transaction commit/rollback (Postgres/SQLite), 10s connection-timeout behavior with redacted host (R7.4), and connection cleanup (R7.6). 1–3 representative scenarios per engine (NOT property tests).
    - _Requirements: 4.1, 7.3, 7.4, 7.6_

- [x] 8. Implement Prisma Engine Runner
  - [x] 8.1 Implement `PrismaEngineRunner.runDiff`
    - Invoke the Prisma engine (`prisma migrate diff`) as a child process with a 30s timeout to produce reverse-direction SQL.
    - Return `ok` (sql + command), `nonzero` (exitCode + full stderr), `timeout` (kill child), or `notFound` (ENOENT/binary missing).
    - _Requirements: 3.1, 3.2, 3.5, 3.6_

  - [ ]* 8.2 Write property test for engine failure output surfacing
    - **Property 10: Engine failure output is surfaced** — for any non-zero engine exit with arbitrary error output, the result is a failure carrying the complete engine error output (mapped to non-zero exit, no changes).
    - **Validates: Requirements 3.2**

  - [ ]* 8.3 Write unit tests for engine timeout and binary-not-found
    - 30s timeout kills the child and returns `timeout` (R3.5); ENOENT returns `notFound` (R3.6).
    - _Requirements: 3.5, 3.6_

  - [ ]* 8.4 Write integration test for real Prisma engine invocation
    - 1–3 representative tests spawning the real engine (or a stub binary) verifying `prisma migrate diff` is invoked with correct arguments and its output captured (NOT a property test).
    - _Requirements: 3.1_

- [x] 9. Implement Reverse-SQL Generator
  - [x] 9.1 Implement `ReverseSqlGenerator.generate` and `isEffectivelyEmpty`
    - Post-process engine output into `ReverseSql` (`raw` + parsed `statements`).
    - `isEffectivelyEmpty` returns true iff the script has zero executable statements (only whitespace + SQL comments); such scripts raise `ReverseSqlError` (R3.3).
    - Provide the `raw` output for dry-run display.
    - _Requirements: 3.3, 3.4_

  - [ ]* 9.2 Write property test for empty reverse-SQL detection
    - **Property 8: Empty reverse-SQL detection** — for any script of only whitespace + SQL comments, classify as effectively empty (abort, non-zero); for any script with ≥1 executable statement, classify as non-empty.
    - **Validates: Requirements 3.3**

- [x] 10. Implement Transactional Executor
  - [x] 10.1 Implement `TransactionalExecutor.applyReversal`
    - Guard first: if the driver reports no transactional-DDL support, abort before executing any reverse SQL (throw `UnsupportedDdlError`) (R4.6).
    - Otherwise open a single transaction: exec each reverse statement, then delete the target tracking record; commit on success (R4.1, R4.2, R4.3).
    - On any statement failure, roll back so DB + tracking match pre-transaction state, then throw `TransactionAbortedError` with the failing statement + reason (R4.4, R4.5).
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_

  - [x] 10.2 Implement `TransactionalExecutor.restoreDatabase` (recovery path)
    - Re-apply the original migration's forward statements and re-insert the saved tracking record within a single transaction (used by recovery, R6.4).
    - _Requirements: 6.4_

  - [ ]* 10.3 Write property test for failing-statement reporting
    - **Property 11: Failing statement is reported on transaction abort** — for any transaction where a statement fails, terminate non-zero with a message including the failing statement text and the underlying reason.
    - **Validates: Requirements 4.5**

  - [ ]* 10.4 Write property test for non-transactional-DDL guard
    - **Property 12: Non-transactional-DDL engines are guarded before any DDL** — for any engine reporting no transactional-DDL support, abort before executing any reverse SQL, terminate non-zero, leave DB + tracking unchanged (zero reverse statements executed). Use a fake driver/model.
    - **Validates: Requirements 4.6**

  - [ ]* 10.5 Write unit tests for transaction structure
    - Both reverse SQL and tracking-record delete run in one transaction, delete after reverse (R4.1, R4.2); successful commit maps to exit 0 (R4.3).
    - _Requirements: 4.1, 4.2, 4.3_

- [x] 11. Implement Filesystem Snapshot / Cleanup Manager
  - [x] 11.1 Implement `FsSnapshotManager.capture`, `delete`, `restore`, `equals`
    - `capture`: recursively read all files (relative POSIX path + bytes + mode), sorted for deterministic comparison (read-only) (R5.1, R6.1).
    - `delete`: recursive removal; missing folder → `alreadyAbsent` no-op that continues (R5.2, R5.3); throw `FsDeleteError` on permission/other failure (R5.4).
    - `restore`: recreate folder byte-for-byte from snapshot (R6.5).
    - `equals`: compare a folder against a snapshot for recovery verification (R6.6, R6.7).
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 6.1, 6.5, 6.6, 6.7_

  - [ ]* 11.2 Write property test for snapshot round-trip identity
    - **Property 2: Snapshot round-trip is a byte-for-byte identity** — for any folder contents, capture then restore (including after delete) reproduces every file's relative path, bytes, and mode identically. Generate arbitrary nested folder trees.
    - **Validates: Requirements 5.1, 6.5**

  - [ ]* 11.3 Write property test for delete semantics and idempotence
    - **Property 3: Delete semantics and idempotence** — for any folder, delete removes it and all files/subdirectories entirely; for any nonexistent path, delete is a no-op reported as already-absent; deleting twice equals deleting once.
    - **Validates: Requirements 5.2, 5.3**

- [x] 12. Implement Compensating-Recovery Coordinator
  - [x] 12.1 Implement `RecoveryCoordinator.recover`
    - Restore DB via `restoreDatabase` (re-apply forward statements + re-insert tracking record) and restore the Migration_Folder from the snapshot (R6.4, R6.5).
    - Verify via `equals` and DB re-read: full match → `RecoveryReport{fullyRestored:true}` (R6.6); any mismatch → `fullyRestored:false` with `unrestored` elements and per-element manual steps (R6.7).
    - _Requirements: 6.4, 6.5, 6.6, 6.7_

  - [ ]* 12.2 Write property test for partial-recovery reporting
    - **Property 18: Partial recovery reports exactly the unrestored elements** — for any recovery that fails to restore some subset of {Database, Tracking_Table record, Migration_Folder}, terminate exit 1 and list exactly those unrestored elements with specific manual steps for each. Use a fake driver/fs with injected restore failures.
    - **Validates: Requirements 6.7**

  - [ ]* 12.3 Write unit test for full-restore outcome
    - Full restore yields `fullyRestored:true` and the "aborted, prior state restored" message path (R6.6).
    - _Requirements: 6.6_

- [x] 13. Implement Rollback Orchestrator
  - [x] 13.1 Implement target validation
    - Validate the Target_Migration: unknown folder (R1.4), no tracking record (R1.5), and eligibility that only the most recently applied migration may be rolled back (R1.6). Each failure → exit 1, no changes.
    - _Requirements: 1.4, 1.5, 1.6_

  - [x] 13.2 Implement `RollbackOrchestrator.run` step sequencing and safeguards
    - Enforce the canonical step order (Step 1 generate → Step 2 snapshot → Step 3 transaction → Step 4 delete → Step 5 confirm) with step messages (R8.1, R8.2).
    - Display the destructive/irreversible warning and Target_Migration name before any change (R2.3); enforce interactive confirmation with a 60s timeout, declining/timeout → exit 0 no changes (R2.4, R2.5) unless `--yes` (R2.6).
    - Handle dry-run: print complete Reverse_SQL and exit 0 with zero changes (R3.4).
    - Capture Pre_Operation_Snapshot before the first destructive action; capture failure → abort non-zero, no destructive change (R6.1, R6.2).
    - On post-commit (Step 4) failure, initiate Compensating_Recovery (R5.4, R6.3).
    - On success: confirm folder deletion/full rollback message and exit 0 (R5.5, R5.6).
    - _Requirements: 2.3, 2.4, 2.5, 2.6, 3.4, 5.5, 5.6, 6.1, 6.2, 6.3, 8.1, 8.2_

  - [x] 13.3 Implement exit-code mapping and connection-close guarantee
    - Wrap the operation in `try/finally`; close any opened connection on every path (R7.6).
    - Map outcomes to exit codes: 0 (success/safe abort — version, decline, dry-run), 1 (validation/config/recovery), non-zero (execution failures) per the design's exit-code summary.
    - _Requirements: 4.3, 5.6, 6.6, 6.7, 7.6_

  - [ ]* 13.4 Write property test for atomicity baseline restoration
    - **Property 1: Atomicity — any failure restores the pre-operation baseline** — for any operation and any failure injected at any point after pre-flight (failing reverse statement in the transaction, or FS failure after commit), the final DB + tracking record + Migration_Folder equal the Pre_Operation_Snapshot baseline, with no partial changes. Use in-memory DB/FS models + fake driver/snapshot manager with a generated failure-injection point.
    - **Validates: Requirements 4.4, 6.3, 6.4, 6.5**

  - [ ]* 13.5 Write property test for eligibility of only the latest migration
    - **Property 5: Only the most recently applied migration is rollback-eligible** — for any tracking history, a non-latest target is rejected (exit 1, no changes) while the latest passes the eligibility guard.
    - **Validates: Requirements 1.6**

  - [ ]* 13.6 Write property test for dry-run purity
    - **Property 9: Dry-run purity** — for any generated Reverse_SQL, the dry-run flag emits the complete Reverse_SQL verbatim, performs zero DB/FS changes, and exits 0.
    - **Validates: Requirements 3.4**

  - [ ]* 13.7 Write property test for connection-close guarantee
    - **Property 13: Opened connections are always closed** — for any execution path (success or failure injected at any step) where a connection was opened, it is closed exactly once before termination. Use a fake connection tracking open/close counts.
    - **Validates: Requirements 7.6**

  - [ ]* 13.8 Write unit tests for validation branches and safeguard/FS wiring
    - Unknown folder (R1.4), no tracking record (R1.5); destructive warning before changes (R2.3), interactive gate (R2.4), decline/60s timeout → exit 0 (R2.5), `--yes` skips prompt (R2.6); snapshot-before-delete ordering (R5.1), recovery-on-failure wiring (R5.4), success message (R5.5), exit 0 (R5.6); snapshot precedes first destructive action (R6.1), capture-failure abort (R6.2), recovery initiation (R6.3).
    - _Requirements: 1.4, 1.5, 2.3, 2.4, 2.5, 2.6, 5.1, 5.4, 5.5, 5.6, 6.1, 6.2, 6.3_

- [x] 14. Checkpoint — ensure all tests pass
  - Ensure all unit, property, and integration tests pass, ask the user if questions arise.

- [x] 15. Wire the npx entrypoint end-to-end
  - [x] 15.1 Implement `src/index.ts` entrypoint
    - Parse argv via `ArgParser`; handle `version` (print version, exit 0, R1.7) and arg `error` kinds (exit 1) before any operation (R1.1, R1.2, R1.3).
    - Run the Environment Guard, resolve config, select the driver by engine, connect (10s timeout, R7.3/R7.4), and delegate to `RollbackOrchestrator.run`, returning its exit code as the process exit code.
    - Ensure the bin shebang and `package.json` `bin` mapping make the CLI runnable via `npx`.
    - _Requirements: 1.1, 1.2, 1.3, 1.7, 2.1, 2.2, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6_

  - [ ]* 15.2 Write end-to-end integration test for the entrypoint
    - Drive representative flows through the entrypoint (e.g., `--version`, missing-arg error, dry-run) verifying exit codes and that no DB/FS changes occur on non-destructive paths (NOT a property test).
    - _Requirements: 1.7, 1.2, 3.4_

- [~] 16. Final checkpoint — ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; core implementation sub-tasks are never optional.
- Each task references specific requirement sub-clauses for traceability, and every property test references its design Property number and text.
- Property tests use `fast-check` (never hand-rolled), run ≥100 iterations, and are tagged `// Feature: prisma-true-rollback-cli, Property {number}: {property_text}`.
- Atomicity (Property 1) and the DDL guard (Property 12) use in-memory DB/FS models with fake drivers to keep 100+ iterations cheap; real-engine behavior is covered by integration tests.
- Checkpoints (Tasks 14, 16) provide incremental validation before wiring and at completion.

### Requirement → Task coverage

- **R1:** 1.1→15.1/4.4; 1.2→4.2; 1.3→4.3; 1.4→13.1; 1.5→13.1; 1.6→13.5; 1.7→4.4/15.1.
- **R2:** 2.1→6.2; 2.2→6.3; 2.3→13.2; 2.4→13.8; 2.5→13.8; 2.6→13.8.
- **R3:** 3.1→8.4; 3.2→8.2; 3.3→9.2; 3.4→13.6; 3.5→8.3; 3.6→8.3.
- **R4:** 4.1→10.5; 4.2→10.5; 4.3→10.5; 4.4→13.4; 4.5→10.3; 4.6→10.4.
- **R5:** 5.1→11.2/13.8; 5.2→11.3; 5.3→11.3; 5.4→13.8; 5.5→13.8; 5.6→13.8.
- **R6:** 6.1→13.8; 6.2→13.8; 6.3→13.4; 6.4→13.4; 6.5→11.2/13.4; 6.6→12.3; 6.7→12.2.
- **R7:** 7.1→5.4; 7.2→5.2; 7.3→7.6; 7.4→7.6; 7.5→5.3; 7.6→13.7.
- **R8:** 8.1→3.5; 8.2→3.5; 8.3→3.4; 8.4→3.3; 8.5→3.3.

### Property → Task coverage

Property 1→13.4, 2→11.2, 3→11.3, 4→3.3, 5→13.5, 6→6.2, 7→6.3, 8→9.2, 9→13.6, 10→8.2, 11→10.3, 12→10.4, 13→13.7, 14→5.3, 15→5.2, 16→4.2, 17→4.3, 18→12.2, 19→3.4.

## Task Dependency Graph

Tasks within the same wave are independent and can run in parallel; a wave executes only after all earlier waves complete. Leaf sub-tasks (including optional `*` test tasks) are listed; checkpoints (14, 16) and top-level parent tasks are excluded.

- **Wave 0** — scaffolding + shared models/errors (everything depends on these). Sequential foundation.
- **Waves 1–2** — leaf components (logger/redactor, arg parser, config resolver, environment guard) implemented in parallel, then their tests.
- **Wave 3** — driver abstraction + engine runner + snapshot manager interfaces/impls (parallel; independent files).
- **Waves 4–5** — reverse-SQL generator, transactional executor, recovery coordinator (depend on drivers/snapshot), then their tests.
- **Waves 6–8** — orchestrator (depends on all components), its tests, then the npx entrypoint and end-to-end test (depends on the orchestrator).

```json
{
  "waves": [
    { "id": 0, "tasks": ["1"] },
    { "id": 1, "tasks": ["2.1", "2.2"] },
    { "id": 2, "tasks": ["2.3", "3.1", "4.1", "5.1", "6.1", "7.1", "8.1", "11.1"] },
    { "id": 3, "tasks": ["3.2", "4.2", "4.3", "4.4", "5.2", "5.3", "5.4", "6.2", "6.3", "7.2", "7.3", "7.4", "8.2", "8.3", "9.1", "11.2", "11.3"] },
    { "id": 4, "tasks": ["3.3", "3.4", "3.5", "7.5", "7.6", "8.4", "9.2", "10.1", "10.2"] },
    { "id": 5, "tasks": ["10.3", "10.4", "10.5", "12.1", "13.1"] },
    { "id": 6, "tasks": ["12.2", "12.3", "13.2"] },
    { "id": 7, "tasks": ["13.3", "13.4", "13.5", "13.6", "13.7", "13.8"] },
    { "id": 8, "tasks": ["15.1"] },
    { "id": 9, "tasks": ["15.2"] }
  ]
}
```
