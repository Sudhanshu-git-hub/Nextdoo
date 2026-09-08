import { defineConfig, devices } from '@playwright/test';

if (!process.env.DATABASE_URL || !process.env.AUTH_SECRET) {
  throw new Error('E2E requires an isolated migrated DATABASE_URL and AUTH_SECRET. See docs/DEVELOPMENT.md.');
}

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:3100', trace: 'retain-on-failure',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {},
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], timezoneId: 'UTC' } }],
  webServer: {
    command: 'pnpm exec next start -H 0.0.0.0 -p 3100',
    url: 'http://localhost:3100/api/v1/health',
    reuseExistingServer: false,
    timeout: 60000,
    env: { APP_URL: 'http://localhost:3100' },
  },
});
