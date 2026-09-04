import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    // Integration tests share one Postgres schema and one Redis keyspace.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    setupFiles: ['tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
  },
});
