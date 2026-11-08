#!/usr/bin/env node
/**
 * Executable entrypoint (the `prisma-true-rollback` bin). Kept separate from
 * `index.ts` so importing `main` (tests) never runs the CLI, and so running
 * through the `node_modules/.bin` symlink works (no argv[1] comparison).
 */
import { main } from './index.js';

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    // eslint-disable-next-line no-console
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
