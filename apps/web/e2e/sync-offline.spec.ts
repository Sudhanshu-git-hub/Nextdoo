import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * Offline capture, cache fallback and reconnect/reconciliation (PRD §10, M5).
 *
 * Uses real browser offline mode (Playwright context.setOffline) — no mocked
 * fetches — so the queue, IndexedDB cache and reconciliation are exercised
 * exactly as a disconnected device would exercise them.
 */

const XFF = '198.51.100.201';

async function register(page: Page, prefix: string): Promise<{ workspaceId: string }> {
  const r = await page.request.post('/api/v1/auth/register', {
    headers: { Origin: 'http://localhost:3100', 'X-Forwarded-For': XFF },
    data: { email: `${prefix}-${randomUUID()}@test.local`, password: `${prefix}-password-123`, timeZone: 'UTC' },
  });
  expect(r.status()).toBe(200);
  const body = await r.json();
  return { workspaceId: body.workspaceId };
}

async function serverTaskTitles(page: Page, workspaceId: string): Promise<string[]> {
  const r = await page.request.get(`/api/v1/tasks?workspaceId=${workspaceId}`);
  expect(r.status()).toBe(200);
  const body = (await r.json()) as { data: Array<{ title: string }> };
  return body.data.map((t) => t.title);
}

/** Reads the raw tasks cache store so tenant scoping can be asserted without app code. */
async function idbTaskRows(page: Page): Promise<Array<{ id: string; workspaceId: string; title: string }>> {
  return page.evaluate(async () => new Promise((resolve) => {
    const request = indexedDB.open('nextdoo', 3);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('tasks')) db.createObjectStore('tasks', { keyPath: 'id' });
    };
    request.onsuccess = () => {
      const db = request.result;
      const get = db.transaction('tasks', 'readonly').objectStore('tasks').getAll();
      get.onsuccess = () => resolve((get.result as Array<{ id: string; workspaceId: string; title: string }>) ?? []);
      get.onerror = () => resolve([]);
    };
    request.onerror = () => resolve([]);
  }));
}

test('offline capture is queued, survives reconnect, and reconciles onto the server', async ({ page, context }) => {
  const { workspaceId } = await register(page, 'sync-off');
  await page.goto('/today');
  await expect(page.getByRole('heading', { name: 'Due today', exact: true })).toBeVisible();

  await context.setOffline(true);
  await page.locator('#capture').fill('Water the plants today');
  await page.getByRole('button', { name: 'Add', exact: true }).click();

  // The deterministic parser still asks for confirmation on a 75%-confidence
  // date — and that confirmation flow works with no connection at all.
  await expect(page.getByRole('group', { name: 'Confirm interpreted task details' })).toBeVisible();
  await page.getByRole('button', { name: 'Save as shown', exact: true }).click();

  // The capture is acknowledged locally — nothing is lost or silently dropped.
  await expect(page.getByText('Saved offline: "Water the plants"')).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: '1 change queued' })).toBeVisible();
  // The optimistic local row is visible even though no request succeeded.
  await expect(page.locator('.task-title', { hasText: 'Water the plants' })).toBeVisible();
  expect(await serverTaskTitles(page, workspaceId)).not.toContain('Water the plants');

  // Reconnect: the queue drains and the canonical row arrives on the server.
  await context.setOffline(false);
  await expect(page.getByRole('status').filter({ hasText: '1 change queued' })).toHaveCount(0, { timeout: 20000 });
  await expect
    .poll(async () => serverTaskTitles(page, workspaceId), { timeout: 20000 })
    .toContain('Water the plants');
  // The same client entity id is the server id — a replay can never make a twin.
  const rows = await idbTaskRows(page);
  const local = rows.find((r) => r.title === 'Water the plants');
  expect(local).toBeDefined();
  expect(await serverTaskTitles(page, workspaceId)).toEqual(expect.arrayContaining(['Water the plants']));
  const created = (await (await page.request.get(`/api/v1/tasks?workspaceId=${workspaceId}`)).json()) as { data: Array<{ id: string; title: string }> };
  expect(created.data.find((t) => t.title === 'Water the plants')?.id).toBe(local?.id);
});

test('Today falls back to the cached copy when the refetch fails and recovers on reconnect', async ({ page, context }) => {
  const { workspaceId } = await register(page, 'sync-cache');
  for (const title of ['Cache alpha task', 'Cache beta task']) {
    const r = await page.request.post('/api/v1/tasks', {
      headers: { Origin: 'http://localhost:3100', 'Idempotency-Key': randomUUID() },
      // Today lists work due today or overdue — an undated task would not appear.
      data: { workspaceId, title, tagIds: [], dueAt: new Date().toISOString() },
    });
    expect(r.status()).toBe(200);
  }

  await page.goto('/today');
  await expect(page.locator('.task-title', { hasText: 'Cache alpha task' })).toBeVisible();
  await expect(page.locator('.task-title', { hasText: 'Cache beta task' })).toBeVisible();

  // Go offline. A capture then triggers a refetch that cannot reach the
  // server, so Today must fall back to the cached copy it saved while online.
  await context.setOffline(true);
  await page.locator('#capture').fill('Fallback probe task');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('Showing your last saved copy')).toBeVisible();
  await expect(page.locator('.task-title', { hasText: 'Cache alpha task' })).toBeVisible();
  await expect(page.locator('.task-title', { hasText: 'Cache beta task' })).toBeVisible();

  // Reconnect: reconcile drains the probe create and refreshes from the
  // server — the stale banner clears and live data returns.
  await context.setOffline(false);
  await expect(page.getByText('Showing your last saved copy')).toHaveCount(0, { timeout: 20000 });
  await expect(page.locator('.task-title', { hasText: 'Cache alpha task' })).toBeVisible();
  await expect(page.locator('.task-title', { hasText: 'Cache beta task' })).toBeVisible();
  await expect
    .poll(async () => serverTaskTitles(page, workspaceId), { timeout: 20000 })
    .toContain('Fallback probe task');
});

test('an account can never see another account\'s offline queue or cache', async ({ page, context, browser: browser_ }) => {
  const browser = browser_ as Browser;
  const { workspaceId: workspaceA } = await register(page, 'sync-ten-a');
  await page.goto('/today');

  await context.setOffline(true);
  await page.locator('#capture').fill('Secret offline task from A');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('Saved offline: "Secret offline task from A"')).toBeVisible();

  // A's local store holds it, scoped to A's workspace.
  const rowsA = await idbTaskRows(page);
  expect(rowsA.some((r) => r.title === 'Secret offline task from A' && r.workspaceId === workspaceA)).toBe(true);

  // A separate profile with a separate account.
  const origin = new URL(page.url()).origin;
  const ctxB = await browser.newContext({ baseURL: origin, timezoneId: 'UTC' });
  const pageB = await ctxB.newPage();
  const { workspaceId: workspaceB } = await register(pageB, 'sync-ten-b');
  expect(workspaceB).not.toBe(workspaceA);
  await pageB.goto('/today');

  await expect(pageB.getByText('Secret offline task from A')).toHaveCount(0);
  const rowsB = await idbTaskRows(pageB);
  expect(rowsB.some((r) => r.title === 'Secret offline task from A')).toBe(false);
  expect(await serverTaskTitles(pageB, workspaceB)).not.toContain('Secret offline task from A');
  // A is still offline, so the server holds nothing for A either.
  expect(await serverTaskTitles(page, workspaceA)).not.toContain('Secret offline task from A');

  await ctxB.close();
});
