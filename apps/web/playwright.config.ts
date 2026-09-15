import { defineConfig, devices } from '@playwright/test';

if (!process.env.DATABASE_URL || !process.env.AUTH_SECRET) {
  throw new Error('E2E requires an isolated migrated DATABASE_URL and AUTH_SECRET. See docs/DEVELOPMENT.md.');
}

/**
 * M8-i1: fixed TEST-ONLY VAPID keypair for the E2E web server (generated once
 * with web-push, committed on purpose). It is not a secret and must never be
 * reused in production; it only unlocks the configured-push UI/API paths in
 * local and CI browser tests. Override with real keys via the environment if
 * a deployment test needs them.
 */
const E2E_VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY ?? 'BIheeqGJoON1sFasQ9uIFfmv2g4BrjDv0a2HNLNbOzwqlcRPbEQyKkKIwgnJiJl9I5s3Y76bQacnVsjfZP-qEMk';
const E2E_VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY ?? 'pJAArgQPNmUJyP1HSoFVNmjarJiSlpJjpe1sCA7mNGo';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: [['list'], ['html', { open: 'never' }], ['json', { outputFile: 'test-results/results.json' }]],
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
    env: { APP_URL: 'http://localhost:3100', VAPID_PUBLIC_KEY: E2E_VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY: E2E_VAPID_PRIVATE_KEY },
  },
});
