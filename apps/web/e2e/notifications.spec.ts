import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { createDb, deliverDueReminders } from '@nextdoo/db';
const connection = createDb(process.env.DATABASE_URL!, { max: 2 });
test.afterAll(async () => { await connection.close(); });
const origin = { Origin: 'http://localhost:3100' }, headers = () => ({ ...origin, 'Idempotency-Key': randomUUID() });
async function fixture(page: Page) {
 const r = await page.request.post('/api/v1/auth/register', { headers: { ...origin, 'X-Forwarded-For': '198.51.100.160' }, data: { email: `notifications-${randomUUID()}@test.local`, password: 'notifications-test-password-123', timeZone: 'UTC' } }); expect(r.status()).toBe(200); const { workspaceId } = await r.json();
 const t = await page.request.post('/api/v1/tasks', { headers: headers(), data: { workspaceId, title: 'Reminder browser task', dueAt: new Date(Date.now()+86400000).toISOString() } }); expect(t.status()).toBe(200); return { workspaceId, task: await t.json() };
}
test('real dispatch is visible in the notification center, read acknowledgements persist, and snooze preserves sent history', async ({ page }) => {
 const { task } = await fixture(page); await page.goto('/inbox'); await page.locator(`[data-task-id="${task.id}"]`).getByRole('link', { name: 'Reminders', exact: true }).click();
 await page.getByLabel('Reminder mode', { exact: true }).selectOption('absolute'); await page.getByLabel('Reminder time (browser timezone)', { exact: true }).fill(new Date(Date.now()-60000).toISOString().slice(0,16));
 await page.getByRole('button', { name: 'Schedule reminder', exact: true }).click(); await expect(page.getByText('Reminder scheduled.', { exact: true })).toBeVisible();
 await deliverDueReminders(connection.db);
 await page.getByRole('button', { name: 'Refresh reminders', exact: true }).click(); await expect(page.locator('[data-reminder-id]').first()).toContainText('SENT');
 await page.getByRole('button', { name: 'Snooze 10 minutes', exact: true }).first().focus(); await page.keyboard.press('Enter'); await expect(page.locator('[data-reminder-id]')).toHaveCount(2);
 await expect(page.locator('[data-reminder-id]').filter({ hasText: 'SENT' })).toContainText('Replaced by a new reminder');
 await page.getByRole('button', { name: 'Cancel reminder', exact: true }).click(); await expect(page.locator('[data-reminder-id]').filter({ hasText: 'CANCELED' })).toHaveCount(1);
 await page.goto('/notifications'); await expect(page.locator('[data-notification-id]')).toHaveCount(1); await page.getByRole('button', { name: 'Mark read', exact: true }).click(); await expect(page.getByText('Read', { exact: true })).toBeVisible(); await page.reload(); await expect(page.getByText('Read', { exact: true })).toBeVisible();
 const { default: AxeBuilder } = await import('@axe-core/playwright'); expect((await new AxeBuilder({ page }).include('.notifications-view').withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze()).violations).toEqual([]);
});
test('reminder HTTP commands enforce ownership, versions, replay and unavailable channels', async ({ page, playwright }) => {
 const { task } = await fixture(page), key = headers(), data = { taskId: task.id, taskVersion: task.version, minutesBeforeDue: 15, channel: 'WEB' };
 const r = await page.request.post('/api/v1/reminders', { headers: key, data }); expect(r.status()).toBe(200); const reminder = await r.json(); expect(await (await page.request.post('/api/v1/reminders', { headers: key, data })).json()).toEqual(reminder);
 expect((await page.request.post('/api/v1/reminders', { headers: headers(), data: { ...data, channel: 'EMAIL' } })).status()).toBe(400);
 const snoozeKey = headers(), payload = { version: reminder.version, minutes: 10 }, url = `/api/v1/reminders/${reminder.id}/snooze`;
 const next = await page.request.post(url, { headers: snoozeKey, data: payload }); expect(next.status()).toBe(200); expect(await (await page.request.post(url, { headers: snoozeKey, data: payload })).json()).toEqual(await next.json());
 expect((await page.request.post(url, { headers: headers(), data: payload })).status()).toBe(409);
 const foreign = await playwright.request.newContext({ baseURL: 'http://localhost:3100' }); try {
  expect((await foreign.get('/api/v1/notifications')).status()).toBe(401);
  await foreign.post('/api/v1/auth/register', { headers: { ...origin, 'X-Forwarded-For': '198.51.100.161' }, data: { email: `foreign-notice-${randomUUID()}@test.local`, password: 'notifications-test-password-123' } });
  expect((await foreign.get(`/api/v1/reminders?taskId=${task.id}`)).status()).toBe(404); expect((await foreign.post(url, { headers: headers(), data: { ...payload, version: 2 } })).status()).toBe(404);
 } finally { await foreign.dispose(); }
});
test('lost creation acknowledgement retains reminder input and replays without duplicates', async ({ page }) => {
 const { task } = await fixture(page); await page.goto(`/notifications?taskId=${task.id}`); let lost = false; const keys: string[] = [];
 await page.route('**/api/v1/reminders', async (route) => { if (route.request().method() !== 'POST') return route.continue(); keys.push(route.request().headers()['idempotency-key']!); if (lost) return route.continue(); lost = true; expect((await route.fetch()).status()).toBe(200); await route.abort('failed'); });
 await page.getByLabel('Minutes before due', { exact: true }).fill('45'); await page.getByRole('button', { name: 'Schedule reminder', exact: true }).click(); await expect(page.locator('.notifications-view > [role="alert"]')).toContainText('not acknowledged'); await expect(page.getByLabel('Minutes before due', { exact: true })).toHaveValue('45');
 await page.getByRole('button', { name: 'Schedule reminder', exact: true }).click(); await expect(page.locator('[data-reminder-id]')).toHaveCount(1); expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]);
 expect((await page.request.post(`/api/v1/tasks/${task.id}/complete`, { headers: headers(), data: { version: task.version } })).status()).toBe(200);
 await page.getByLabel('Minutes before due', { exact: true }).fill('30'); await page.getByRole('button', { name: 'Schedule reminder', exact: true }).click(); await expect(page.locator('.notifications-view > [role="alert"]')).toContainText('active task'); await expect(page.getByLabel('Minutes before due', { exact: true })).toHaveValue('30');
});
test('notification and reminder continuation keeps loaded records after a failed page', async ({ page }) => {
 const { task } = await fixture(page);
 for (let i = 0; i < 55; i++) expect((await page.request.post('/api/v1/reminders', { headers: headers(), data: { taskId: task.id, scheduledAt: new Date(Date.now()-1000).toISOString(), channel: 'WEB' } })).status()).toBe(200);
 await deliverDueReminders(connection.db); await page.goto('/notifications'); await expect(page.locator('[data-notification-id]')).toHaveCount(50); await expect(page.locator('[data-reminder-id]')).toHaveCount(50);
 const failed = new Set<string>(); await page.route('**/api/v1/**?*cursor=*', (route) => { const path = new URL(route.request().url()).pathname; if (!failed.has(path)) { failed.add(path); return route.abort('failed'); } return route.continue(); });
 for (const [name, selector] of [['notifications', '[data-notification-id]'], ['reminders', '[data-reminder-id]']] as const) {
  await page.getByRole('button', { name: `Load more ${name}`, exact: true }).click(); await expect(page.locator(selector)).toHaveCount(50); await expect(page.locator('[role="alert"]').filter({ hasText: 'Could not load history' }).first()).toBeVisible();
  await page.getByRole('button', { name: `Load more ${name}`, exact: true }).click(); await expect(page.locator(selector)).toHaveCount(55);
 }
});
test('scheduling during a slow initial history fetch refreshes after commit instead of keeping a stale snapshot', async ({ page }) => {
 const { task } = await fixture(page); let held = false, release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
 await page.route('**/api/v1/reminders?history=true*', async (route) => { if (!held) { held = true; await gate; } await route.continue().catch(() => {}); });
 try {
  await page.goto(`/notifications?taskId=${task.id}`); await expect.poll(() => held).toBe(true);
  await page.getByRole('button', { name: 'Schedule reminder', exact: true }).click(); await expect(page.getByText('Reminder scheduled.', { exact: true })).toBeVisible(); await expect(page.locator('[data-reminder-id]')).toHaveCount(1);
 } finally { release(); }
});
