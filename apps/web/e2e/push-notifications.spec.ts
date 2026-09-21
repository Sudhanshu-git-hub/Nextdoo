/**
 * M8-i1 (PRD §6.6) — REAL-BROWSER push E2E (distinct from the stub-transport
 * integration tests in src/server/services/push-*.integration.test.ts).
 *
 * What is REAL here: the Next.js build, the service worker (registered from
 * the real /sw.js), the browser notification permission flow, the
 * subscription HTTP API, the reminder API and dispatch (real PostgreSQL),
 * and the degradation UI states.
 *
 * What is DOUBLED here: the final browser↔push-service handshake. The sandbox
 * and CI have no egress to a Web Push provider, so `PushManager.subscribe()`
 * is stubbed at the browser boundary with a well-formed subscription object
 * (labeled below). No real push provider delivery is claimed anywhere in this
 * suite; server-side delivery is exercised deterministically with the stub
 * transport in the integration tests.
 */
import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { createDb, deliverDueReminders } from '@nextdoo/db';
import { sql } from 'drizzle-orm';
const connection = createDb(process.env.DATABASE_URL!, { max: 2 });
test.afterAll(async () => { await connection.close(); });
const origin = { Origin: 'http://localhost:3100' }, headers = () => ({ ...origin, 'Idempotency-Key': randomUUID() });
const VAPID_PUBLIC_KEY = 'BIheeqGJoON1sFasQ9uIFfmv2g4BrjDv0a2HNLNbOzwqlcRPbEQyKkKIwgnJiJl9I5s3Y76bQacnVsjfZP-qEMk';
const FAKE_P256DH = 'MDEyMzQ1Njc4OWFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6';
const FAKE_AUTH = 'MDEyMzQ1Njc4OWFiY2RlZg';

async function fixture(page: Page) {
  const r = await page.request.post('/api/v1/auth/register', { headers: { ...origin, 'X-Forwarded-For': '198.51.100.170' }, data: { email: `push-${randomUUID()}@test.local`, password: 'push-test-password-123', timeZone: 'UTC' } });
  expect(r.status()).toBe(200);
  const { workspaceId } = await r.json();
  const t = await page.request.post('/api/v1/tasks', { headers: headers(), data: { workspaceId, title: 'Push browser task', dueAt: new Date(Date.now() + 86400000).toISOString() } });
  expect(t.status()).toBe(200);
  return { workspaceId, task: await t.json() };
}

/**
 * Browser-level double for the notification PERMISSION state. This headless
 * build cannot be granted real notification permissions (grantPermissions is
 * a no-op for 'notifications'), so the granted-state UI paths stub the
 * permission API at the browser boundary; everything downstream — the opt-in
 * action, the service worker, the HTTP API and the database — is real.
 */
async function stubNotificationPermissionGranted(page: Page) {
  await page.addInitScript(() => {
    try { Object.defineProperty(window.Notification, 'permission', { value: 'granted', configurable: true }); } catch { /* ignore */ }
    try { window.Notification.requestPermission = () => Promise.resolve('granted'); } catch { /* ignore */ }
  });
}

/** Browser-level double for the blocked push-service handshake (see header). */
async function stubPushSubscription(page: Page, endpoint: string, p256dh: string, auth: string) {
  await page.addInitScript(([ep, key, secret]) => {
    (window as unknown as { __nextdooPushCalls: number }).__nextdooPushCalls = 0;
    // A well-formed (but not cryptographically valid) subscription shape;
    // server-side zod validation and dedup are exercised for real.
    const subscription = {
      endpoint: ep,
      expirationTime: null,
      keys: { p256dh: key, auth: secret },
      toJSON() { return { endpoint: ep, expirationTime: null, keys: { p256dh: key, auth: secret } }; },
      unsubscribe: () => Promise.resolve(true),
      getApplicationServerKey: () => undefined,
    };
    (globalThis.PushManager as unknown as { prototype: { subscribe: unknown; getSubscription: unknown } }).prototype.subscribe = () => {
      (window as unknown as { __nextdooPushCalls: number }).__nextdooPushCalls += 1;
      return Promise.resolve(subscription);
    };
    // The real getSubscription would find nothing (the handshake is doubled);
    // answer with the same fake so the opt-out path runs end to end.
    (globalThis.PushManager as unknown as { prototype: { getSubscription: unknown } }).prototype.getSubscription = () => Promise.resolve(subscription);
  }, [endpoint, p256dh, auth]);
}

test('service worker registers and the configured public key is served to an authenticated browser', async ({ page }) => {
  const { task } = await fixture(page);
  await page.goto(`/notifications?taskId=${task.id}`);
  // Real service worker from the real build, not a mock.
  const sw = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.register('/sw.js');
    const ready = await navigator.serviceWorker.ready;
    return { scope: reg.scope, active: Boolean(ready?.active), scriptURL: reg.active?.scriptURL ?? null };
  });
  expect(sw.scope.endsWith('/')).toBe(true);
  expect(sw.active).toBe(true);
  expect(sw.scriptURL).toContain('/sw.js');
  // The configured deployment answers the public key with 200.
  const key = await page.evaluate(async () => {
    const r = await fetch('/api/v1/push/public-key');
    return { status: r.status, body: (await r.json()) as { vapidPublicKey?: string } };
  });
  expect(key.status).toBe(200);
  expect(key.body.vapidPublicKey).toBe(VAPID_PUBLIC_KEY);
  // The card renders; with the headless browser's default denied permission
  // the UI must degrade to the blocked state (no opt-in button, no error).
  await expect(page.getByRole('heading', { name: 'Browser push' })).toBeVisible();
  await expect(page.getByText('Notifications are blocked for this site', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enable browser push' })).toHaveCount(0);
  await expect(page.locator('.notifications-view [role="alert"]')).toHaveCount(0);
});

test('explicit opt-in registers a subscription through the real API and enables the PUSH channel', async ({ page }) => {
  const { task } = await fixture(page);
  const endpoint = `https://push.example.test/${randomUUID()}`;
  await stubNotificationPermissionGranted(page);
  await stubPushSubscription(page, endpoint, FAKE_P256DH, FAKE_AUTH);
  await page.goto(`/notifications?taskId=${task.id}`);
  await page.getByRole('button', { name: 'Enable browser push' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Browser push enabled' }).first()).toBeVisible();
  await expect(page.getByText('1 subscription registered').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Disable browser push on this device' })).toBeEnabled();
  expect(await page.evaluate(() => (window as unknown as { __nextdooPushCalls: number }).__nextdooPushCalls)).toBe(1);
  // The registration survived in the real database, scoped to this user.
  const listed = await page.request.get('/api/v1/push/subscriptions');
  expect(listed.status()).toBe(200);
  const data = (await listed.json()) as { data: Array<{ endpoint: string; createdAt: string }> };
  expect(data.data).toHaveLength(1);
  expect(data.data[0]?.endpoint).toBe(endpoint);
  expect(typeof data.data[0]?.createdAt).toBe('string');
  // The PUSH delivery option unlocks only once a subscription exists.
  const delivery = page.getByLabel('Delivery', { exact: true });
  await expect(delivery.locator('option[value="PUSH"]')).toBeEnabled();
  await page.getByLabel('Reminder mode', { exact: true }).selectOption('absolute');
  await page.getByLabel('Reminder time (browser timezone)', { exact: true }).fill(new Date(Date.now() - 60000).toISOString().slice(0, 16));
  await delivery.selectOption('PUSH');
  await page.getByRole('button', { name: 'Schedule reminder', exact: true }).click();
  await expect(page.getByText('Reminder scheduled.', { exact: true })).toBeVisible();
  // Real dispatch: the reminder is SENT and one durable push delivery is queued.
  await deliverDueReminders(connection.db);
  const reminders = await page.request.get(`/api/v1/reminders?taskId=${task.id}`);
  const rows = ((await reminders.json()) as { data: Array<{ channel: string; status: string }> }).data;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ channel: 'PUSH', status: 'SENT' });
  const queued = await connection.db.execute<{ n: number }>(sql`select count(*)::int as n from push_deliveries d join reminders r on r.id = d.reminder_id where r.task_id = ${task.id}::uuid and d.status = 'PENDING'`);
  expect(queued[0]?.n).toBe(1);
  // Durable in-app record coexists with the push queue.
  await page.getByRole('button', { name: 'Refresh reminders', exact: true }).click();
  await expect(page.locator('[data-reminder-id]').first()).toContainText('PUSH');
  // Opt-out removes the registration (server-side) and re-locks the channel.
  await page.getByRole('button', { name: 'Disable browser push on this device' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Browser push disabled' }).first()).toBeVisible();
  const after = (await (await page.request.get('/api/v1/push/subscriptions')).json()) as { data: unknown[] };
  expect(after.data).toHaveLength(0);
  await expect(delivery.locator('option[value="PUSH"]')).toBeDisabled();
});

test('unsupported browsers degrade cleanly without prompts or errors', async ({ page }) => {
  const { task } = await fixture(page);
  // Simulate a browser without Web Push APIs (e.g. iOS Safari) by removing
  // the capabilities before any app script runs.
  await page.addInitScript(() => {
    try { delete (Navigator.prototype as unknown as Record<string, unknown>).serviceWorker; } catch { /* frozen: ignore */ }
    try { delete (globalThis as { PushManager?: unknown }).PushManager; } catch { /* frozen: ignore */ }
    try { delete (globalThis as { Notification?: unknown }).Notification; } catch { /* frozen: ignore */ }
  });
  await page.goto(`/notifications?taskId=${task.id}`);
  await expect(page.getByRole('heading', { name: 'Browser push' })).toBeVisible();
  await expect(page.getByText('Browser push is not supported in this browser.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enable browser push' })).toHaveCount(0);
  // No forced permission prompt, and the PUSH option stays disabled.
  const delivery = page.getByLabel('Delivery', { exact: true });
  await expect(delivery.locator('option[value="PUSH"]')).toBeDisabled();
  // WEB reminders still work end to end on unsupported browsers.
  await page.getByLabel('Reminder mode', { exact: true }).selectOption('absolute');
  await page.getByLabel('Reminder time (browser timezone)', { exact: true }).fill(new Date(Date.now() - 60000).toISOString().slice(0, 16));
  await page.getByRole('button', { name: 'Schedule reminder', exact: true }).click();
  await expect(page.getByText('Reminder scheduled.', { exact: true })).toBeVisible();
});

test('subscription lifecycle routes enforce authentication, ownership and payload validation', async ({ page, playwright }) => {
  const { workspaceId } = await fixture(page);
  void workspaceId;
  const anon = await playwright.request.newContext({ baseURL: 'http://localhost:3100' });
  const foreign = await playwright.request.newContext({ baseURL: 'http://localhost:3100' });
  try {
    // Unauthenticated: 401 on every lifecycle route (no payload leakage).
    expect((await anon.get('/api/v1/push/public-key')).status()).toBe(401);
    expect((await anon.get('/api/v1/push/subscriptions')).status()).toBe(401);
    expect((await anon.post('/api/v1/push/subscriptions', { data: {} })).status()).toBe(401);
    expect((await anon.delete('/api/v1/push/subscriptions', { data: { endpoint: 'https://x' } })).status()).toBe(401);
    // Validation: malformed payloads are rejected without persisting anything.
    const bad = 'https://push.example.test/bad';
    for (const payload of [
      { endpoint: 'nope' },
      { endpoint: bad },
      { endpoint: bad, keys: { p256dh: FAKE_P256DH } },
      { endpoint: bad, keys: { p256dh: FAKE_P256DH, auth: FAKE_AUTH, extra: true } },
    ]) {
      expect((await page.request.post('/api/v1/push/subscriptions', { headers: headers(), data: payload })).status()).toBe(400);
    }
    expect(((await (await page.request.get('/api/v1/push/subscriptions')).json()).data as unknown[])).toHaveLength(0);
    // A second user cannot list or remove the first user's registration.
    const ownerEndpoint = `https://push.example.test/${randomUUID()}`;
    const ownerSub = { endpoint: ownerEndpoint, keys: { p256dh: FAKE_P256DH, auth: FAKE_AUTH } };
    expect((await page.request.post('/api/v1/push/subscriptions', { headers: headers(), data: ownerSub })).status()).toBe(200);
    const foreignRegister = await foreign.post('/api/v1/auth/register', { headers: { ...origin, 'X-Forwarded-For': '198.51.100.171' }, data: { email: `push-foreign-${randomUUID()}@test.local`, password: 'push-test-password-123', timeZone: 'UTC' } });
    expect(foreignRegister.status()).toBe(200);
    expect(((await (await foreign.get('/api/v1/push/subscriptions')).json()).data as unknown[])).toHaveLength(0);
    const foreignRemove = await foreign.delete('/api/v1/push/subscriptions', { headers: { ...origin, 'Idempotency-Key': randomUUID() }, data: { endpoint: ownerEndpoint } });
    expect((await foreignRemove.json())).toEqual({ removed: false });
    // The owner's registration is untouched; removal is idempotent.
    expect(((await (await page.request.get('/api/v1/push/subscriptions')).json()).data as unknown[])).toHaveLength(1);
    expect(await (await page.request.delete('/api/v1/push/subscriptions', { headers: headers(), data: { endpoint: ownerEndpoint } })).json()).toEqual({ removed: true });
    expect(await (await page.request.delete('/api/v1/push/subscriptions', { headers: headers(), data: { endpoint: ownerEndpoint } })).json()).toEqual({ removed: false });
    // The public key is a public value, but the route still requires auth.
    expect((await foreign.get('/api/v1/push/public-key')).status()).toBe(200);
    expect(((await (await foreign.get('/api/v1/push/public-key')).json()).vapidPublicKey as string)).toBe(VAPID_PUBLIC_KEY);
  } finally {
    await anon.dispose();
    await foreign.dispose();
  }
});
