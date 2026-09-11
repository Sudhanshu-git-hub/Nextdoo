import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: Object.fromEntries(['contracts', 'core', 'db', 'billing'].map((name) => [
      `@nextdoo/${name}`, fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url)),
    ])),
  },
  test: {
    environment: 'node',
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'scripts/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/.next/**', '**/e2e/**'],
    testTimeout: 30000,
    coverage: {
      provider: 'v8', reporter: ['text', 'json-summary', 'html', 'lcov'],
      include: ['packages/core/src/**/*.ts', 'packages/billing/src/**/*.ts', 'apps/web/src/server/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts'],
      thresholds: { 'packages/core/src/**': { lines: 85, statements: 85, functions: 85, branches: 85 } },
    },
  },
});
