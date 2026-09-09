import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { createDb, tasks } from '@nextdoo/db';

/**
 * M2 instrumentation + collection-scale acceptance (PRD §21.3, §20.3, §19.4,
 * §6.9):
 *  - client capture telemetry is emitted on save, is content-free, and the
 *    endpoint enforces its strict schema (401 unauthenticated, 400 content
 *    or out-of-range values, 200 valid);
 *  - a 1000-task inbox paginates fully, virtualizes with bounded DOM, and
 *    deep pages render in exact order.
 */

const connection = createDb(process.env.DATABASE_URL!, { max: 2 });
test.afterAll(() => connection.close());

const origin = { Origin: 'http://localhost:3100' };
let ipCounter = 60;
const nextIp = () => `198.51.100.${ipCounter++}`;

const pad = (n: number) => String(n).padStart(3, '0');
const title = (n: number) => `Instrumented task ${pad(n)}`;
const statusLine = (page: Page, text: RegExp) => page.getByRole('status').filter({ hasText: text });

async function register(page: Page): Promise<string> {
  const r = await page.request.post('/api/v1/auth/register', {
    headers: { ...origin, 'X-Forwarded-For': nextIp() },
    data: { email: `instrumented-${randomUUID()}@test.local`, password: 'instrumented-test-123', timeZone: 'UTC' },
  });
  expect(r.status()).toBe(200);
  return (await r.json() as { workspaceId: string }).workspaceId;
}

/** Insert `count` ACTIVE tasks with strictly increasing created_at (ids[i] = task i). */
async function seedTasks(workspaceId: string, count: number): Promise<string[]> {
  const base = Date.UTC(2026, 0, 1);
  const ids = Array.from({ length: count }, () => randomUUID());
  const rows = ids.map((id, i) => ({
    id, workspaceId, title: title(i),
    status: 'ACTIVE' as const, priority: 'NONE' as const,
    createdAt: new Date(base + i * 1000),
  }));
  for (let i = 0; i < rows.length; i += 100) await connection.db.insert(tasks).values(rows.slice(i, i + 100));
  return ids;
}

type TelemetryBody = { latencyMs: number; success: boolean; confirmed: boolean };

function trackTelemetry(page: Page): { bodies: TelemetryBody[]; statuses: number[] } {
  const bodies: TelemetryBody[] = [];
  const statuses: number[] = [];
  page.on('request', (req) => {
    if (req.url().includes('/api/v1/telemetry/capture') && req.method() === 'POST') {
      try { bodies.push(JSON.parse(req.postData() || '{}') as TelemetryBody); } catch { /* body captured by status below */ }
    }
  });
  page.on('response', (res) => {
    if (res.url().includes('/api/v1/telemetry/capture')) statuses.push(res.status());
  });
  return { bodies, statuses };
}

test('direct capture reports content-free telemetry with success and no confirmation', async ({ page }) => {
  const telemetry = trackTelemetry(page);
  await register(page);
  await page.goto('/today');

  await page.locator('#capture').fill('Instrument direct save');
  await page.getByRole('button', { name: 'Add' }).click();
  await expect(page.locator('.sr-only').filter({ hasText: 'Task added: Instrument direct save' })).toBeVisible();

  await expect.poll(() => telemetry.bodies.length).toBe(1);
  await expect.poll(() => telemetry.statuses.length).toBe(1);
  expect(telemetry.statuses).toEqual([200]);
  const body = telemetry.bodies[0]!;
  expect(body.success).toBe(true);
  expect(body.confirmed).toBe(false);
  expect(Number.isInteger(body.latencyMs)).toBe(true);
  expect(body.latencyMs).toBeGreaterThan(0);
  expect(body.latencyMs).toBeLessThan(60_000);
  // Content-free by construction: only the three whitelisted keys exist.
  expect(Object.keys(body).sort()).toEqual(['confirmed', 'latencyMs', 'success']);
});

test('confirmed capture is tagged confirmed and the endpoint rejects content and bad values', async ({ page, playwright }) => {
  const telemetry = trackTelemetry(page);
  await register(page);
  await page.goto('/today');

  // A tag forces the confirmation strip; saving from it must report confirmed.
  await page.locator('#capture').fill('Instrument confirm path #e2e');
  await page.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByRole('group', { name: 'Confirm interpreted task details' })).toBeVisible();
  await page.getByRole('button', { name: 'Save as shown' }).click();
  await expect(page.locator('.sr-only').filter({ hasText: 'Task added: Instrument confirm path' })).toBeVisible();

  await expect.poll(() => telemetry.bodies.length).toBe(1);
  await expect.poll(() => telemetry.statuses.length).toBe(1);
  expect(telemetry.statuses).toEqual([200]);
  expect(telemetry.bodies[0]!.confirmed).toBe(true);
  expect(telemetry.bodies[0]!.success).toBe(true);

  // The server rejects any field outside the strict whitelist (task content).
  const withContent = await page.request.post('/api/v1/telemetry/capture', {
    headers: origin,
    data: { latencyMs: 120, success: true, confirmed: false, title: 'task content must not pass' },
  });
  expect(withContent.status()).toBe(400);

  const negative = await page.request.post('/api/v1/telemetry/capture', {
    headers: origin,
    data: { latencyMs: -5, success: true, confirmed: false },
  });
  expect(negative.status()).toBe(400);

  const oversized = await page.request.post('/api/v1/telemetry/capture', {
    headers: origin,
    data: { latencyMs: 3_700_000, success: true, confirmed: false },
  });
  expect(oversized.status()).toBe(400);

  const valid = await page.request.post('/api/v1/telemetry/capture', {
    headers: origin,
    data: { latencyMs: 250, success: true, confirmed: false },
  });
  expect(valid.status()).toBe(200);

  // Unauthenticated reports are rejected before validation.
  const anonymous = await playwright.request.newContext({ baseURL: 'http://localhost:3100' });
  try {
    const unauth = await anonymous.post('/api/v1/telemetry/capture', {
      headers: origin,
      data: { latencyMs: 250, success: true, confirmed: false },
    });
    expect(unauth.status()).toBe(401);
  } finally {
    await anonymous.dispose();
  }
});

test('a 1000-task inbox paginates fully, virtualizes with bounded DOM, and renders deep pages in order', async ({ page }) => {
  const workspaceId = await register(page);
  const ids = await seedTasks(workspaceId, 1000);
  await page.goto('/tasks');

  // 20 pages of 50: 19 Load-more clicks.
  for (let i = 0; i < 19; i++) await page.getByRole('button', { name: 'Load more tasks' }).click();
  await expect(statusLine(page, /^1000 tasks loaded\.$/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Load more tasks' })).toHaveCount(0);
  // Load-more clicks scroll the pagination control into view; reset to the list top.
  await page.evaluate(() => window.scrollTo(0, 0));

  const ul = page.locator('ul[data-virtualized="true"]');
  await expect(ul).toBeVisible();
  await expect(ul.locator('> li')).toHaveCount(1000);

  // Bounded rendering at 1000 rows: far fewer real rows than total, the rest placeholders.
  const realRows = ul.locator('> li[data-task-id]');
  const realCount = await realRows.count();
  expect(realCount).toBeGreaterThan(0);
  expect(realCount).toBeLessThan(400);
  const placeholders = page.locator('[data-virtual-placeholder]');
  expect(await placeholders.count()).toBeGreaterThanOrEqual(600);
  await expect(placeholders.first()).toHaveAttribute('aria-hidden', 'true');

  // Newest first at the top, exact order.
  const topTitles = await realRows.locator('.task-title').allInnerTexts();
  topTitles.forEach((t, i) => expect(t).toBe(title(999 - i)));

  // Deep page: the oldest row (page 20) renders when scrolled to the bottom.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect(page.locator(`li[data-task-id="${ids[0]}"]`)).toHaveCount(1);
  const bottomTitles = await realRows.locator('.task-title').allInnerTexts();
  expect(bottomTitles.at(-1)).toBe(title(0));
  bottomTitles.forEach((t, i) => expect(t).toBe(title(bottomTitles.length - 1 - i)));
  await expect(ul.locator('> li')).toHaveCount(1000);
});
