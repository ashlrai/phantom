import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    setupFiles: ['./vitest.config.mock-compat.ts', './test/setup/home.ts', './test/setup/home-isolation-guard.ts'],
    clearMocks: true,
    pool: 'forks',
    maxWorkers: 2,
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
