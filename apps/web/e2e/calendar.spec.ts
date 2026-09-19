import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { createDb, tasks } from '@nextdoo/db';
const connection = createDb(process.env.DATABASE_URL!, { max: 2 });
test.afterAll(() => connection.close());

const origin = { Origin: 'http://localhost:3100' };
let ipCounter = 40;
const nextIp = () => `198.51.100.${ipCounter++}`;
const KOLKATA = 'Asia/Kolkata'; // fixed UTC+5:30, no DST
const IST = 5.5 * 3600000;

/** UTC instant whose Kolkata wall time is the given local fields. */
const kolInstant = (y: number, m: number, d: number, h = 0, min = 0) =>
  new Date(Date.UTC(y, m - 1, d, h, min) - IST).toISOString();
/** Kolkata local date fields of now (or an instant). */
const kolNow = () => { const k = new Date(Date.now() + IST); return { y: k.getUTCFullYear(), m: k.getUTCMonth() + 1, d: k.getUTCDate() }; };
const addDay = ({ y, m, d }: { y: number; m: number; d: number }) => { const n = new Date(Date.UTC(y, m - 1, d + 1)); return { y: n.getUTCFullYear(), m: n.getUTCMonth() + 1, d: n.getUTCDate() }; };
const subDay = ({ y, m, d }: { y: number; m: number; d: number }) => { const n = new Date(Date.UTC(y, m - 1, d - 1)); return { y: n.getUTCFullYear(), m: n.getUTCMonth() + 1, d: n.getUTCDate() }; };
/** Monday (weekStart = 1) of the current Kolkata week. */
const thisMonday = () => { const n = new Date(Date.now() + IST); const back = (n.getUTCDay() - 1 + 7) % 7; n.setUTCDate(n.getUTCDate() - back); return { y: n.getUTCFullYear(), m: n.getUTCMonth() + 1, d: n.getUTCDate() }; };

async function fixture(page: Page): Promise<string> {
  const r = await page.request.post('/api/v1/auth/register', {
    headers: { ...origin, 'X-Forwarded-For': nextIp() },
    data: { email: `calendar-${randomUUID()}@test.local`, password: 'calendar-test-password-123', timeZone: 'UTC' },
  });
  expect(r.status()).toBe(200);
  const { workspaceId } = await r.json() as { workspaceId: string };
  // Deterministic calendar semantics: Kolkata time zone, Monday weeks.
  const ws = await (await page.request.get(`/api/v1/workspaces/${workspaceId}`)).json() as { version: number };
  const p = await page.request.patch(`/api/v1/workspaces/${workspaceId}`, {
    headers: { ...origin, 'Idempotency-Key': randomUUID() },
    data: { version: ws.version, timeZone: KOLKATA, weekStart: 1 },
  });
  expect(p.status()).toBe(200);
  return workspaceId;
}

async function create(page: Page, workspaceId: string, title: string, dueAt: string, extra: Record<string, unknown> = {}) {
  const r = await page.request.post('/api/v1/tasks', {
    headers: { ...origin, 'Idempotency-Key': randomUUID() },
    data: { workspaceId, title, dueAt, ...extra },
  });
  expect(r.status()).toBe(200);
  return (await r.json()) as { id: string; version: number; dueAt: string; status: string };
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const chip = (page: Page, title: string) =>
  page.locator('.cal-chip').filter({ has: page.locator('.cal-title', { hasText: new RegExp(`^${esc(title)}$`) }) });
const cellContaining = (page: Page, title: string) =>
  page.locator('[role="listitem"]').filter({ has: chip(page, title) });

test('week view places tasks on local days and supports move, edit, complete and navigation', async ({ page }) => {
  const workspaceId = await fixture(page);
  const mon = thisMonday();
  const weekEnd = await create(page, workspaceId, 'Week end', kolInstant(mon.y, mon.m, mon.d + 4, 23, 59)); // Friday 23:59 IST
  const start = await create(page, workspaceId, 'Week start', kolInstant(mon.y, mon.m, mon.d, 9, 0)); // Monday 09:00 IST
  await create(page, workspaceId, 'Next week', kolInstant(mon.y, mon.m, mon.d + 7, 0, 0)); // following Monday 00:00 IST

  await page.goto('/calendar');
  await expect(page.getByRole('listitem')).toHaveCount(7);
  await expect(cellContaining(page, 'Week start')).toContainText('Mon');
  await expect(cellContaining(page, 'Week end')).toContainText('Fri');
  await expect(chip(page, 'Next week')).toHaveCount(0);
  // Time-of-day is displayed with the task.
  await expect(chip(page, 'Week start').locator('.cal-time')).toHaveText(/9:00|09:00/);

  // Move Friday 23:59 to Saturday, preserving the time.
  await chip(page, 'Week end').locator('.cal-title').click();
  await expect(page.getByRole('group', { name: 'Move task' })).toContainText('Week end');
  await page.getByRole('listitem').nth(5).getByRole('button', { name: 'Move here', exact: true }).click();
  await expect(page.locator('.sr-only').filter({ hasText: 'Moved "Week end" to Saturday' })).toBeVisible();
  const moved = await (await page.request.get(`/api/v1/tasks/${weekEnd.id}`)).json() as { dueAt: string };
  expect(new Date(moved.dueAt).toISOString()).toBe(kolInstant(mon.y, mon.m, mon.d + 5, 23, 59));
  await expect(cellContaining(page, 'Week end')).toContainText('Sat');

  // Edit from the calendar opens the shared editor and persists.
  await chip(page, 'Week start').getByRole('button', { name: 'Edit "Week start"' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit task' });
  await expect(dialog).toBeVisible();
  await page.locator('#edit-title').fill('Week start (edited)');
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(chip(page, 'Week start (edited)')).toBeVisible();

  // Complete from the calendar with the acknowledged-completion semantics.
  await chip(page, 'Week start (edited)').locator('.check').click();
  await expect(page.locator('.sr-only').filter({ hasText: 'Completed: Week start (edited)' })).toBeVisible();
  await expect(chip(page, 'Week start (edited)')).toHaveClass(/cal-done/);
  const done = await (await page.request.get(`/api/v1/tasks/${start.id}`)).json() as { status: string };
  expect(done.status).toBe('COMPLETED');

  // Navigation: the following week shows the Monday-00:00 task, not the current week's.
  await page.getByRole('button', { name: 'Next week →', exact: true }).click();
  await expect(chip(page, 'Next week')).toBeVisible();
  await expect(chip(page, 'Week end')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'This week', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'This week', exact: true }).click();
  await expect(chip(page, 'Week end')).toBeVisible();
  await expect(page.getByRole('button', { name: 'This week', exact: true })).toBeDisabled();
});

test('day view shows one local day with time ordering and task actions', async ({ page }) => {
  const workspaceId = await fixture(page);
  const today = kolNow();
  await create(page, workspaceId, 'Late today', kolInstant(today.y, today.m, today.d, 18, 30));
  const early = await create(page, workspaceId, 'Early today', kolInstant(today.y, today.m, today.d, 9, 0));
  await create(page, workspaceId, 'Tomorrow task', kolInstant(today.y, today.m, today.d + 1, 9, 0));

  await page.goto('/calendar');
  await page.getByRole('button', { name: 'Day', exact: true }).click();
  await expect(page.getByRole('listitem')).toHaveCount(1);
  await expect(chip(page, 'Early today')).toBeVisible();
  await expect(chip(page, 'Late today')).toBeVisible();
  await expect(chip(page, 'Tomorrow task')).toHaveCount(0);
  // Time ordering within the day.
  const earlyTop = await chip(page, 'Early today').evaluate((el) => el.getBoundingClientRect().top);
  const lateTop = await chip(page, 'Late today').evaluate((el) => el.getBoundingClientRect().top);
  expect(earlyTop).toBeLessThan(lateTop);
  await expect(chip(page, 'Late today').locator('.cal-time')).toHaveText(/6:30|18:30/);

  // In the day view the title opens the editor (there is no other day to move to).
  await chip(page, 'Early today').locator('.cal-title').click();
  const dialog = page.getByRole('dialog', { name: 'Edit task' });
  await expect(dialog).toBeVisible();
  await page.locator('#edit-title').fill('Early today (renamed)');
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(chip(page, 'Early today (renamed)')).toBeVisible();

  // Complete from the day view.
  await chip(page, 'Late today').locator('.check').click();
  await expect(page.locator('.sr-only').filter({ hasText: 'Completed: Late today' })).toBeVisible();
  await expect(chip(page, 'Late today')).toHaveClass(/cal-done/);
  const done = await (await page.request.get(`/api/v1/tasks/${early.id}`)).json() as { status: string };
  expect(done.status).toBe('ACTIVE'); // Early today was only renamed, not completed

  // Day navigation and the Today reset.
  await page.getByRole('button', { name: 'Next day →', exact: true }).click();
  await expect(chip(page, 'Tomorrow task')).toBeVisible();
  await expect(chip(page, 'Early today (renamed)')).toHaveCount(0);
  await page.getByRole('button', { name: 'Today', exact: true }).click();
  await expect(chip(page, 'Tomorrow task')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Today', exact: true })).toBeDisabled();
});

test('month view shows a 42-cell grid with adjacent-month cells, cell move and navigation', async ({ page }) => {
  const workspaceId = await fixture(page);
  const month = kolNow();
  const prevLast = subDay({ y: month.y, m: month.m, d: 1 });
  const lastOfThisMonth = new Date(Date.UTC(month.y, month.m, 0)).getUTCDate();
  const nextFirst = addDay({ y: month.y, m: month.m, d: lastOfThisMonth });
  await create(page, workspaceId, 'Month prev', kolInstant(prevLast.y, prevLast.m, prevLast.d, 23, 0));
  const early = await create(page, workspaceId, 'Month early', kolInstant(month.y, month.m, 2, 10, 0));
  await create(page, workspaceId, 'Month next', kolInstant(nextFirst.y, nextFirst.m, nextFirst.d, 8, 0));

  await page.goto('/calendar');
  await page.getByRole('button', { name: 'Month', exact: true }).click();
  await expect(page.getByRole('listitem')).toHaveCount(42);
  await expect(chip(page, 'Month prev')).toBeVisible();
  await expect(chip(page, 'Month early')).toBeVisible();
  await expect(chip(page, 'Month next')).toBeVisible();
  // The leading cell shows the previous month's last day.
  const leadingDay = await cellContaining(page, 'Month prev').locator('.spread').last().innerText();
  expect(leadingDay.trim()).toBe(String(prevLast.d));

  // Selecting a task and clicking another day's header moves it (time preserved).
  await chip(page, 'Month early').locator('.cal-title').click();
  await expect(page.getByRole('group', { name: 'Move task' })).toContainText('Month early');
  const targetDay = addDay({ y: month.y, m: month.m, d: 2 });
  const targetCell = page.locator('[role="listitem"]').filter({ has: page.locator('.spread', { hasText: new RegExp(`^${targetDay.d}$`) }) }).first();
  await targetCell.locator('.spread').click();
  await expect(page.locator('.sr-only').filter({ hasText: 'Moved "Month early" to' })).toBeVisible();
  const moved = await (await page.request.get(`/api/v1/tasks/${early.id}`)).json() as { dueAt: string };
  expect(new Date(moved.dueAt).toISOString()).toBe(kolInstant(targetDay.y, targetDay.m, targetDay.d, 10, 0));

  // Month navigation: the next month contains "Month next" but not "Month early".
  await page.getByRole('button', { name: 'Next month →', exact: true }).click();
  await expect(chip(page, 'Month next')).toBeVisible();
  await expect(chip(page, 'Month early')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'This month', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'This month', exact: true }).click();
  await expect(chip(page, 'Month early')).toBeVisible();
  await expect(page.getByRole('button', { name: 'This month', exact: true })).toBeDisabled();

  // A distant, empty month shows the empty note.
  await page.getByRole('button', { name: 'Next month →', exact: true }).click();
  await page.getByRole('button', { name: 'Next month →', exact: true }).click();
  await expect(page.getByText('No scheduled tasks in this period.')).toBeVisible();
});

test('the calendar paginates full weeks and months beyond 100 tasks', async ({ page }) => {
  const workspaceId = await fixture(page);
  const mon = thisMonday();
  // 120 tasks spread across the current Kolkata week (2.5 minutes apart).
  const base = new Date(kolInstant(mon.y, mon.m, mon.d)).getTime();
  const rows = Array.from({ length: 120 }, (_, i) => ({
    id: randomUUID(), workspaceId, title: `Cal page ${i}`,
    status: 'ACTIVE' as const, priority: 'NONE' as const,
    dueAt: new Date(base + i * 150000),
    createdAt: new Date(Date.now() - (120 - i) * 1000),
  }));
  for (let i = 0; i < rows.length; i += 100) await connection.db.insert(tasks).values(rows.slice(i, i + 100));

  const cursorRequests: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/api/v1/tasks?') && r.url().includes('cursor=')) cursorRequests.push(r.url()); });

  await page.goto('/calendar');
  await expect(page.locator('.cal-chip')).toHaveCount(120, { timeout: 20000 });
  await expect(chip(page, 'Cal page 0')).toHaveCount(1);
  await expect(chip(page, 'Cal page 59')).toHaveCount(1);
  await expect(chip(page, 'Cal page 119')).toHaveCount(1);
  expect(cursorRequests.length).toBeGreaterThanOrEqual(1);

  // The month grid of the week's Monday loads the same full set.
  const monMonthDiff = (mon.y * 12 + mon.m) - (kolNow().y * 12 + kolNow().m);
  await page.getByRole('button', { name: 'Month', exact: true }).click();
  if (monMonthDiff < 0) await page.getByRole('button', { name: '← Previous month', exact: true }).click();
  await expect(page.locator('.cal-chip')).toHaveCount(120, { timeout: 20000 });
});

test('day view honors local day edges in the workspace time zone', async ({ page }) => {
  const workspaceId = await fixture(page);
  const today = kolNow();
  await create(page, workspaceId, 'Day edge end', kolInstant(today.y, today.m, today.d, 23, 59));
  await create(page, workspaceId, 'Day edge start', kolInstant(today.y, today.m, today.d + 1, 0, 0));

  await page.goto('/calendar');
  await page.getByRole('button', { name: 'Day', exact: true }).click();
  await expect(chip(page, 'Day edge end')).toBeVisible();
  await expect(chip(page, 'Day edge start')).toHaveCount(0);
  await page.getByRole('button', { name: 'Next day →', exact: true }).click();
  await expect(chip(page, 'Day edge start')).toBeVisible();
  await expect(chip(page, 'Day edge end')).toHaveCount(0);
});

test('calendar shows loading skeletons and recovers from load errors via retry', async ({ page }) => {
  const workspaceId = await fixture(page);
  const today = kolNow();
  await create(page, workspaceId, 'Steady task', kolInstant(today.y, today.m, today.d, 12, 0));

  let phase: 'slow' | 'fail' = 'slow';
  await page.route('**/api/v1/tasks*', async (route) => {
    if (route.request().url().includes('cursor=')) return route.continue();
    if (phase === 'slow') {
      await new Promise((r) => setTimeout(r, 600));
      return route.continue();
    }
    phase = 'slow';
    return route.abort('failed');
  });

  await page.goto('/calendar');
  await expect(page.locator('.skeleton')).toHaveCount(7);
  await expect(chip(page, 'Steady task')).toBeVisible();

  phase = 'fail';
  await page.getByRole('button', { name: 'Next week →', exact: true }).click();
  await expect(page.locator('.banner-error')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.locator('.banner-error')).toHaveCount(0);
  await expect(page.getByText('No scheduled tasks in this period.')).toBeVisible();
});

test('calendar reads and mutations stay tenant scoped and views are accessible', async ({ page, playwright }) => {
  const workspaceId = await fixture(page);
  const today = kolNow();
  const task = await create(page, workspaceId, 'Isolated task', kolInstant(today.y, today.m, today.d, 11, 0));
  const mon = thisMonday();
  const listUrl = `/api/v1/tasks?workspaceId=${workspaceId}&dueAfter=${kolInstant(mon.y, mon.m, mon.d)}&dueBefore=${kolInstant(mon.y, mon.m, mon.d + 7)}&limit=100`;

  const anonymous = await playwright.request.newContext({ baseURL: 'http://localhost:3100' });
  try {
    expect((await anonymous.get(listUrl)).status()).toBe(401);
  } finally {
    await anonymous.dispose();
  }

  const foreign = await playwright.request.newContext({ baseURL: 'http://localhost:3100' });
  try {
    const r = await foreign.post('/api/v1/auth/register', {
      headers: { ...origin, 'X-Forwarded-For': nextIp() },
      data: { email: `calendar-foreign-${randomUUID()}@test.local`, password: 'calendar-test-password-123', timeZone: 'UTC' },
    });
    expect(r.status()).toBe(200);
    expect((await foreign.get(listUrl)).status()).toBe(403);
    expect((await foreign.post(`/api/v1/tasks/${task.id}/reschedule`, {
      headers: { ...origin, 'Idempotency-Key': randomUUID() },
      data: { version: task.version, dueAt: kolInstant(today.y, today.m, today.d, 12, 0), reason: 'not allowed' },
    })).status()).toBe(404);
  } finally {
    await foreign.dispose();
  }

  const { default: AxeBuilder } = await import('@axe-core/playwright');
  const tags = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];
  await page.goto('/calendar');
  await expect(chip(page, 'Isolated task')).toBeVisible();
  expect((await new AxeBuilder({ page }).include('main').withTags(tags).analyze()).violations).toEqual([]);
  await page.getByRole('button', { name: 'Month', exact: true }).click();
  await expect(chip(page, 'Isolated task')).toBeVisible();
  expect((await new AxeBuilder({ page }).include('main').withTags(tags).analyze()).violations).toEqual([]);
});
