import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

/**
 * Conflict resolution and multi-device reliability (PRD §8.6, §10.6, §10.8,
 * roadmap matrix SY-06–SY-09; M5 increment 2).
 *
 * Two browser contexts act as two devices of the SAME account: separate
 * localStorage (device ids), separate IndexedDB (queues/caches), shared
 * server. Network behavior uses real Chromium networking — Playwright route
 * handlers only shape what the (real) server response looks like.
 */

// Random per-request client IP (198.51.0.0/16 is TEST-NET-2, documentation
// range) so auth rate-limit buckets never accumulate across test runs.
const XFF = () => `198.51.100.${100 + Math.floor(Math.random() * 150)}`;

interface Account { email: string; password: string; workspaceId: string }

async function register(page: Page, prefix: string): Promise<Account> {
  const email = `${prefix}-${randomUUID()}@test.local`;
  const password = `${prefix}-password-123`;
  const r = await page.request.post('/api/v1/auth/register', {
    headers: { Origin: 'http://localhost:3100', 'X-Forwarded-For': XFF() },
    data: { email, password, timeZone: 'UTC' },
  });
  expect(r.status()).toBe(200);
  const body = (await r.json()) as { workspaceId: string };
  return { email, password, workspaceId: body.workspaceId };
}

/**
 * Signs the context in through the API so the context's cookie jar (shared
 * with its pages) is authenticated — no UI form, and the rotating
 * X-Forwarded-For keeps each login under its own per-IP budget.
 */
async function login(context: BrowserContext, account: Account) {
  const r = await context.request.post('/api/v1/auth/login', {
    headers: { Origin: 'http://localhost:3100', 'X-Forwarded-For': XFF() },
    data: { email: account.email, password: account.password },
  });
  expect(r.status()).toBe(200);
}

async function newContext(browser: Browser, account: Account): Promise<Page> {
  const context = await browser.newContext();
  await login(context, account);
  const page = await context.newPage();
  await page.goto('/today');
  await expect(page).toHaveURL(/\/today$/);
  return page;
}

async function serverTask(page: Page, workspaceId: string, title: string): Promise<{ id: string; version: number; title: string } | null> {
  const r = await page.request.get(`/api/v1/tasks?workspaceId=${workspaceId}`);
  expect(r.status()).toBe(200);
  const body = (await r.json()) as { data: Array<{ id: string; title: string; version: number }> };
  return body.data.find((t) => t.title === title) ?? null;
}

async function pushTitle(page: Page, workspaceId: string, deviceId: string, taskId: string, baseVersion: number, title: string) {
  const r = await page.request.post('/api/v1/sync/push', {
    headers: { Origin: 'http://localhost:3100' },
    data: {
      workspaceId,
      deviceId,
      mutations: [{
        mutationId: randomUUID(),
        entityType: 'task',
        entityId: taskId,
        operation: 'update',
        baseVersion,
        payload: { title },
        createdAt: new Date().toISOString(),
      }],
    },
  });
  expect(r.status()).toBe(200);
  return (await r.json()) as { results: Array<{ status: string }> };
}

test('two devices editing the same title: conflict is shown side-by-side and resolved by keyboard', async ({ browser }) => {
  test.setTimeout(120000);
  const probe = await browser.newPage();
  const account = await register(probe, 'conflict-ui');
  await probe.close();
  const pageA = await newContext(browser, account);
  const pageB = await newContext(browser, account);
  const deviceA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa101';
  const deviceB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb102';

  // Both devices are on the current version…
  const created = await pageA.request.post('/api/v1/tasks', {
    headers: { Origin: 'http://localhost:3100', 'Idempotency-Key': randomUUID() },
    data: { workspaceId: account.workspaceId, title: 'Adjudication baseline', tagIds: [] },
  });
  expect(created.status()).toBe(200);
  const task = (await created.json()) as { id: string; version: number };

  // …then A's edit lands first, and B's stale-base edit collides.
  const first = await pushTitle(pageA, account.workspaceId, deviceA, task.id, task.version, 'Version from device A');
  expect(first.results[0]!.status).toBe('applied');
  const second = await pushTitle(pageB, account.workspaceId, deviceB, task.id, task.version, 'Version from device B');
  expect(second.results[0]!.status).toBe('conflict');

  // Device A opens the conflict view: both versions, side by side, with metadata.
  await pageA.goto('/conflicts');
  const card = pageA.locator('article[data-conflict-id]');
  await expect(card).toHaveCount(1);
  await expect(card.getByRole('heading', { name: 'Version from device A' })).toBeVisible();
  await expect(card.locator('[data-local-value]', { hasText: 'Version from device B' })).toBeVisible();
  await expect(card.locator('[data-server-value]', { hasText: 'Version from device A' })).toBeVisible();
  await expect(card.getByText(new RegExp(deviceB))).toBeVisible();
  await expect(card.getByText(/recoverable until/)).toBeVisible();

  // Screen reader and keyboard: the choice is a real button, activated by Enter.
  const keepMyVersion = card.getByRole('button', { name: /Keep your version/ });
  await keepMyVersion.focus();
  await pageA.keyboard.press('Enter');

  await expect(pageA.getByRole('status').filter({ hasText: 'Resolved: your version was kept.' })).toBeVisible();
  await expect(pageA.locator('article[data-conflict-id]')).toHaveCount(0);
  const after = await serverTask(pageA, account.workspaceId, 'Version from device B');
  expect(after).not.toBeNull();

  // The snapshot is resolved (no longer listed), nothing was silently lost.
  const list = await pageA.request.get('/api/v1/sync/conflicts');
  expect(((await list.json()) as { data: unknown[] }).data).toHaveLength(0);

  // Device B's next pull carries the resolution — the account state converges.
  await pageB.goto('/inbox');
  await expect(pageB.locator('.task-title', { hasText: 'Version from device B' })).toBeVisible();
});

test('offline capture on one device appears on the other, and a deletion propagates as a tombstone', async ({ browser }) => {
  test.setTimeout(120000);
  const probe = await browser.newPage();
  const account = await register(probe, 'cross-dev');
  await probe.close();
  const pageA = await newContext(browser, account);
  const pageB = await newContext(browser, account);

  await pageA.goto('/inbox');
  await pageA.context().setOffline(true);
  await pageA.locator('#capture').fill('Cross device task');
  await pageA.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(pageA.getByText('Saved offline: "Cross device task"')).toBeVisible();
  await expect(pageA.getByRole('status').filter({ hasText: '1 change queued' })).toBeVisible();
  expect(await serverTask(pageA, account.workspaceId, 'Cross device task')).toBeNull();

  await pageA.context().setOffline(false);
  await expect(pageA.getByRole('status').filter({ hasText: '1 change queued' })).toHaveCount(0, { timeout: 20000 });
  await expect.poll(async () => serverTask(pageA, account.workspaceId, 'Cross device task'), { timeout: 20000 }).not.toBeNull();

  // Device B — a fresh load reconciles (pull) and shows the other device's work.
  await pageB.goto('/inbox');
  await expect(pageB.locator('.task-title', { hasText: 'Cross device task' })).toBeVisible();

  // A deletes it server-side; B's next reconcile must drop it locally too.
  const row = (await serverTask(pageB, account.workspaceId, 'Cross device task'))!;
  const del = await pageA.request.delete(`/api/v1/tasks/${row.id}`, {
    headers: { Origin: 'http://localhost:3100', 'Idempotency-Key': randomUUID() },
    data: { version: row.version },
  });
  expect(del.status()).toBe(200);

  await pageB.reload();
  await expect(pageB.locator('.task-title', { hasText: 'Cross device task' })).toHaveCount(0);
  // B's local cache is tombstone-cleaned (once its reconcile pull lands): a
  // later offline moment cannot resurrect the deleted task.
  await expect
    .poll(async () => (await pageB.evaluate(() => new Promise<Array<{ id: string }>>((resolve) => {
      const request = indexedDB.open('nextdoo', 3);
      request.onsuccess = () => {
        const db = request.result;
        const get = db.transaction('tasks', 'readonly').objectStore('tasks').getAll();
        get.onsuccess = () => resolve((get.result as Array<{ id: string }>) ?? []);
        get.onerror = () => resolve([]);
      };
      request.onerror = () => resolve([]);
    }))).some((t) => t.id === row.id), { timeout: 20000 })
    .toBe(false);
});

test('lost acknowledgements retry idempotently, and quarantine surfaces the content for a manual retry', async ({ browser }) => {
  test.setTimeout(180000);
  const probe = await browser.newPage();
  const account = await register(probe, 'lost-ack');
  await probe.close();
  const page = await newContext(browser, account);
  await page.goto('/inbox');

  // ---- Part 1: a reset connection loses the ack. The server may or may not
  // have applied it, but the mutationId dedup guarantees exactly one entity
  // no matter which — the client retries and the queue drains.
  let resets = 2;
  await page.route('**/api/v1/sync/push', async (route) => {
    if (resets > 0) {
      resets -= 1;
      await route.abort('connectionreset');
      return;
    }
    await route.continue();
  });

  await page.context().setOffline(true);
  await page.locator('#capture').fill('Retried after lost ack');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('Saved offline: "Retried after lost ack"')).toBeVisible();
  await page.context().setOffline(false);

  await expect(page.getByRole('status').filter({ hasText: '1 change queued' })).toHaveCount(0, { timeout: 45000 });
  await expect.poll(async () => serverTask(page, account.workspaceId, 'Retried after lost ack'), { timeout: 20000 }).not.toBeNull();
  const all = await page.request.get(`/api/v1/tasks?workspaceId=${account.workspaceId}`);
  expect(((await all.json()) as { data: Array<{ title: string }> }).data.filter((t) => t.title === 'Retried after lost ack')).toHaveLength(1);
  await page.unroute('**/api/v1/sync/push');

  // ---- Part 2: repeated 5xx failures quarantine the change; the UI shows the
  // full saved content and a retry, which then succeeds exactly once.
  let failures = 5;
  await page.route('**/api/v1/sync/push', async (route) => {
    if (failures > 0) {
      failures -= 1;
      await route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
      return;
    }
    await route.continue();
  });

  await page.reload();
  await page.context().setOffline(true);
  await page.locator('#capture').fill('Retried after quarantine');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('Saved offline: "Retried after quarantine"')).toBeVisible();
  await page.context().setOffline(false);

  // Backoff: 1s + 2s + 4s + 8s of failed attempts, then quarantine at 5.
  await expect(page.getByRole('status').filter({ hasText: /1 change need attention/ }), 'quarantine after 5 failed attempts').toBeVisible({ timeout: 60000 });

  // The badge points at the review surface.
  await page.getByRole('status').getByRole('link', { name: /need attention — review/ }).click();
  await expect(page).toHaveURL(/\/conflicts$/);

  const attention = page.locator('article[data-attention-mutation]');
  await expect(attention).toHaveCount(1);
  await expect(attention.getByRole('heading', { name: /create · Retried after quarantine/ })).toBeVisible();
  await expect(attention.getByText(/Sync HTTP 500/)).toBeVisible();
  await attention.locator('summary', { hasText: 'Full saved content' }).click();
  await expect(attention.locator('pre')).toContainText('"title": "Retried after quarantine"');

  // Unblock and retry from the UI.
  failures = 0;
  await attention.getByRole('button', { name: /Retry now/ }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Change re-sent and acknowledged.' })).toBeVisible();
  await expect(attention).toHaveCount(0);
  await expect.poll(async () => serverTask(page, account.workspaceId, 'Retried after quarantine'), { timeout: 20000 }).not.toBeNull();
  const final = await page.request.get(`/api/v1/tasks?workspaceId=${account.workspaceId}`);
  expect(((await final.json()) as { data: Array<{ title: string }> }).data.filter((t) => t.title === 'Retried after quarantine')).toHaveLength(1);
  await page.unroute('**/api/v1/sync/push');
});

test('the conflicts screen passes axe and is reachable from the badge', async ({ browser }) => {
  const probe = await browser.newPage();
  const account = await register(probe, 'conflict-a11y');
  await probe.close();
  const page = await newContext(browser, account);

  await page.goto('/conflicts');
  await expect(page.getByRole('heading', { name: 'Sync conflicts' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Conflicts to resolve' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Local changes needing attention' })).toBeVisible();
  await expect(page.getByText('No conflicts — every change applied cleanly.')).toBeVisible();

  const { default: AxeBuilder } = await import('@axe-core/playwright');
  expect((await new AxeBuilder({ page }).include('.conflicts-view').withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([]);

  // Sidebar entry lands on the same screen.
  await page.goto('/today');
  await page.getByRole('link', { name: 'Sync conflicts' }).click();
  await expect(page).toHaveURL(/\/conflicts$/);
});
