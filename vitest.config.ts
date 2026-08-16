import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Integration tests share one HydraDB instance and write to disjoint id
    // ranges, but the engine serialises writes anyway — running them in
    // parallel just adds contention without saving wall clock.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
