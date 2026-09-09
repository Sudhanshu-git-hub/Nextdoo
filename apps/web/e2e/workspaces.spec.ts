import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
const origin = { Origin: 'http://localhost:3100' }, headers = () => ({ ...origin, 'Idempotency-Key': randomUUID() });
async function fixture(page: Page) {
 const r = await page.request.post('/api/v1/auth/register', { headers: { ...origin, 'X-Forwarded-For': '198.51.100.155' }, data: { email: `settings-${randomUUID()}@test.local`, password: 'workspace-test-password-123', timeZone: 'UTC' } }); expect(r.status()).toBe(200); return (await r.json()).workspaceId as string;
}
test('overnight workspace settings persist, are accessible, and drive calendar and capture defaults', async ({ page }) => {
 await fixture(page); await page.goto('/settings'); const form = page.locator('.workspace-settings');
 await form.getByLabel('Workspace name', { exact: true }).fill('Night team'); await form.getByLabel('Workspace time zone', { exact: true }).fill('Asia/Kolkata');
 await form.getByLabel('Week starts on', { exact: true }).selectOption('0'); await form.getByLabel('Workday starts', { exact: true }).fill('22:00'); await form.getByLabel('Workday ends', { exact: true }).fill('06:00');
 await form.getByRole('button', { name: 'Save workspace settings', exact: true }).click(); await expect(form.getByRole('status')).toContainText('saved'); await page.reload();
 await expect(form.getByLabel('Workspace name', { exact: true })).toHaveValue('Night team'); await expect(form).toContainText('22:00–06:00 (next day)');
 const { default: AxeBuilder } = await import('@axe-core/playwright'); expect((await new AxeBuilder({ page }).include('.workspace-settings').withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze()).violations).toEqual([]);
 await page.goto('/calendar'); await expect(page.getByText('Configured workday: 22:00–06:00 (next day)', { exact: true })).toBeVisible(); await expect(page.getByRole('listitem').first()).toContainText('Sun');
 await page.goto('/inbox'); await page.locator('#capture').fill('Night review tomorrow at 9am'); const saved = page.waitForResponse((r) => r.url().endsWith('/api/v1/tasks') && r.request().method() === 'POST'); await page.locator('#capture').press('Enter');
 const task = await (await saved).json(); expect(task.timeZone).toBe('Asia/Kolkata'); expect(new Date(task.dueAt).getUTCHours()).toBe(3); expect(new Date(task.dueAt).getUTCMinutes()).toBe(30);
 await page.locator(`[data-task-id="${task.id}"]`).getByRole('button', { name: 'Edit "Night review"', exact: true }).click(); const dialog = page.getByRole('dialog', { name: 'Edit task', exact: true }); await dialog.getByText('Recurrence', { exact: true }).click(); await expect(dialog.getByLabel('Recurrence time zone', { exact: true })).toHaveValue('Asia/Kolkata');
});
test('lost settings acknowledgements retry safely and stale changes retain the draft for review', async ({ page }) => {
 const id = await fixture(page); await page.goto('/settings'); const form = page.locator('.workspace-settings'); let lost = false; const keys: string[] = [];
 await page.route(`**/api/v1/workspaces/${id}`, async (route) => { if (route.request().method() !== 'PATCH') return route.continue(); keys.push(route.request().headers()['idempotency-key']!); if (lost) return route.continue(); lost = true; expect((await route.fetch()).status()).toBe(200); await route.abort('failed'); });
 await form.getByLabel('Workspace name', { exact: true }).fill('Kept draft'); await form.getByRole('button', { name: 'Save workspace settings', exact: true }).click(); await expect(form.getByRole('alert')).toContainText('not acknowledged');
 await expect(form.getByLabel('Workspace name', { exact: true })).toHaveValue('Kept draft'); await form.getByRole('button', { name: 'Save workspace settings', exact: true }).click(); await expect(form.getByRole('status')).toContainText('saved'); expect(keys[0]).toBe(keys[1]);
 expect((await page.request.patch(`/api/v1/workspaces/${id}`, { headers: headers(), data: { version: 2, name: 'Other tab' } })).status()).toBe(200);
 await form.getByLabel('Workspace name', { exact: true }).fill('My unsaved name'); await form.getByRole('button', { name: 'Save workspace settings', exact: true }).click(); await expect(form.getByRole('alert')).toContainText('changed'); await expect(form.getByLabel('Workspace name', { exact: true })).toHaveValue('My unsaved name');
 page.once('dialog', (d) => d.accept()); await form.getByRole('button', { name: 'Reload workspace settings', exact: true }).click(); await expect(form.getByLabel('Workspace name', { exact: true })).toHaveValue('Other tab');
});
test('workspace HTTP contracts enforce scope, origin, idempotency, strict fields and versions', async ({ page, playwright }) => {
 const id = await fixture(page), key = headers(); const data = { version: 1, name: 'Reviewed' };
 const first = await page.request.patch(`/api/v1/workspaces/${id}`, { headers: key, data }); expect(first.status()).toBe(200);
 expect(await (await page.request.patch(`/api/v1/workspaces/${id}`, { headers: key, data })).json()).toEqual(await first.json());
 expect((await page.request.patch(`/api/v1/workspaces/${id}`, { headers: key, data: { ...data, name: 'Changed' } })).status()).toBe(409);
 expect((await page.request.patch(`/api/v1/workspaces/${id}`, { headers: headers(), data })).status()).toBe(409);
 expect((await page.request.patch(`/api/v1/workspaces/${id}`, { headers: headers(), data: { version: 2, ownerId: randomUUID() } })).status()).toBe(400);
 expect((await page.request.patch(`/api/v1/workspaces/${id}`, { headers: { ...headers(), Origin: 'https://evil.test' }, data: { version: 2, name: 'Wrong origin' } })).status()).toBe(403);
 expect((await page.request.patch(`/api/v1/workspaces/${id}`, { headers: origin, data: { version: 2, name: 'No key' } })).status()).toBe(400);
 expect((await page.request.get('/api/v1/workspaces/not-a-uuid')).status()).toBe(400);
 const guest = await playwright.request.newContext({ baseURL: 'http://localhost:3100' }); try {
  expect((await guest.get(`/api/v1/workspaces/${id}`)).status()).toBe(401);
  expect((await guest.post('/api/v1/auth/register', { headers: { ...origin, 'X-Forwarded-For': '198.51.100.156' }, data: { email: `outsider-${randomUUID()}@test.local`, password: 'workspace-test-password-123' } })).status()).toBe(200);
  expect((await guest.get(`/api/v1/workspaces/${id}`)).status()).toBe(404); expect((await guest.patch(`/api/v1/workspaces/${id}`, { headers: headers(), data: { version: 2, name: 'Stolen' } })).status()).toBe(404);
 } finally { await guest.dispose(); }
});
test('invalid hours and failed reloads keep the draft, while leaving requires confirmation', async ({ page }) => {
 const id = await fixture(page); const original = await (await page.request.get(`/api/v1/workspaces/${id}`)).json(); await page.goto('/settings'); const form = page.locator('.workspace-settings');
 await form.getByLabel('Workspace name', { exact: true }).fill('Do not lose this'); await form.getByLabel('Workday ends', { exact: true }).fill('09:00'); await form.getByRole('button', { name: 'Save workspace settings', exact: true }).focus(); await page.keyboard.press('Enter'); await expect(form.getByRole('alert')).toContainText('different');
 expect((await (await page.request.get(`/api/v1/workspaces/${id}`)).json()).version).toBe(1);
 page.once('dialog', (d) => d.dismiss()); await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Inbox', exact: true }).click(); await expect(form.getByLabel('Workspace name', { exact: true })).toHaveValue('Do not lose this'); expect(new URL(page.url()).pathname).toBe('/settings');
 let failed = false; await page.route(`**/api/v1/workspaces/${id}`, (route) => { if (!failed && route.request().method() === 'GET') { failed = true; return route.abort('failed'); } return route.continue(); });
 page.once('dialog', (d) => d.accept()); await form.getByRole('button', { name: 'Reload workspace settings', exact: true }).click(); await expect(form.getByRole('alert')).toContainText('Could not reload'); await expect(form.getByLabel('Workspace name', { exact: true })).toHaveValue('Do not lose this');
 page.once('dialog', (d) => d.accept()); await form.getByRole('button', { name: 'Reload workspace settings', exact: true }).click(); await expect(form.getByLabel('Workspace name', { exact: true })).toHaveValue(original.name);
});
test('Today uses the workspace date across a UTC date boundary and the configured workday guideline', async ({ page }) => {
 const id = await fixture(page), now = new Date(); const offset = now.getUTCHours() < 12 ? -12 : 14, zone = offset < 0 ? 'Etc/GMT+12' : 'Pacific/Kiritimati';
 const local = new Date(now.getTime() + offset * 3600000); local.setUTCHours(0, 0, 0, 0); const start = local.getTime() - offset * 3600000;
 expect((await page.request.patch(`/api/v1/workspaces/${id}`, { headers: headers(), data: { version: 1, timeZone: zone, workdayStartMinute: 540, workdayEndMinute: 600 } })).status()).toBe(200);
 for (const [title, time, estimateMinutes] of [['Local today', start + 12 * 3600000, 120], ['Earlier day', start - 3600000, 15], ['Local tomorrow', start + 25 * 3600000, 15]] as const) expect((await page.request.post('/api/v1/tasks', { headers: headers(), data: { workspaceId: id, title, dueAt: new Date(time).toISOString(), estimateMinutes } })).status()).toBe(200);
 await page.clock.setFixedTime(now); await page.goto('/today');
 await expect(page.getByRole('region', { name: 'Due today', exact: true }).getByRole('button', { name: 'Edit "Local today"', exact: true })).toBeVisible();
 await expect(page.getByRole('region', { name: 'Overdue (1)', exact: true }).getByRole('button', { name: 'Edit "Earlier day"', exact: true })).toBeVisible();
 await expect(page.getByRole('button', { name: 'Edit "Local tomorrow"', exact: true })).toHaveCount(0); await expect(page.getByText(/That exceeds your configured workday/)).toBeVisible();
});
