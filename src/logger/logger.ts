/**
 * Logger (design.md §10 "Logger / Redactor").
 *
 * The single output channel for the CLI. Every message written to standard
 * output or standard error is passed through the {@link Redactor} first, so
 * connection credentials (the DATABASE_URL value, username, password, host, and
 * port) can never leak — redaction cannot be bypassed by a caller (R8.4, R8.5,
 * Property 4).
 *
 * This is the minimal Logger the Rollback Orchestrator depends on. It provides
 * the exact surface described in design.md §10:
 *   - {@link Logger.step}       — "Step X of N: <name>" to stdout (R8.1)
 *   - {@link Logger.stepDone}   — step-completion notice to stdout (R8.2)
 *   - {@link Logger.stepFailed} — step-failure notice to stderr (R8.3)
 *   - {@link Logger.info}       — informational message to stdout
 *   - {@link Logger.warn}       — warning to stdout (used for the destructive
 *                                 warning, R2.3)
 *   - {@link Logger.verbose}    — verbose message to stdout, only when verbose
 *                                 mode is enabled (R8.4)
 *   - {@link Logger.error}      — error message to stderr
 *
 * All writes go through a small pair of sinks (`out`/`err`) that are injectable
 * via the constructor so tests can capture output without touching the real
 * process streams. The verbose gate is likewise injectable.
 */

import { redactor as defaultRedactor, type Redactor } from './redactor.js';

/** A destination for a single line of text (stdout or stderr). */
export type Sink = (line: string) => void;

/** The Logger surface consumed by the orchestrator and other components. */
export interface Logger {
  /** "Step X of N: <name>" to standard output (R8.1). */
  step(index: number, total: number, name: string): void;
  /** Step-completion notice to standard output (R8.2). */
  stepDone(name: string): void;
  /** Step-failure notice to standard error (R8.3). */
  stepFailed(name: string, error: unknown): void;
  /** Informational message to standard output. */
  info(message: string): void;
  /** Warning to standard output (destructive-operation warning, R2.3). */
  warn(message: string): void;
  /** Verbose message to standard output; suppressed unless verbose (R8.4). */
  verbose(message: string): void;
  /** Error message to standard error. */
  error(message: string): void;
}

/** Options for {@link ConsoleLogger}. */
export interface LoggerOptions {
  /** When true, {@link Logger.verbose} messages are emitted (R8.4). */
  verbose?: boolean;
  /** Redactor applied to every message (defaults to the shared instance). */
  redactor?: Redactor;
  /** Standard-output sink (defaults to `console.log`). */
  out?: Sink;
  /** Standard-error sink (defaults to `console.error`). */
  err?: Sink;
}

/**
 * Default {@link Logger} implementation. Routes every message through the
 * {@link Redactor} before writing, so no method can emit raw credentials
 * (R8.5, Property 4).
 */
export class ConsoleLogger implements Logger {
  private readonly verboseEnabled: boolean;
  private readonly redactor: Redactor;
  private readonly out: Sink;
  private readonly err: Sink;

  constructor(options: LoggerOptions = {}) {
    this.verboseEnabled = options.verbose ?? false;
    this.redactor = options.redactor ?? defaultRedactor;
    // eslint-disable-next-line no-console
    this.out = options.out ?? ((line: string) => console.log(line));
    // eslint-disable-next-line no-console
    this.err = options.err ?? ((line: string) => console.error(line));
  }

  step(index: number, total: number, name: string): void {
    this.writeOut(`Step ${index} of ${total}: ${name}`);
  }

  stepDone(name: string): void {
    this.writeOut(`✓ ${name}: completed successfully.`);
  }

  stepFailed(name: string, error: unknown): void {
    this.writeErr(
      `✗ ${name}: failed — ${this.detail(error)}. The rollback operation was aborted.`
    );
  }

  info(message: string): void {
    this.writeOut(message);
  }

  warn(message: string): void {
    this.writeOut(message);
  }

  verbose(message: string): void {
    if (this.verboseEnabled) {
      this.writeOut(message);
    }
  }

  error(message: string): void {
    this.writeErr(message);
  }

  /** Write a redacted line to standard output (R8.5). */
  private writeOut(message: string): void {
    this.out(this.redactor.redact(message));
  }

  /** Write a redacted line to standard error (R8.5). */
  private writeErr(message: string): void {
    this.err(this.redactor.redact(message));
  }

  /** Extract a concise, human-readable detail string from an unknown error. */
  private detail(error: unknown): string {
    if (error instanceof Error && error.message.length > 0) {
      return error.message;
    }
    return String(error);
  }
}
