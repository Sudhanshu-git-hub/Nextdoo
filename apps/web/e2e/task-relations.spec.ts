import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
const origin = { Origin: 'http://localhost:3100' };
const headers = () => ({ ...origin, 'Idempotency-Key': randomUUID() });
async function fixture(page: Page) {
 const registered = await page.request.post('/api/v1/auth/register', { headers: { ...origin, 'X-Forwarded-For': '198.51.100.114' }, data: { email: `relations-${randomUUID()}@test.local`, password: 'task-relations-test-password-123', timeZone: 'UTC' } });
 expect(registered.status()).toBe(200); const { workspaceId } = await registered.json();
 const create = async (title: string) => {
  const response = await page.request.post('/api/v1/tasks', { headers: headers(), data: { workspaceId, title } });
  expect(response.status()).toBe(200); return response.json();
 };
 return { workspaceId, parent: await create('Parent task'), prerequisite: await create('Prerequisite task') };
}
async function open(page: Page) {
 await page.goto('/inbox'); await page.getByRole('button', { name: 'Edit "Parent task"', exact: true }).click();
 const editor = page.getByRole('dialog', { name: 'Edit task', exact: true });
 await editor.getByText('Subtasks and dependencies', { exact: true }).click(); return editor;
}
test('subtasks and prerequisites can be created, navigated, edited and removed with keyboard controls', async ({ page }) => {
 const { parent, prerequisite } = await fixture(page); const editor = await open(page);
 await editor.getByLabel('New subtask', { exact: true }).fill('Child task');
 await editor.getByRole('button', { name: 'Add subtask', exact: true }).click();
 const child = editor.getByRole('button', { name: 'Open subtask "Child task"', exact: true });
 await expect(child).toBeVisible(); await child.focus(); await child.press('Enter');
 await expect(editor.getByLabel('Title', { exact: true })).toHaveValue('Child task');
 await editor.getByLabel('Title', { exact: true }).fill('Edited child');
 await editor.getByRole('button', { name: 'Save changes', exact: true }).click();
 await expect(editor).not.toBeVisible();
 await open(page);
 await editor.getByLabel('Find a related task', { exact: true }).fill('Prerequisite');
 await editor.getByRole('button', { name: 'Search tasks', exact: true }).click();
 await editor.getByLabel('Select related task', { exact: true }).selectOption(prerequisite.id);
 await editor.getByRole('button', { name: 'Add prerequisite', exact: true }).focus(); await page.keyboard.press('Enter');
 await expect(editor.getByRole('button', { name: 'Open prerequisite "Prerequisite task"', exact: true })).toBeVisible();
 const { default: AxeBuilder } = await import('@axe-core/playwright');
 expect((await new AxeBuilder({ page }).include('.task-editor').withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([]);
 await editor.getByRole('button', { name: 'Remove prerequisite "Prerequisite task"', exact: true }).click();
 await expect(editor.getByRole('button', { name: 'Open prerequisite "Prerequisite task"', exact: true })).not.toBeVisible();
 await editor.getByRole('button', { name: 'Open subtask "Edited child"', exact: true }).click();
 await editor.getByText('Subtasks and dependencies', { exact: true }).click();
 await expect(editor.getByRole('button', { name: 'Open parent "Parent task"', exact: true })).toBeVisible();
 await editor.getByRole('button', { name: 'Remove parent', exact: true }).click();
 await expect(editor.getByRole('button', { name: 'Open parent "Parent task"', exact: true })).not.toBeVisible();
 await editor.getByLabel('Find a related task', { exact: true }).fill('Parent');
 await editor.getByRole('button', { name: 'Search tasks', exact: true }).click();
 await editor.getByLabel('Select related task', { exact: true }).selectOption(parent.id);
 await editor.getByRole('button', { name: 'Set parent', exact: true }).click();
 await editor.getByRole('button', { name: 'Open parent "Parent task"', exact: true }).click();
 await expect(editor.getByLabel('Title', { exact: true })).toHaveValue('Parent task');
 await editor.getByRole('button', { name: 'Back to previous task', exact: true }).click();
 await expect(editor.getByLabel('Title', { exact: true })).toHaveValue('Edited child');
});
test('relationship HTTP contracts protect versions, cycles, replay and tenant boundaries', async ({ page, playwright }) => {
 const { parent, prerequisite, workspaceId } = await fixture(page); const url = `/api/v1/tasks/${parent.id}/relations`;
 const key = headers(), data = { version: parent.version, addDependencyId: prerequisite.id };
 const first = await page.request.patch(url, { headers: key, data }); expect(first.status()).toBe(200);
 expect(await (await page.request.patch(url, { headers: key, data })).json()).toEqual(await first.json());
 expect((await page.request.patch(url, { headers: headers(), data })).status()).toBe(409);
 expect((await page.request.patch(url, { headers: origin, data })).status()).toBe(400);
 const cycle = await page.request.patch(`/api/v1/tasks/${prerequisite.id}/relations`, { headers: headers(), data: { version: prerequisite.version, addDependencyId: parent.id } });
 expect(cycle.status()).toBe(422); expect((await cycle.json()).code).toBe('DEPENDENCY_CYCLE');
 expect((await page.request.get('/api/v1/tasks/not-an-id/relations')).status()).toBe(400);
 expect((await page.request.patch(url, { headers: headers(), data: { version: 2 } })).status()).toBe(400);
 const other = await playwright.request.newContext({ baseURL: 'http://localhost:3100' });
 try {
  expect((await other.get(url)).status()).toBe(401);
  expect((await other.post('/api/v1/auth/register', { headers: { ...origin, 'X-Forwarded-For': '198.51.100.115' }, data: { email: `foreign-rel-${randomUUID()}@test.local`, password: 'task-relations-test-password-123', timeZone: 'UTC' } })).status()).toBe(200);
  expect((await other.get(url)).status()).toBe(404);
  expect((await other.patch(url, { headers: headers(), data: { version: 2, parentTaskId: null } })).status()).toBe(404);
  expect((await other.post(`/api/v1/tasks/${parent.id}/subtasks`, { headers: headers(), data: { version: 2, title: 'Foreign child' } })).status()).toBe(404);
 } finally { await other.dispose(); }
 const result = await page.request.get(`/api/v1/tasks?workspaceId=${workspaceId}&dependencyOfTaskId=${parent.id}`);
 expect((await result.json()).data.map((t: { id: string }) => t.id)).toEqual([prerequisite.id]);
});
test('lost subtask acknowledgement retains the draft and retry identity; Escape protects unsaved input', async ({ page }) => {
 const { parent, workspaceId } = await fixture(page); const editor = await open(page);
 let dropped = false; const keys: string[] = [];
 await page.route(`**/api/v1/tasks/${parent.id}/subtasks`, async (route) => {
  keys.push(route.request().headers()['idempotency-key']!);
  if (dropped) return route.continue(); dropped = true;
  expect((await route.fetch()).status()).toBe(200); await route.abort('failed');
 });
 await editor.getByLabel('New subtask', { exact: true }).fill('Retry child');
 page.once('dialog', (dialog) => dialog.dismiss()); await page.keyboard.press('Escape');
 await expect(editor.getByLabel('New subtask', { exact: true })).toHaveValue('Retry child');
 await editor.getByRole('button', { name: 'Add subtask', exact: true }).click();
 await expect(editor.locator('.task-relations [role="alert"]')).toContainText('Could not save');
 await editor.getByRole('button', { name: 'Add subtask', exact: true }).click();
 await expect(editor.getByRole('button', { name: 'Open subtask "Retry child"', exact: true })).toBeVisible();
 expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]);
 expect((await (await page.request.get(`/api/v1/tasks?workspaceId=${workspaceId}&parentTaskId=${parent.id}`)).json()).data).toHaveLength(1);
});
test('a stale parent does not accept a child until reviewed and dirty metadata cannot race relation edits', async ({ page }) => {
 const { parent } = await fixture(page); const editor = await open(page);
 await editor.getByLabel('New subtask', { exact: true }).fill('Conflict child');
 expect((await page.request.patch(`/api/v1/tasks/${parent.id}`, { headers: headers(), data: { version: parent.version, title: 'External parent' } })).status()).toBe(200);
 await editor.getByRole('button', { name: 'Add subtask', exact: true }).click();
 await expect(editor.locator('.task-relations [role="alert"]')).toContainText('changed');
 await expect(editor.getByLabel('New subtask', { exact: true })).toHaveValue('Conflict child');
 await editor.getByRole('button', { name: 'Reload task and relationships', exact: true }).click();
 await expect(editor.getByLabel('Title', { exact: true })).toHaveValue('External parent');
 await editor.getByRole('button', { name: 'Add subtask', exact: true }).click();
 await expect(editor.getByRole('button', { name: 'Open subtask "Conflict child"', exact: true })).toBeVisible();
 await editor.getByLabel('Title', { exact: true }).fill('Unsaved metadata');
 await expect(editor.getByRole('button', { name: 'Add subtask', exact: true })).toBeDisabled();
});

test('subtask navigation reaches more than one page and preserves loaded children on page failure', async ({ page }) => {
 const { parent } = await fixture(page);
 for (let i = 0; i < 52; i++) expect((await page.request.post(`/api/v1/tasks/${parent.id}/subtasks`, { headers: headers(), data: { version: 1, title: `Paged child ${i}` } })).status()).toBe(200);
 // The parent is no longer on Inbox's first page; navigate through a child instead.
 await page.goto('/inbox'); await page.getByRole('button', { name: 'Edit "Paged child 51"', exact: true }).click();
 const editor = page.getByRole('dialog', { name: 'Edit task', exact: true });
 await editor.getByText('Subtasks and dependencies', { exact: true }).click();
 await editor.getByRole('button', { name: 'Open parent "Parent task"', exact: true }).click();
 await editor.getByText('Subtasks and dependencies', { exact: true }).click();
 const list = editor.getByRole('region', { name: 'Subtask list', exact: true });
 await expect(list.getByRole('button', { name: /^Open subtask/ })).toHaveCount(50);
 let failed = false;
 await page.route('**/api/v1/tasks?**', (route) => {
  if (!failed && new URL(route.request().url()).searchParams.has('cursor')) { failed = true; return route.abort('failed'); }
  return route.continue();
 });
 await list.getByRole('button', { name: 'Load more tasks', exact: true }).click();
 await expect(list.getByRole('button', { name: 'Retry task loading', exact: true })).toBeVisible();
 await expect(list.getByRole('button', { name: /^Open subtask/ })).toHaveCount(50);
 await list.getByRole('button', { name: 'Retry task loading', exact: true }).click();
 await expect(list.getByRole('button', { name: /^Open subtask/ })).toHaveCount(52);
});
