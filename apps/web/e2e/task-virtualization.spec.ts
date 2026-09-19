import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { createDb, tasks } from '@nextdoo/db';
const connection = createDb(process.env.DATABASE_URL!, { max: 2 });
test.afterAll(() => connection.close());

const origin = { Origin: 'http://localhost:3100' };
let ipCounter = 20;
const nextIp = () => `198.51.100.${ipCounter++}`;

const pad = (n: number) => String(n).padStart(3, '0');
const title = (n: number) => `Virtual task ${pad(n)}`;
const rowByTitle = (page: Page, n: number) =>
  page.locator('li[data-task-id]').filter({ has: page.locator('.task-title', { hasText: new RegExp(`^${title(n)}$`) }) });
const statusLine = (page: Page, text: RegExp) => page.getByRole('status').filter({ hasText: text });

async function register(page: Page): Promise<string> {
  const r = await page.request.post('/api/v1/auth/register', {
    headers: { ...origin, 'X-Forwarded-For': nextIp() },
    data: { email: `virtual-${randomUUID()}@test.local`, password: 'virtual-test-password-123', timeZone: 'UTC' },
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

async function loadAllPages(page: Page, total: number) {
  for (let i = 0; i < 4; i++) await page.getByRole('button', { name: 'Load more tasks' }).click();
  await expect(statusLine(page, new RegExp(`^${total} tasks loaded\\.$`))).toBeVisible();
  await expect(page.getByRole('button', { name: 'Load more tasks' })).toHaveCount(0);
  // The Load-more clicks scroll the pagination control into view; reset to the list top.
  await page.evaluate(() => window.scrollTo(0, 0));
}

test('a 250-task list paginates fully, virtualizes, and keeps order without duplicates', async ({ page }) => {
  const workspaceId = await register(page);
  await seedTasks(workspaceId, 250);
  // Slow the first (non-cursor) fetch so the loading state is observable.
  await page.route('**/api/v1/tasks?', async (route) => {
    const url = route.request().url();
    if (url.includes('limit=50') && !url.includes('cursor=')) await new Promise((r) => setTimeout(r, 400));
    await route.continue();
  });
  await page.goto('/tasks');
  await expect(page.locator('.skeleton')).toHaveCount(3);
  await expect(statusLine(page, /^50 tasks loaded — more available\.$/)).toBeVisible();
  // 50 loaded rows is at or below the 200-row threshold: no virtualization yet.
  await expect(page.locator('ul[data-virtualized]')).toHaveCount(0);
  await loadAllPages(page, 250);
  // 250 loaded rows exceeds the threshold: the list now virtualizes.
  await expect(page.locator('ul[data-virtualized="true"]')).toBeVisible();

  const ul = page.locator('ul[data-virtualized="true"]');
  await expect(ul.locator('> li')).toHaveCount(250);
  const realRows = ul.locator('> li[data-task-id]');
  const realCount = await realRows.count();
  expect(realCount).toBeGreaterThan(0);
  expect(realCount).toBeLessThan(100);
  const placeholders = page.locator('[data-virtual-placeholder]');
  expect(await placeholders.count()).toBeGreaterThanOrEqual(150);
  await expect(placeholders.first()).toHaveAttribute('aria-hidden', 'true');

  // Top of the list: newest first, consecutive, no duplicates.
  const topTitles = await realRows.locator('.task-title').allInnerTexts();
  topTitles.forEach((t, i) => expect(t).toBe(title(249 - i)));

  // Scroll to the very bottom: the oldest row renders and order stays exact.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect(rowByTitle(page, 0)).toHaveCount(1);
  const bottomTitles = await realRows.locator('.task-title').allInnerTexts();
  expect(bottomTitles.at(-1)).toBe(title(0));
  bottomTitles.forEach((t, i) => expect(t).toBe(title(bottomTitles.length - 1 - i)));
  await expect(ul.locator('> li')).toHaveCount(250);
});

test('deep rows can be completed and edited in a virtualized list', async ({ page }) => {
  const workspaceId = await register(page);
  const ids = await seedTasks(workspaceId, 250);
  await page.goto('/tasks');
  await loadAllPages(page, 250);

  // Complete the oldest row (deepest in the list).
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect(rowByTitle(page, 0)).toHaveCount(1);
  await rowByTitle(page, 0).locator('button.check').click();
  await expect(page.locator('.sr-only').filter({ hasText: 'Completed: Virtual task 000' })).toBeVisible();
  await expect(statusLine(page, /^50 tasks loaded — more available\.$/)).toBeVisible();
  const done = await connection.db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, ids[0]!));
  expect(done[0]?.status).toBe('COMPLETED');

  // Edit the deepest loaded row (task 200 after the reload to the first page).
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect(rowByTitle(page, 200)).toHaveCount(1);
  await rowByTitle(page, 200).locator('.task-title').click();
  const dialog = page.getByRole('dialog', { name: 'Edit task' });
  await expect(dialog).toBeVisible();
  await page.locator('#edit-title').fill('Virtual task 200 (edited)');
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(`li[data-task-id="${ids[200]}"] .task-title`)).toHaveText('Virtual task 200 (edited)');
});

test('selection persists across scrolling and more than 100 loaded tasks are gated', async ({ page }) => {
  const workspaceId = await register(page);
  const ids = await seedTasks(workspaceId, 250);
  await page.goto('/tasks');
  await loadAllPages(page, 250);

  await expect(page.getByRole('button', { name: 'Select loaded tasks' })).toBeDisabled();
  await expect(page.getByText('More than 100 tasks are loaded. Select up to 100 individually.')).toBeVisible();

  await page.getByRole('checkbox', { name: `Select "${title(249)}"` }).check();
  await page.getByRole('checkbox', { name: `Select "${title(248)}"` }).check();
  await expect(statusLine(page, /^2 tasks selected \(maximum 100\)\.$/)).toBeVisible();

  // Scroll away and back: the selected rows unmount/remount as placeholders without losing selection.
  // Blur first: the checks above focused a row checkbox, and a focused row is pinned in the window.
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect(page.locator(`li[data-task-id="${ids[249]}"]`)).toHaveCount(0);
  await expect(page.locator('[data-virtual-placeholder] button, [data-virtual-placeholder] input, [data-virtual-placeholder] a')).toHaveCount(0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(page.locator(`li[data-task-id="${ids[249]}"]`)).toHaveCount(1);
  await expect(page.getByRole('checkbox', { name: `Select "${title(249)}"` })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: `Select "${title(248)}"` })).toBeChecked();
  await expect(statusLine(page, /^2 tasks selected \(maximum 100\)\.$/)).toBeVisible();

  await page.on('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Complete selected' }).click();
  await expect(statusLine(page, /^2 tasks completed\. 0 tasks selected\.$/)).toBeVisible();
  await expect(statusLine(page, /^50 tasks loaded — more available\.$/)).toBeVisible();
  const completed = await connection.db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, ids[248]!));
  expect(completed[0]?.status).toBe('COMPLETED');
  const completed2 = await connection.db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, ids[249]!));
  expect(completed2[0]?.status).toBe('COMPLETED');
});

test('lists at or below 200 rows render unchanged and the empty state is preserved', async ({ page }) => {
  const workspaceId = await register(page);
  await seedTasks(workspaceId, 3);
  await page.goto('/tasks');
  await expect(statusLine(page, /^3 tasks loaded\.$/)).toBeVisible();
  await expect(page.locator('ul[data-virtualized]')).toHaveCount(0);
  await expect(page.locator('li[data-task-id]')).toHaveCount(3);
  await expect(page.locator('[data-virtual-placeholder]')).toHaveCount(0);
  await expect(page.locator('button.check').first()).toBeVisible();

  // A second, empty workspace: the usual empty state, no list at all.
  const browser = page.context().browser()!;
  const emptyContext = await browser.newContext();
  const emptyPage = await emptyContext.newPage();
  try {
    const r = await emptyContext.request.post('/api/v1/auth/register', {
      headers: { ...origin, 'X-Forwarded-For': nextIp() },
      data: { email: `virtual-empty-${randomUUID()}@test.local`, password: 'virtual-test-password-123', timeZone: 'UTC' },
    });
    expect(r.status()).toBe(200);
    await emptyPage.goto('/tasks');
    await expect(emptyPage.locator('.empty-title', { hasText: 'No matching tasks' })).toBeVisible();
    await expect(emptyPage.getByText('Try fewer filters or reset to active tasks across the workspace.')).toBeVisible();
    await expect(emptyPage.locator('ul[data-virtualized]')).toHaveCount(0);
    await expect(emptyPage.locator('[data-virtual-placeholder]')).toHaveCount(0);
  } finally {
    await emptyContext.close();
  }
});

test('virtualized list keeps focus pinned and passes axe', async ({ page }) => {
  const workspaceId = await register(page);
  const ids = await seedTasks(workspaceId, 250);
  await page.goto('/tasks');
  await loadAllPages(page, 250);
  const realRows = page.locator('ul[data-virtualized="true"] > li[data-task-id]');

  // Row controls are keyboard focusable.
  const firstCheck = realRows.first().locator('button.check');
  await firstCheck.focus();
  const focusedAtTop = await page.evaluate(() => document.activeElement?.closest('li')?.getAttribute('data-task-id'));
  expect(focusedAtTop).toBe(ids[249]);

  // Focus a row outside the initial window (display index 30 = task 219), then scroll to the
  // top: the focused row stays mounted while the rendered window remains bounded —
  // the pin extends the window, it never replaces it.
  const probeTop = await page.locator('[data-task-index="30"]').evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
  await page.evaluate((top) => window.scrollTo(0, top - 100), probeTop);
  await expect(rowByTitle(page, 219)).toHaveCount(1);
  await rowByTitle(page, 219).locator('button.check').focus();
  const focusedId = await page.evaluate(() => document.activeElement?.closest('li')?.getAttribute('data-task-id'));
  expect(focusedId).toBe(ids[219]);
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(page.locator(`li[data-task-id="${focusedId}"]`)).toHaveCount(1);
  const pinnedCount = await realRows.count();
  expect(pinnedCount).toBeGreaterThan(20);
  expect(pinnedCount).toBeLessThan(200);

  const { default: AxeBuilder } = await import('@axe-core/playwright');
  const results = await new AxeBuilder({ page }).include('section[aria-label="Task results"]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(results.violations).toEqual([]);
});

test('task reads and mutations for a virtualized list stay tenant scoped', async ({ page, playwright }) => {
  const workspaceId = await register(page);
  const ids = await seedTasks(workspaceId, 250);

  const anonymous = await playwright.request.newContext({ baseURL: 'http://localhost:3100' });
  try {
    expect((await anonymous.get(`/api/v1/tasks?workspaceId=${workspaceId}&limit=50`)).status()).toBe(401);
  } finally {
    await anonymous.dispose();
  }

  const foreign = await playwright.request.newContext({ baseURL: 'http://localhost:3100' });
  try {
    const r = await foreign.post('/api/v1/auth/register', {
      headers: { ...origin, 'X-Forwarded-For': nextIp() },
      data: { email: `virtual-foreign-${randomUUID()}@test.local`, password: 'virtual-test-password-123', timeZone: 'UTC' },
    });
    expect(r.status()).toBe(200);
    expect((await foreign.post(`/api/v1/tasks/${ids[0]}/complete`, {
      headers: { ...origin, 'Idempotency-Key': randomUUID() },
      data: { version: 1 },
    })).status()).toBe(404);
    const stillActive = await connection.db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, ids[0]!));
    expect(stillActive[0]?.status).toBe('ACTIVE');
  } finally {
    await foreign.dispose();
  }
});
