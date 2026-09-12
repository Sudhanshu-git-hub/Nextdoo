import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
const origin = { Origin: 'http://localhost:3100' };
const headers = () => ({ ...origin, 'Idempotency-Key': randomUUID() });
async function fixture(page: Page) {
 const r = await page.request.post('/api/v1/auth/register', { headers: { ...origin, 'X-Forwarded-For': '198.51.100.124' }, data: { email: `task-recovery-${randomUUID()}@test.local`, password: 'task-recovery-password-123', timeZone: 'UTC' } });
 expect(r.status()).toBe(200); const { workspaceId } = await r.json();
 const task = await (await page.request.post('/api/v1/tasks', { headers: headers(), data: { workspaceId, title: 'Recoverable task' } })).json();
 return { workspaceId, task };
}
async function open(page: Page) {
 await page.goto('/inbox'); await page.getByRole('button', { name: 'Edit "Recoverable task"', exact: true }).click();
 return page.getByRole('dialog', { name: 'Edit task', exact: true });
}
test('archive and trash flows retain task data and offer explicit recovery', async ({ page }) => {
 const { task } = await fixture(page); const editor = await open(page);
 page.once('dialog', (d) => d.dismiss()); await editor.getByRole('button', { name: 'Archive task', exact: true }).click();
 await expect(editor).toBeVisible();
 page.once('dialog', (d) => d.accept()); await editor.getByRole('button', { name: 'Archive task', exact: true }).click();
 await expect(editor).not.toBeVisible(); await expect(page.getByRole('button', { name: 'Edit "Recoverable task"', exact: true })).not.toBeVisible();
 await page.getByRole('link', { name: 'Task history', exact: true }).click();
 await expect(page.getByRole('heading', { name: 'Task history', exact: true })).toBeVisible();
 await page.getByRole('button', { name: 'Edit "Recoverable task"', exact: true }).click();
 await expect(editor.getByRole('button', { name: 'Archive task', exact: true })).not.toBeVisible();
 page.once('dialog', (d) => d.accept()); await editor.getByRole('button', { name: 'Restore task', exact: true }).click();
 await expect(editor).not.toBeVisible();
 await open(page);
 page.once('dialog', (d) => d.accept()); await editor.getByRole('button', { name: 'Move to Trash', exact: true }).click();
 await expect(editor).not.toBeVisible();
 expect((await page.request.get(`/api/v1/tasks/${task.id}`)).status()).toBe(404);
 await page.getByRole('link', { name: 'Task history', exact: true }).click();
 await page.getByRole('button', { name: 'Trash', exact: true }).click();
 const row = page.getByRole('article', { name: 'Deleted task "Recoverable task"', exact: true });
 await expect(row).toContainText('Restore before');
 await expect(page.getByRole('button', { name: 'Edit "Recoverable task"', exact: true })).not.toBeVisible();
 const { default: AxeBuilder } = await import('@axe-core/playwright');
 expect((await new AxeBuilder({ page }).include('.task-history').withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([]);
 page.once('dialog', (d) => d.accept()); await row.getByRole('button', { name: 'Restore task', exact: true }).focus(); await page.keyboard.press('Enter');
 await expect(row).not.toBeVisible();
 expect(await (await page.request.get(`/api/v1/tasks/${task.id}`)).json()).toMatchObject({ title: 'Recoverable task', status: 'ACTIVE', version: 5 });
});
test('completed tasks can be reopened and dirty metadata or a stale version cannot be silently deleted', async ({ page }) => {
 const { task } = await fixture(page);
 expect((await page.request.post(`/api/v1/tasks/${task.id}/complete`, { headers: headers(), data: { version: 1 } })).status()).toBe(200);
 await page.goto('/inbox'); await page.getByRole('link', { name: 'Task history', exact: true }).click();
 await page.getByRole('button', { name: 'Completed', exact: true }).click();
 await page.getByRole('button', { name: 'Mark "Recoverable task" as not done', exact: true }).click();
 await expect(page.getByRole('button', { name: 'Edit "Recoverable task"', exact: true })).not.toBeVisible();
 const editor = await open(page); await editor.getByLabel('Title', { exact: true }).fill('Unsaved title');
 await expect(editor.getByRole('button', { name: 'Move to Trash', exact: true })).toBeDisabled();
 await editor.getByLabel('Title', { exact: true }).fill('Recoverable task');
 expect((await page.request.patch(`/api/v1/tasks/${task.id}`, { headers: headers(), data: { version: 3, title: 'External edit' } })).status()).toBe(200);
 page.once('dialog', (d) => d.accept()); await editor.getByRole('button', { name: 'Move to Trash', exact: true }).click();
 await expect(editor.locator('.task-lifecycle [role="alert"]')).toContainText('changed');
 expect((await page.request.get(`/api/v1/tasks/${task.id}`)).status()).toBe(200);
 await editor.getByRole('button', { name: 'Reload task', exact: true }).click();
 await expect(editor.getByLabel('Title', { exact: true })).toHaveValue('External edit');
});
test('versioned lifecycle HTTP calls reject stale requests while legacy bodyless calls remain compatible', async ({ page, playwright }) => {
 const { task, workspaceId } = await fixture(page); const url = `/api/v1/tasks/${task.id}`;
 for (const version of [null, 'bad', 0, -1]) expect((await page.request.delete(url, { headers: headers(), data: { version } })).status()).toBe(400);
 expect((await page.request.patch(url, { headers: headers(), data: { version: 1, title: 'New version' } })).status()).toBe(200);
 expect((await page.request.delete(url, { headers: headers(), data: { version: 1 } })).status()).toBe(409);
 expect((await page.request.delete(url, { headers: origin, data: { version: 2 } })).status()).toBe(400);
 const key = headers(); const removed = await page.request.delete(url, { headers: key, data: { version: 2 } });
 expect(removed.status()).toBe(200);
 expect(await (await page.request.delete(url, { headers: key, data: { version: 2 } })).json()).toEqual(await removed.json());
 const trash = await page.request.get(`/api/v1/tasks?workspaceId=${workspaceId}&status=DELETED`);
 expect(trash.headers()['cache-control']).toContain('no-store'); expect(trash.headers()['x-request-id']).toBeTruthy();
 expect((await trash.json()).data).toHaveLength(1);
 expect((await page.request.post(`${url}/restore`, { headers: headers(), data: { version: 2 } })).status()).toBe(409);
 const other = await playwright.request.newContext({ baseURL: 'http://localhost:3100' });
 try {
  expect((await other.post(`${url}/restore`, { headers: headers(), data: { version: 3 } })).status()).toBe(401);
  expect((await other.post('/api/v1/auth/register', { headers: { ...origin, 'X-Forwarded-For': '198.51.100.125' }, data: { email: `foreign-recovery-${randomUUID()}@test.local`, password: 'task-recovery-password-123', timeZone: 'UTC' } })).status()).toBe(200);
  expect((await other.post(`${url}/restore`, { headers: headers(), data: { version: 3 } })).status()).toBe(404);
  expect((await other.get(`/api/v1/tasks?workspaceId=${workspaceId}&status=DELETED`)).status()).toBe(403);
 } finally { await other.dispose(); }
 expect((await page.request.post(`${url}/restore`, { headers: headers() })).status()).toBe(200);
 expect((await page.request.delete(url, { headers: headers() })).status()).toBe(200);
 expect((await page.request.post(`${url}/restore`, { headers: headers(), data: {} })).status()).toBe(200);
});
test('lost delete and restore acknowledgements can be retried without a second lifecycle transition', async ({ page }) => {
 const { task } = await fixture(page); const editor = await open(page);
 let droppedDelete = false, droppedRestore = false; const deleteKeys: string[] = [], restoreKeys: string[] = [];
 await page.route(`**/api/v1/tasks/${task.id}`, async (route) => {
  if (route.request().method() !== 'DELETE') return route.continue();
  deleteKeys.push(route.request().headers()['idempotency-key']!);
  if (droppedDelete) return route.continue(); droppedDelete = true;
  expect((await route.fetch()).status()).toBe(200); await route.abort('failed');
 });
 page.once('dialog', (d) => d.accept()); await editor.getByRole('button', { name: 'Move to Trash', exact: true }).click();
 await expect(editor.locator('.task-lifecycle [role="alert"]')).toContainText('Could not update');
 page.once('dialog', (d) => d.accept()); await editor.getByRole('button', { name: 'Move to Trash', exact: true }).click();
 await expect(editor).not.toBeVisible(); expect(deleteKeys).toHaveLength(2); expect(deleteKeys[0]).toBe(deleteKeys[1]);
 await page.getByRole('link', { name: 'Task history', exact: true }).click(); await page.getByRole('button', { name: 'Trash', exact: true }).click();
 await page.route(`**/api/v1/tasks/${task.id}/restore`, async (route) => {
  restoreKeys.push(route.request().headers()['idempotency-key']!);
  if (droppedRestore) return route.continue(); droppedRestore = true;
  expect((await route.fetch()).status()).toBe(200); await route.abort('failed');
 });
 const row = page.getByRole('article', { name: 'Deleted task "Recoverable task"', exact: true });
 page.once('dialog', (d) => d.accept()); await row.getByRole('button', { name: 'Restore task', exact: true }).click();
 await expect(row.getByRole('alert')).toContainText('Could not update');
 page.once('dialog', (d) => d.accept()); await row.getByRole('button', { name: 'Restore task', exact: true }).click();
 await expect(row).not.toBeVisible(); expect(restoreKeys).toHaveLength(2); expect(restoreKeys[0]).toBe(restoreKeys[1]);
 expect(await (await page.request.get(`/api/v1/tasks/${task.id}`)).json()).toMatchObject({ status: 'ACTIVE', version: 3 });
});
test('Trash continuation retains loaded tasks after a page failure and reaches every recoverable task', async ({ page }) => {
 const { task, workspaceId } = await fixture(page);
 for (let i = 0; i < 51; i++) {
  const created = await page.request.post('/api/v1/tasks', { headers: headers(), data: { workspaceId, title: `Deleted page ${i}` } });
  expect(created.status()).toBe(200); const row = await created.json();
  expect((await page.request.delete(`/api/v1/tasks/${row.id}`, { headers: headers(), data: { version: row.version } })).status()).toBe(200);
 }
 expect((await page.request.delete(`/api/v1/tasks/${task.id}`, { headers: headers(), data: { version: 1 } })).status()).toBe(200);
 await page.goto('/task-history'); await page.getByRole('button', { name: 'Trash', exact: true }).click();
 await expect(page.getByRole('article')).toHaveCount(50);
 let failed = false;
 await page.route('**/api/v1/tasks?**', (route) => {
  if (!failed && new URL(route.request().url()).searchParams.has('cursor')) { failed = true; return route.abort('failed'); } return route.continue();
 });
 await page.getByRole('button', { name: 'Load more tasks', exact: true }).click();
 await expect(page.getByRole('button', { name: 'Retry task loading', exact: true })).toBeVisible();
 await expect(page.getByRole('article')).toHaveCount(50);
 await page.getByRole('button', { name: 'Retry task loading', exact: true }).click();
 await expect(page.getByRole('article')).toHaveCount(52);
 await page.getByRole('button', { name: 'Archived', exact: true }).click();
 await expect(page.getByRole('article')).toHaveCount(0);
 await expect(page.getByText('No archived tasks', { exact: true })).toBeVisible();
});
