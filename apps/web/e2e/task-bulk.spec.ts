import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
const origin = { Origin: 'http://localhost:3100' }, headers = () => ({ ...origin, 'Idempotency-Key': randomUUID() });
async function fixture(page: Page, count = 2) {
 const r = await page.request.post('/api/v1/auth/register', { headers: { ...origin, 'X-Forwarded-For': '198.51.100.144' }, data: { email: `bulk-${randomUUID()}@test.local`, password: 'bulk-password-for-tests-123', timeZone: 'UTC' } });
 expect(r.status()).toBe(200); const { workspaceId } = await r.json(); const tasks: { id: string; version: number }[] = [];
 for (let i = 0; i < count; i++) {
  const created = await page.request.post('/api/v1/tasks', { headers: headers(), data: { workspaceId, title: `Bulk task ${i}` } });
  expect(created.status()).toBe(200); tasks.push(await created.json());
 }
 return { workspaceId, tasks };
}
const rows = (page: Page) => page.locator('[data-task-id]');
const area = (page: Page) => page.getByRole('region', { name: 'Bulk task actions', exact: true });
test('select, cancel, keyboard confirm and atomically complete without changing unselected tasks', async ({ page }) => {
 const { tasks } = await fixture(page, 3); await page.goto('/tasks'); await expect(rows(page)).toHaveCount(3);
 await page.getByLabel('Select "Bulk task 0"', { exact: true }).check(); await page.getByLabel('Select "Bulk task 1"', { exact: true }).check();
 await expect(area(page).getByRole('status')).toContainText('2 tasks selected');
 page.once('dialog', (d) => d.dismiss()); await area(page).getByRole('button', { name: 'Complete selected', exact: true }).click(); await expect(rows(page)).toHaveCount(3);
 const { default: AxeBuilder } = await import('@axe-core/playwright');
 expect((await new AxeBuilder({ page }).include('.task-browser').withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([]);
 page.once('dialog', (d) => d.accept()); await area(page).getByRole('button', { name: 'Complete selected', exact: true }).focus(); await page.keyboard.press('Enter');
 await expect(rows(page)).toHaveCount(1); await expect(rows(page)).toContainText('Bulk task 2');
 for (let i = 0; i < 3; i++) expect(await (await page.request.get(`/api/v1/tasks/${tasks[i]!.id}`)).json()).toMatchObject({ version: i === 2 ? 1 : 2, status: i === 2 ? 'ACTIVE' : 'COMPLETED' });
});
test('selected reschedule and archive require confirmation and reset on filter changes', async ({ page }) => {
 const { tasks } = await fixture(page); await page.goto('/tasks'); await expect(rows(page)).toHaveCount(2);
 await area(page).getByRole('button', { name: 'Select loaded tasks', exact: true }).click();
 await area(page).getByLabel('New due date and time', { exact: true }).fill('2026-09-15T14:00');
 page.once('dialog', (d) => d.accept()); await area(page).getByRole('button', { name: 'Reschedule selected', exact: true }).click();
 await expect(area(page).getByRole('status')).toContainText('2 tasks rescheduled');
 for (const t of tasks) expect(await (await page.request.get(`/api/v1/tasks/${t.id}`)).json()).toMatchObject({ dueAt: '2026-09-15T14:00:00.000Z', version: 2, rescheduleCount: 1 });
 await expect(rows(page)).toHaveCount(2); await area(page).getByRole('button', { name: 'Select loaded tasks', exact: true }).click();
 await page.getByLabel('Priority', { exact: true }).selectOption('HIGH'); await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
 await expect(rows(page)).toHaveCount(0); await expect(area(page).getByRole('status')).toContainText('0 tasks selected');
 await page.getByRole('button', { name: 'Reset filters', exact: true }).click(); await expect(rows(page)).toHaveCount(2);
 await area(page).getByRole('button', { name: 'Select loaded tasks', exact: true }).click();
 await area(page).getByLabel('Remove due dates', { exact: true }).check(); page.once('dialog', (d) => d.accept()); await area(page).getByRole('button', { name: 'Reschedule selected', exact: true }).click();
 await expect(area(page).getByRole('status')).toContainText('2 tasks rescheduled'); await expect(rows(page)).toHaveCount(2);
 await area(page).getByRole('button', { name: 'Select loaded tasks', exact: true }).click(); page.once('dialog', (d) => d.accept()); await area(page).getByRole('button', { name: 'Archive selected', exact: true }).click();
 await expect(rows(page)).toHaveCount(0);
 for (const t of tasks) expect(await (await page.request.get(`/api/v1/tasks/${t.id}`)).json()).toMatchObject({ dueAt: null, status: 'ARCHIVED', version: 4 });
});
test('stale selection changes nothing and forces explicit reload/review', async ({ page }) => {
 const { tasks } = await fixture(page); await page.goto('/tasks'); await expect(rows(page)).toHaveCount(2); await area(page).getByRole('button', { name: 'Select loaded tasks', exact: true }).click();
 expect((await page.request.patch(`/api/v1/tasks/${tasks[1]!.id}`, { headers: headers(), data: { version: 1, title: 'Changed elsewhere' } })).status()).toBe(200);
 page.once('dialog', (d) => d.accept()); await area(page).getByRole('button', { name: 'Complete selected', exact: true }).click();
 await expect(area(page).getByRole('alert')).toContainText('No tasks changed');
 expect(await (await page.request.get(`/api/v1/tasks/${tasks[0]!.id}`)).json()).toMatchObject({ version: 1, status: 'ACTIVE' });
 await area(page).getByRole('button', { name: 'Reload and review tasks', exact: true }).click(); await expect(rows(page)).toContainText(['Bulk task 0', 'Changed elsewhere'].sort().reverse());
 await expect(area(page).getByRole('status')).toContainText('0 tasks selected');
});
test('lost acknowledgement retains exact batch identity and freezes selection until retry', async ({ page }) => {
 await fixture(page); await page.goto('/tasks'); await expect(rows(page)).toHaveCount(2); await area(page).getByRole('button', { name: 'Select loaded tasks', exact: true }).click();
 const keys: string[] = [], bodies: string[] = []; let lost = false;
 await page.route('**/api/v1/tasks/bulk', async (route) => {
  keys.push(route.request().headers()['idempotency-key']!); bodies.push(route.request().postData()!);
  if (lost) return route.continue(); lost = true; expect((await route.fetch()).status()).toBe(200); await route.abort('failed');
 });
 page.once('dialog', (d) => d.accept()); await area(page).getByRole('button', { name: 'Complete selected', exact: true }).click();
 await expect(area(page).getByRole('alert')).toContainText('acknowledged'); await expect(page.getByRole('button', { name: 'Apply filters', exact: true })).toBeDisabled();
 await expect(page.getByLabel('Select "Bulk task 0"', { exact: true })).toBeDisabled();
 await area(page).getByRole('button', { name: 'Retry same batch', exact: true }).click(); await expect(rows(page)).toHaveCount(0);
 expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]); expect(bodies[0]).toBe(bodies[1]);
});
test('HTTP bulk protects authentication, tenant boundaries, strict contracts and concurrent replay', async ({ page, playwright }) => {
 const { workspaceId, tasks } = await fixture(page); const data = { workspaceId, operation: 'complete', tasks: tasks.map(({ id, version }) => ({ id, version })) };
 for (const extra of [{ tasks: [] }, { tasks: [data.tasks[0], data.tasks[0]] }, { operation: 'delete' }, { operation: 'reschedule' }, { dueAt: null }]) expect((await page.request.post('/api/v1/tasks/bulk', { headers: headers(), data: { ...data, ...extra } })).status()).toBe(400);
 expect((await page.request.post('/api/v1/tasks/bulk', { headers: origin, data })).status()).toBe(400);
 expect((await page.request.post('/api/v1/tasks/bulk', { headers: { ...headers(), Origin: 'https://evil.example' }, data })).status()).toBe(403);
 const other = await playwright.request.newContext({ baseURL: 'http://localhost:3100' });
 try {
  expect((await other.post('/api/v1/tasks/bulk', { headers: headers(), data })).status()).toBe(401);
  const registered = await other.post('/api/v1/auth/register', { headers: { ...origin, 'X-Forwarded-For': '198.51.100.145' }, data: { email: `foreign-bulk-${randomUUID()}@test.local`, password: 'bulk-password-for-tests-123', timeZone: 'UTC' } }); expect(registered.status()).toBe(200);
  expect((await other.post('/api/v1/tasks/bulk', { headers: headers(), data })).status()).toBe(403);
  expect((await other.post('/api/v1/tasks/bulk', { headers: headers(), data: { ...data, workspaceId: (await registered.json()).workspaceId } })).status()).toBe(404);
 } finally { await other.dispose(); }
 const identity = headers(); const replies = await Promise.all([page.request.post('/api/v1/tasks/bulk', { headers: identity, data }), page.request.post('/api/v1/tasks/bulk', { headers: identity, data })]);
 for (const reply of replies) { expect(reply.status()).toBe(200); expect(reply.headers()['cache-control']).toContain('no-store'); expect(reply.headers()['x-request-id']).toBeTruthy(); }
 expect(await replies[0]!.json()).toEqual(await replies[1]!.json());
 expect(replies.some((r) => r.headers()['idempotent-replay'] === 'true')).toBe(true);
 expect((await page.request.post('/api/v1/tasks/bulk', { headers: identity, data: { ...data, operation: 'archive' } })).status()).toBe(409);
 expect((await page.request.post('/api/v1/tasks/bulk', { headers: headers(), data })).status()).toBe(409);
 const limited = await page.request.post('/api/v1/tasks/bulk', { headers: headers(), data });
 expect(limited.status()).toBe(429); expect(limited.headers()['retry-after']).toBeTruthy();
});
test('selection spans loaded pages but never automatically includes a newly loaded row', async ({ page }) => {
 const { tasks } = await fixture(page, 52); await page.goto('/tasks'); await expect(rows(page)).toHaveCount(50);
 await area(page).getByRole('button', { name: 'Select loaded tasks', exact: true }).click(); await expect(area(page).getByRole('status')).toContainText('50 tasks selected');
 await page.getByRole('button', { name: 'Load more tasks', exact: true }).click(); await expect(rows(page)).toHaveCount(52); await expect(area(page).getByRole('status')).toContainText('50 tasks selected');
 await expect(page.getByLabel('Select "Bulk task 0"', { exact: true })).not.toBeChecked();
 await page.getByLabel('Select "Bulk task 0"', { exact: true }).check(); await expect(area(page).getByRole('status')).toContainText('51 tasks selected');
 page.once('dialog', (d) => d.accept()); await area(page).getByRole('button', { name: 'Complete selected', exact: true }).click(); await expect(rows(page)).toHaveCount(1); await expect(rows(page)).toContainText('Bulk task 1');
 expect(await (await page.request.get(`/api/v1/tasks/${tasks[1]!.id}`)).json()).toMatchObject({ status: 'ACTIVE', version: 1 });
});
