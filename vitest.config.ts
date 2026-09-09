import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Look for tests co-located in src as well as the dedicated test/ tree.
    include: ['test/**/*.{test,spec}.ts', 'src/**/*.{test,spec}.ts'],
    environment: 'node',
    globals: false,
    // Property-based and integration tests do real filesystem / child-process
    // work and run 100+ iterations. On slower platforms (notably Windows, where
    // filesystem operations are markedly slower) the default 5s per-test budget
    // is too tight, so raise the global timeout. Individual tests may still set
    // their own longer timeout where needed.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
