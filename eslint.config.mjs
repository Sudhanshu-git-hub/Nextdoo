import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import unusedImports from 'eslint-plugin-unused-imports';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/.next/**', '**/.turbo/**', '**/coverage/**', '**/playwright-report/**', '**/test-results/**', '**/.data/**', '**/.pgdata/**', '**/next-env.d.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,mts,mjs}'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', URL: 'readonly', Buffer: 'readonly', setInterval: 'readonly', clearInterval: 'readonly', fetch: 'readonly', performance: 'readonly', setTimeout: 'readonly' } },
    plugins: { 'unused-imports': unusedImports },
    rules: {
      // Existing Drizzle transaction adapters use explicit any; typecheck still
      // runs independently. Do not pretend a style ban proves boundary safety.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'unused-imports/no-unused-imports': 'error',
      'no-console': 'off',
    },
  },
);
