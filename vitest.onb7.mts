import { defineConfig } from 'vitest/config';

// Scoped runner: vitest.config.ts has a pre-existing circular ESM import
// (test/config/realio-lane-membership.mjs <-> test/integration/lane-membership.mjs)
// that aborts startup. Replicates its setup files and pool for this suite.
export default defineConfig({
  test: {
    include: ['test/onboard-detect.test.ts'],
    setupFiles: ['./vitest.config.mock-compat.ts', './test/setup/home.ts', './test/setup/home-isolation-guard.ts'],
    clearMocks: true,
    pool: 'forks',
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
