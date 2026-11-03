#!/usr/bin/env node
/**
 * NEXTDOO local demonstration screenshot capture.
 *
 * Registers a fresh, uniquely-named demo account against a running production
 * server and captures screenshots of the main workspace pages. No existing
 * account data is used, and no personal information appears in the output
 * (the demo account is generated locally and left in the test database).
 *
 * Prerequisites:
 *   - A migrated PostgreSQL (DATABASE_URL) reachable from the server
 *   - A production build (`pnpm build`)
 *   - Playwright Chromium (`pnpm --filter @nextdoo/web exec playwright install chromium`)
 *
 * Usage:
 *   export DATABASE_URL=postgres://postgres:postgres@localhost:55432/nextdoo_test
 *   export AUTH_SECRET=test-only-secret-at-least-32-characters
 *   export APP_URL=http://localhost:3100
 *   pnpm build
 *   pnpm --filter @nextdoo/web exec next start -H 0.0.0.0 -p 3100 &   # keep running
 *   node scripts/screenshot-demo.mjs
 *
 * Screenshots are written to docs/assets/.
 */
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';

// @playwright/test lives in the web app's dependencies; resolve it there.
const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { chromium } = require('@playwright/test');

const BASE = process.env.DEMO_BASE_URL ?? 'http://localhost:3100';
const OUT_DIR = new URL('../docs/assets/', import.meta.url).pathname;
mkdirSync(OUT_DIR, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function shot(page, name) {
  await page.screenshot({ path: `${OUT_DIR}${name}.png`, fullPage: false });
  console.log(`saved ${name}.png`);
}

/** Runs a capture step; failures are reported and skipped, not fatal. */
async function step(label, fn) {
  try {
    await fn();
  } catch (error) {
    console.error(`skipped ${label}: ${String(error).split('\n')[0]}`);
  }
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  timezoneId: 'UTC',
});
const page = await context.newPage();

try {
  // 1. Landing/login screen
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await shot(page, '01-login');

  // 2. Register a fresh demo account
  const email = `demo-${randomUUID()}@test.local`;
  await page.goto(`${BASE}/register`, { waitUntil: 'networkidle' });
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill('demo-only-password-123');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.waitForURL(/\/today$/, { timeout: 30000 });
  await sleep(1200);

  // 3. Create a task through quick capture (real persisted task)
  const title = `Plan nextdoo release ${randomUUID().slice(0, 8)}`;
  await page.locator('#capture').fill(`${title} today at 9pm for 2 hours`);
  await page.locator('#capture').press('Enter');
  await page.waitForTimeout(2000);
  await shot(page, '02-today');

  // 4. Task editor (task title opens the editor)
  await step('03-task-editor', async () => {
    await page.getByRole('button', { name: `Edit "${title}"` }).first().click();
    await sleep(1200);
    await shot(page, '03-task-editor');
  });

  // 5. Browse tasks
  await step('04-tasks-browser', async () => {
    await page.goto(`${BASE}/tasks`, { waitUntil: 'networkidle' });
    await sleep(1200);
    await shot(page, '04-tasks-browser');
  });

  // 6. Projects
  await step('05-projects', async () => {
    await page.goto(`${BASE}/projects`, { waitUntil: 'networkidle' });
    await sleep(1200);
    await shot(page, '05-projects');
  });

  // 7. Goals
  await step('06-goals', async () => {
    await page.goto(`${BASE}/goals`, { waitUntil: 'networkidle' });
    await sleep(1200);
    await shot(page, '06-goals');
  });

  // 8. Trackers
  await step('07-trackers', async () => {
    await page.goto(`${BASE}/trackers`, { waitUntil: 'networkidle' });
    await sleep(1200);
    await shot(page, '07-trackers');
  });

  // 9. Knowledge
  await step('08-knowledge', async () => {
    await page.goto(`${BASE}/knowledge`, { waitUntil: 'networkidle' });
    await sleep(1200);
    await shot(page, '08-knowledge');
  });

  // 10. Calendar
  await step('09-calendar', async () => {
    await page.goto(`${BASE}/calendar`, { waitUntil: 'networkidle' });
    await sleep(1200);
    await shot(page, '09-calendar');
  });

  // 11. Insights
  await step('10-insights', async () => {
    await page.goto(`${BASE}/insights`, { waitUntil: 'networkidle' });
    await sleep(1200);
    await shot(page, '10-insights');
  });

  // 12. Settings
  await step('11-settings', async () => {
    await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
    await sleep(1200);
    await shot(page, '11-settings');
  });

  console.log('Screenshot capture complete.');
} finally {
  await browser.close();
}
