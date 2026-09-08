import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@nextdoo/contracts': resolve(__dirname, 'packages/contracts/src/index.ts'),
      '@nextdoo/core': resolve(__dirname, 'packages/core/src/index.ts'),
      '@nextdoo/db': resolve(__dirname, 'packages/db/src/index.ts'),
    },
  },
  test: { environment: 'node', include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'], testTimeout: 30000 },
});
