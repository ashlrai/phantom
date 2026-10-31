import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['test/node-context-coverage-31b3.test.ts'],
    testTimeout: 10000,
  },
});
