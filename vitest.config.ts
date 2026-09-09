import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Look for tests co-located in src as well as the dedicated test/ tree.
    include: ['test/**/*.{test,spec}.ts', 'src/**/*.{test,spec}.ts'],
    environment: 'node',
    globals: false,
  },
});
