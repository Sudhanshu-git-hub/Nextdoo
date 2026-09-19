import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { createDb, tasks, calendarConnections } from '@nextdoo/db';

/**
 * M3 provider-aware capacity planning (PRD §5.2, §8.3, §13.2, §14.3, §18.1).
 *
 * Browser/API acceptance:
 *  - the Today view uses the server's full-collection workload and the
 *    provider-aware capacity rule (overload warning; no feasibility claim
 *    while a connected calendar has not synced — "calendar sync delayed");
 *  - disconnecting a calendar restores known capacity;
 *  - capacity and connections are auth- and tenant-scoped (401/404);
 *  - workday configuration changes recompute capacity;
 *  - settings show plan-aware connection usage (FREE boundary 1 of 1).
 */

const connection = createDb(process.env.DATABASE_URL!, { max: 2 });
test.afterAll(() => connection.close());

const origin = { Origin: 'http://localhost:3100' };
let ipCounter = 90;
const nextIp = () => `198.51.100.${ipCounter++}`;

const TOKEN_MARKER = 'e2e-capacity-token-marker-abc123';

async function register(page: Page): Promise<{ id: string; workspaceId: string }> {
  const r = await page.request.post('/api/v1/auth/register', {
    headers: { ...origin, 'X-Forwarded-For': nextIp() },
    data: { email: `capacity-${randomUUID()}@test.local`, password: 'capacity-test-123', timeZone: 'UTC' },
  });
  expect(r.status()).toBe(200);
  return (await r.json()) as { id: string; workspaceId: string };
}

async function seedTask(workspaceId: string, estimateMinutes: number, dueAt: Date): Promise<void> {
  await connection.db.insert(tasks).values({
    id: randomUUID(),
    workspaceId,
    title: `Capacity E2E ${randomUUID().slice(0, 8)}`,
    status: 'ACTIVE',
    priority: 'NONE',
    estimateMinutes,
    dueAt,
    timeZone: 'UTC',
  });
}

async function seedConnection(userId: string, workspaceId: string, status = 'ACTIVE'): Promise<string> {
  const id = randomUUID();
  await connection.db.insert(calendarConnections).values({
    id,
    userId,
    workspaceId,
    provider: 'google',
    status,
    mode: 'READ_ONLY',
    accessTokenEncrypted: `v1.e2e.${TOKEN_MARKER}.e2e`,
  });
  return id;
}

const todayKey = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
/** Noon of the current UTC day — always "today", immune to near-midnight runs. */
const todayNoon = () => new Date(`${todayKey()}T12:00:00Z`);
const tomorrowNoon = () => new Date(todayNoon().getTime() + 86_400_000);

test('Today reports the full-collection workload and overload, not just the loaded page', async ({ page }) => {
  const { workspaceId } = await register(page);
  for (let i = 0; i < 60; i++) await seedTask(workspaceId, 30, todayNoon()); // 1,800 min today
  await seedTask(workspaceId, 999, tomorrowNoon()); // tomorrow: excluded

  await page.goto('/today');
  // 60 due tasks: the list loads the first page (50), but the planning banner
  // must reflect ALL of them — server-computed workload.
  await expect(page.getByRole('status').filter({ hasText: /^50 tasks loaded — more available\.$/ })).toBeVisible();
  await expect(
    page.getByRole('status').filter({
      hasText: /You have planned 30h of work in tasks due today\. Your configured workday is 8h — 22h over\./,
    }),
  ).toBeVisible();
  await expect(page.locator('.subtitle')).toContainText('· 30h planned today');
});

test('a connected-but-unsynced calendar blocks feasibility claims until disconnected', async ({ page }) => {
  const { id: userId, workspaceId } = await register(page);
  const connectionId = await seedConnection(userId, workspaceId);
  await seedTask(workspaceId, 300, todayNoon());

  await page.goto('/today');
  await expect(
    page.getByRole('status').filter({ hasText: /A calendar is connected but its sync data hasn.*t caught up \(calendar sync delayed\)/ }),
  ).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: /You have planned 5h in tasks due today\./ })).toBeVisible();
  // No overload claim may be made while capacity is unknown.
  await expect(page.getByRole('status').filter({ hasText: /exceeds|over\./ })).toHaveCount(0);

  // Disconnect (PRD §14.3) — soft state change, tenant-scoped.
  const del = await page.request.delete(`/api/v1/calendar/connections/${connectionId}`, {
    headers: { ...origin, 'Idempotency-Key': randomUUID() },
  });
  expect(del.status()).toBe(200);
  expect(((await del.json()) as { status: string }).status).toBe('DISCONNECTED');

  await page.reload();
  await expect(page.getByRole('status').filter({ hasText: /calendar sync delayed/ })).toHaveCount(0);
  // 300 min planned vs 480 min workday → known, not overloaded → no banner.
  await expect(page.getByRole('status').filter({ hasText: /planned \d+h? ?\d*m? of work in tasks due today/ })).toHaveCount(0);
  await expect(page.locator('.subtitle')).toContainText('· 5h planned today');

  // The list endpoint never exposes credentials.
  const list = await page.request.get('/api/v1/calendar/connections');
  expect(list.status()).toBe(200);
  const body = (await list.json()) as { connections: Array<{ provider: string; status: string }> };
  expect(body.connections).toHaveLength(1);
  expect(body.connections[0]).toMatchObject({ provider: 'google', status: 'DISCONNECTED' });
  expect(JSON.stringify(body)).not.toContain(TOKEN_MARKER);
});

test('capacity and connections are auth- and tenant-scoped', async ({ page, playwright }) => {
  const a = await register(page);
  const connectionIdA = await seedConnection(a.id, a.workspaceId);

  // Anonymous: 401 everywhere.
  const anon = await playwright.request.newContext({ baseURL: 'http://localhost:3100' });
  try {
    expect((await anon.get(`/api/v1/calendar/capacity?workspaceId=${a.workspaceId}&date=${todayKey()}`)).status()).toBe(401);
    expect((await anon.get('/api/v1/calendar/connections')).status()).toBe(401);
  } finally {
    await anon.dispose();
  }

  // User B: foreign workspace → 404 (no cross-tenant reads), own list empty.
  const foreign = await playwright.request.newContext({ baseURL: 'http://localhost:3100' });
  try {
    const reg = await foreign.post('/api/v1/auth/register', {
      headers: { ...origin, 'X-Forwarded-For': nextIp() },
      data: { email: `capacity-foreign-${randomUUID()}@test.local`, password: 'capacity-test-123', timeZone: 'UTC' },
    });
    expect(reg.status()).toBe(200);
    // Cross-tenant workspace access is rejected by assertWorkspaceAccess (403).
    expect((await foreign.get(`/api/v1/calendar/capacity?workspaceId=${a.workspaceId}&date=${todayKey()}`)).status()).toBe(403);
    expect(
      (
        await foreign.delete(`/api/v1/calendar/connections/${connectionIdA}`, {
          headers: { ...origin, 'Idempotency-Key': randomUUID() },
        })
      ).status(),
    ).toBe(404);
    const own = await foreign.get('/api/v1/calendar/connections');
    expect(own.status()).toBe(200);
    expect((await own.json() as { connections: unknown[] }).connections).toEqual([]);
    // A's connection is untouched.
    const still = await page.request.get('/api/v1/calendar/connections');
    expect(((await still.json()) as { connections: Array<{ status: string }> }).connections[0]!.status).toBe('ACTIVE');
  } finally {
    await foreign.dispose();
  }
});

test('changing the workday configuration recomputes capacity', async ({ page }) => {
  const { workspaceId } = await register(page);
  await seedTask(workspaceId, 200, todayNoon());

  const cap = async () => {
    const r = await page.request.get(`/api/v1/calendar/capacity?workspaceId=${workspaceId}&date=${todayKey()}`);
    expect(r.status()).toBe(200);
    return (await r.json()) as { status: string; capacityMinutes: number | null; overByMinutes: number | null };
  };

  // 200 min planned vs 480 min workday → OK.
  expect(await cap()).toMatchObject({ status: 'OK', capacityMinutes: 480, overByMinutes: 0 });

  // Shrink the workday to 09:00–11:00 (120 min) → overload by 80.
  const ws = await page.request.get(`/api/v1/workspaces/${workspaceId}`);
  expect(ws.status()).toBe(200);
  const { version } = (await ws.json()) as { version: number };
  const patch = await page.request.patch(`/api/v1/workspaces/${workspaceId}`, {
    headers: { ...origin, 'Idempotency-Key': randomUUID() },
    data: { version, workdayStartMinute: 540, workdayEndMinute: 660 },
  });
  expect(patch.status()).toBe(200);
  expect(await cap()).toMatchObject({ status: 'OVERLOADED', capacityMinutes: 120, overByMinutes: 80 });

  // The Today view reflects the re-computed day.
  await page.goto('/today');
  await expect(
    page.getByRole('status').filter({ hasText: /You have planned 3h 20m of work in tasks due today\. Your configured workday is 2h — 1h 20m over\./ }),
  ).toBeVisible();
});

test('settings show plan-aware connection usage at the FREE boundary', async ({ page }) => {
  const { id: userId, workspaceId } = await register(page);
  await seedConnection(userId, workspaceId);

  await page.goto('/settings');
  await expect(page.getByText('Calendar connections')).toBeVisible();
  await expect(page.getByText('1 of 1')).toBeVisible();
  // A second user without connections sees the empty usage.
  const empty = await page.context().browser()!.newContext();
  try {
    const reg = await empty.request.post('/api/v1/auth/register', {
      headers: { ...origin, 'X-Forwarded-For': nextIp() },
      data: { email: `capacity-empty-${randomUUID()}@test.local`, password: 'capacity-test-123', timeZone: 'UTC' },
    });
    expect(reg.status()).toBe(200);
    const p = await empty.newPage();
    await p.goto('/settings');
    await p.getByText('Calendar connections').waitFor();
    expect(await p.getByText('0 of 1').count()).toBe(1);
  } finally {
    await empty.close();
  }
});
