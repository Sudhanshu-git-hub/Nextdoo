import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
const origin = { Origin: 'http://localhost:3100' }, headers = () => ({ ...origin, 'Idempotency-Key': randomUUID() });
async function fixture(page: Page) {
 const r = await page.request.post('/api/v1/auth/register', { headers: { ...origin, 'X-Forwarded-For': '198.51.100.154' }, data: { email: `recurrence-${randomUUID()}@test.local`, password: 'recurrence-test-password-123', timeZone: 'UTC' } }); expect(r.status()).toBe(200);
 const { workspaceId } = await r.json();
 const t = await page.request.post('/api/v1/tasks', { headers: headers(), data: { workspaceId, title: 'Recurring work', dueAt: new Date(Date.now() + 86400000).toISOString() } }); expect(t.status()).toBe(200);
 return { workspaceId, task: await t.json() };
}
async function attach(page: Page, task: { id: string }) {
 await page.goto('/inbox'); await page.locator(`[data-task-id="${task.id}"]`).getByRole('button', { name: 'Edit "Recurring work"', exact: true }).click();
 const dialog = page.getByRole('dialog', { name: 'Edit task', exact: true }); await dialog.getByText('Recurrence', { exact: true }).click();
 await dialog.getByLabel('End condition', { exact: true }).selectOption('count'); await dialog.getByLabel('Occurrence count', { exact: true }).fill('3');
 page.once('dialog', (d) => d.accept()); await dialog.getByRole('button', { name: 'Start recurrence', exact: true }).click();
 await dialog.getByRole('link', { name: 'Manage recurrence', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Recurrence', exact: true })).toBeVisible();
}
test('recurrence controls create real tasks, complete and skip occurrences, and pause without deleting work', async ({ page }) => {
 const { task } = await fixture(page); await attach(page, task);
 await expect(page.locator('[data-task-id]')).toHaveCount(3);
 const { default: AxeBuilder } = await import('@axe-core/playwright'); expect((await new AxeBuilder({ page }).include('.recurrence-view').withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze()).violations).toEqual([]);
 await page.locator(`[data-task-id="${task.id}"]`).getByRole('button', { name: 'Complete "Recurring work"', exact: true }).click();
 await expect(page.locator(`[data-task-id="${task.id}"]`).getByRole('button', { name: 'Mark "Recurring work" as not done', exact: true })).toBeVisible();
 page.once('dialog', (d) => d.accept()); await page.getByRole('button', { name: 'Skip occurrence', exact: true }).first().focus(); await page.keyboard.press('Enter');
 await expect(page.getByText('Occurrence skipped.', { exact: true })).toBeVisible();
 page.once('dialog', (d) => d.accept()); await page.getByRole('button', { name: 'Pause series', exact: true }).click();
 await expect(page.getByRole('button', { name: 'Resume series', exact: true })).toBeVisible(); await expect(page.locator('[data-task-id]')).toHaveCount(3);
});
test('editing the future schedule preserves existing instances, and stale changes retain the draft', async ({ page }) => {
 const { task } = await fixture(page); await attach(page, task);
 const id = new URL(page.url()).pathname.split('/').pop()!;
 const before = await (await page.request.get(`/api/v1/recurrences/${id}`)).json();
 await page.getByLabel('New start (browser timezone)', { exact: true }).fill(new Date(new Date(before.effectiveAfter).getTime() + 7 * 86400000).toISOString().slice(0, 16));
 await page.getByLabel('Interval', { exact: true }).fill('2');
 page.once('dialog', (d) => d.accept()); await page.getByRole('button', { name: 'Apply future schedule', exact: true }).click();
 await expect(page.locator('[data-task-id]')).toHaveCount(6);
 for (const o of before.occurrences) expect(await (await page.request.get(`/api/v1/tasks/${o.taskId}`)).json()).toMatchObject({ version: o.task.version, dueAt: o.task.dueAt });
 expect((await page.request.patch(`/api/v1/recurrences/${id}`, { headers: headers(), data: { version: 2, active: false } })).status()).toBe(200);
 await page.getByLabel('New start (browser timezone)', { exact: true }).fill(new Date(new Date(before.effectiveAfter).getTime() + 21 * 86400000).toISOString().slice(0, 16)); await page.getByLabel('Interval', { exact: true }).fill('3');
 page.once('dialog', (d) => d.accept()); await page.getByRole('button', { name: 'Apply future schedule', exact: true }).click();
 await expect(page.locator('.recurrence-view [role="alert"]')).toContainText('changed'); await expect(page.getByLabel('Interval', { exact: true })).toHaveValue('3');
});
test('lost recurrence acknowledgement retries with the same identity, without another series', async ({ page }) => {
 const { task } = await fixture(page); let lost = false; const keys: string[] = [];
 await page.route(`**/api/v1/tasks/${task.id}/recurrence`, async (route) => {
  keys.push(route.request().headers()['idempotency-key']!);
  if (lost) return route.continue(); lost = true; expect((await route.fetch()).status()).toBe(200); await route.abort('failed');
 });
 await page.goto('/inbox'); await page.getByRole('button', { name: 'Edit "Recurring work"', exact: true }).click(); const dialog = page.getByRole('dialog', { name: 'Edit task', exact: true });
 await dialog.getByText('Recurrence', { exact: true }).click(); await dialog.getByLabel('End condition', { exact: true }).selectOption('count'); await dialog.getByLabel('Occurrence count', { exact: true }).fill('2');
 page.once('dialog', (d) => d.accept()); await dialog.getByRole('button', { name: 'Start recurrence', exact: true }).click();
 await expect(dialog.locator('.task-recurrence [role="alert"]')).toContainText('retry');
 page.once('dialog', (d) => d.accept()); await dialog.getByRole('button', { name: 'Start recurrence', exact: true }).click(); await expect(dialog.getByRole('link', { name: 'Manage recurrence', exact: true })).toBeVisible();
 expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]);
});
test('HTTP recurrence contracts enforce tenants, versions, strict input and atomic creation', async ({ page, playwright }) => {
 const { workspaceId, task } = await fixture(page); const data = { version: 1, rule: { freq: 'DAILY', interval: 1, count: 2, timeZone: 'UTC' } };
 const key = headers(); const first = await page.request.post(`/api/v1/tasks/${task.id}/recurrence`, { headers: key, data }); expect(first.status()).toBe(200); const series = await first.json();
 expect(await (await page.request.post(`/api/v1/tasks/${task.id}/recurrence`, { headers: key, data })).json()).toEqual(series);
 expect((await page.request.patch(`/api/v1/recurrences/${series.id}`, { headers: headers(), data: { version: 1, rule: data.rule } })).status()).toBe(400);
 const other = await playwright.request.newContext({ baseURL: 'http://localhost:3100' });
 try {
  expect((await other.get(`/api/v1/recurrences/${series.id}`)).status()).toBe(401);
  expect((await other.post('/api/v1/auth/register', { headers: { ...origin, 'X-Forwarded-For': '198.51.100.155' }, data: { email: `foreign-series-${randomUUID()}@test.local`, password: 'recurrence-test-password-123', timeZone: 'UTC' } })).status()).toBe(200);
  expect((await other.get(`/api/v1/recurrences/${series.id}`)).status()).toBe(404);
  expect((await other.patch(`/api/v1/recurrences/${series.id}`, { headers: headers(), data: { version: 1, active: false } })).status()).toBe(404);
  expect((await other.post(`/api/v1/tasks/${task.id}/skip`, { headers: headers(), data: { version: 2 } })).status()).toBe(404);
 } finally { await other.dispose(); }
 const invalid = await page.request.post('/api/v1/tasks', { headers: headers(), data: { workspaceId, title: 'Invalid recurring task', recurrenceRule: data.rule } }); expect(invalid.status()).toBe(400);
 expect((await (await page.request.get(`/api/v1/tasks?workspaceId=${workspaceId}`)).json()).data).toHaveLength(2);
});
test('incomplete recurring capture keeps the text and cannot leave a one-off task behind', async ({ page }) => {
 const { workspaceId } = await fixture(page); await page.goto('/inbox');
 const text = 'Unscheduled recurring work every day'; await page.locator('#capture').fill(text); await page.locator('#capture').press('Enter');
 await page.getByRole('button', { name: 'Save as shown', exact: true }).click();
 await expect(page.getByText('Start recurrence on an active, scheduled task that is not already in a series.', { exact: true })).toBeVisible(); await expect(page.locator('#capture')).toHaveValue(text);
 expect((await (await page.request.get(`/api/v1/tasks?workspaceId=${workspaceId}`)).json()).data).toHaveLength(1);
});
test('occurrence history continuation retains loaded rows after a failed later page', async ({ page }) => {
 const { task } = await fixture(page);
 expect((await page.request.patch(`/api/v1/tasks/${task.id}`, { headers: headers(), data: { version: 1, dueAt: new Date(Date.now() - 120 * 86400000).toISOString() } })).status()).toBe(200);
 const attached = await page.request.post(`/api/v1/tasks/${task.id}/recurrence`, { headers: headers(), data: { version: 2, rule: { freq: 'DAILY', interval: 1, count: 105, timeZone: 'UTC' } } }); expect(attached.status()).toBe(200); const series = await attached.json();
 for (const version of [1, 2]) expect((await page.request.patch(`/api/v1/recurrences/${series.id}`, { headers: headers(), data: { version, active: true } })).status()).toBe(200);
 await page.goto(`/recurrences/${series.id}`); await expect(page.locator('[data-task-id]')).toHaveCount(100); let failed = false;
 await page.route('**/api/v1/recurrences/*?cursor=*', (route) => { if (!failed) { failed = true; return route.abort('failed'); } return route.continue(); });
 await page.getByRole('button', { name: 'Load more occurrences', exact: true }).click(); await expect(page.locator('.recurrence-view [role="alert"]')).toContainText('Could not load'); await expect(page.locator('[data-task-id]')).toHaveCount(100);
 await page.getByRole('button', { name: 'Load more occurrences', exact: true }).click(); await expect(page.locator('[data-task-id]')).toHaveCount(105);
});
test('skipping preserves an unsaved future rule and dirty task metadata cannot be lost through the series link', async ({ page }) => {
 const { task } = await fixture(page); await attach(page, task);
 await page.getByLabel('Interval', { exact: true }).fill('2'); page.once('dialog', (d) => d.accept()); await page.getByRole('button', { name: 'Skip occurrence', exact: true }).first().click();
 await expect(page.getByText('Occurrence skipped.', { exact: true })).toBeVisible(); await expect(page.getByLabel('Interval', { exact: true })).toHaveValue('2');
 const url = page.url(); await page.locator(`[data-task-id="${task.id}"]`).getByRole('button', { name: 'Edit "Recurring work"', exact: true }).click(); const dialog = page.getByRole('dialog', { name: 'Edit task', exact: true });
 await dialog.getByLabel('Title', { exact: true }).fill('Unsaved recurring title'); await dialog.getByText('Recurrence', { exact: true }).click();
 const link = dialog.getByRole('link', { name: 'Manage recurrence', exact: true }); await expect(link).toHaveAttribute('aria-disabled', 'true'); await link.focus(); await page.keyboard.press('Enter'); await expect(dialog).toBeVisible(); await expect(dialog.getByLabel('Title', { exact: true })).toHaveValue('Unsaved recurring title'); expect(page.url()).toBe(url);
});
