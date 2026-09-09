// Unit tests for the Logger's step-message formatting and sink routing.
//
// Covers Task 3.5: step start/success message text and stream routing, using
// injected out/err sinks so no real process stream is touched.
//   - step(index, total, name) -> "Step X of N: <name>" on stdout (R8.1)
//   - stepDone(name)           -> success notice identifying the step, stdout (R8.2)
//   - info / warn              -> stdout
//   - error                    -> stderr
//   - verbose                  -> stdout only when verbose is enabled, else nothing (R8.4)
//
// Requirements: 8.1, 8.2.

import { describe, it, expect, beforeEach } from 'vitest';

import { ConsoleLogger } from '../../src/logger/logger.js';

/** Collects lines written to a sink so tests can assert on them. */
function makeSink(): { lines: string[]; sink: (line: string) => void } {
  const lines: string[] = [];
  return { lines, sink: (line: string) => lines.push(line) };
}

describe('ConsoleLogger — step-message formatting and routing', () => {
  let out: { lines: string[]; sink: (line: string) => void };
  let err: { lines: string[]; sink: (line: string) => void };

  beforeEach(() => {
    out = makeSink();
    err = makeSink();
  });

  /** Build a logger wired to the fresh out/err capture sinks. */
  function makeLogger(verbose = false): ConsoleLogger {
    return new ConsoleLogger({ verbose, out: out.sink, err: err.sink });
  }

  describe('step() — R8.1', () => {
    it('writes "Step X of N: <name>" to the out sink', () => {
      makeLogger().step(2, 5, 'Generate reverse SQL');

      expect(out.lines).toEqual(['Step 2 of 5: Generate reverse SQL']);
      expect(err.lines).toEqual([]);
    });

    it('reflects the exact index and total supplied', () => {
      makeLogger().step(1, 3, 'Validate target migration');

      expect(out.lines[0]).toBe('Step 1 of 3: Validate target migration');
    });

    it('emits one message per invocation preserving order', () => {
      const logger = makeLogger();
      logger.step(1, 2, 'First');
      logger.step(2, 2, 'Second');

      expect(out.lines).toEqual(['Step 1 of 2: First', 'Step 2 of 2: Second']);
      expect(err.lines).toEqual([]);
    });
  });

  describe('stepDone() — R8.2', () => {
    it('writes a success message identifying the step to the out sink', () => {
      makeLogger().stepDone('Generate reverse SQL');

      expect(out.lines).toHaveLength(1);
      // Identifies the completed step by name...
      expect(out.lines[0]).toContain('Generate reverse SQL');
      // ...and indicates successful completion.
      expect(out.lines[0].toLowerCase()).toContain('success');
      expect(err.lines).toEqual([]);
    });

    it('does not write to the err sink', () => {
      makeLogger().stepDone('Apply transaction');

      expect(err.lines).toEqual([]);
    });
  });

  describe('info() / warn() route to out', () => {
    it('info writes to the out sink only', () => {
      makeLogger().info('informational message');

      expect(out.lines).toEqual(['informational message']);
      expect(err.lines).toEqual([]);
    });

    it('warn writes to the out sink only', () => {
      makeLogger().warn('destructive operation warning');

      expect(out.lines).toEqual(['destructive operation warning']);
      expect(err.lines).toEqual([]);
    });
  });

  describe('error() routes to err', () => {
    it('writes to the err sink only', () => {
      makeLogger().error('something went wrong');

      expect(err.lines).toEqual(['something went wrong']);
      expect(out.lines).toEqual([]);
    });
  });

  describe('verbose() gating — R8.4', () => {
    it('writes to the out sink when verbose is enabled', () => {
      makeLogger(true).verbose('executed statement detail');

      expect(out.lines).toEqual(['executed statement detail']);
      expect(err.lines).toEqual([]);
    });

    it('writes nothing when verbose is disabled', () => {
      makeLogger(false).verbose('executed statement detail');

      expect(out.lines).toEqual([]);
      expect(err.lines).toEqual([]);
    });

    it('defaults to disabled when no verbose option is provided', () => {
      new ConsoleLogger({ out: out.sink, err: err.sink }).verbose('hidden');

      expect(out.lines).toEqual([]);
      expect(err.lines).toEqual([]);
    });
  });
});
