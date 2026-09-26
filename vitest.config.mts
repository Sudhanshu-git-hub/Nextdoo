import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: Object.fromEntries([
      ['@nextdoo/core/calendar', fileURLToPath(new URL('./packages/core/src/calendar.ts', import.meta.url))],
      ...['contracts', 'core', 'db', 'billing', 'calendar'].map((name) => [
        `@nextdoo/${name}`, fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url)),
      ]),
      // Web app source alias, so vitest can import real /v1 route handlers
      // (which use `@/...` imports) for HTTP-level integration tests.
      ['@', fileURLToPath(new URL('./apps/web/src', import.meta.url))],
    ]),
  },
  test: {
    environment: 'node',
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'scripts/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/.next/**', '**/e2e/**'],
    testTimeout: 30000,
    coverage: {
      provider: 'v8', reporter: ['text', 'json-summary', 'html', 'lcov'],
      include: ['packages/core/src/**/*.ts', 'packages/billing/src/**/*.ts', 'packages/calendar/src/**/*.ts', 'apps/web/src/server/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts'],
      thresholds: {
        'packages/core/src/**': { lines: 85, statements: 85, functions: 85, branches: 85 },
        'packages/calendar/src/**': { lines: 80, statements: 80, functions: 80, branches: 70 },
      },
    },
  },
});
