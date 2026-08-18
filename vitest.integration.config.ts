import { defineConfig } from 'vitest/config';

// Requires a live Docker daemon. Run separately from unit tests:
// npm run test:integration. Also exercised in CI.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['{apps,packages}/**/*.integration.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // No test suites exist yet.
    passWithNoTests: true,
  },
});
