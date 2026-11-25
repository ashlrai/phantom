import { defineConfig } from 'vitest/config';
// @testing-library/dom is a transitive dep of @testing-library/react: under
// pnpm's strict layout it resolves outside the project root, where the CJS
// dep's own requires fail. Inlining it lets vite resolve the package itself.
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['desktop/**/*.test.{ts,tsx}'],
    server: { deps: { inline: [/@testing-library\/dom/] } },
  },
});
