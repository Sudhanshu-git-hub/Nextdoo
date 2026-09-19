import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
const origin = { Origin: 'http://localhost:3100' };

async function account(page: Page) {
  const response = await page.request.post('/api/v1/auth/register', { headers: { ...origin, 'X-Forwarded-For': '198.51.100.55' }, data: { email: `location-${randomUUID()}@test.local`, password: 'location-only-password-123', timeZone: 'UTC' } });
  expect(response.status()).toBe(200);
  return await response.json() as { workspaceId: string };
}
async function createTask(page: Page, workspaceId: string, title: string, extra: Record<string, unknown> = {}) {
  const response = await page.request.post('/api/v1/tasks', { headers: { ...origin, 'Idempotency-Key': randomUUID() }, data: { workspaceId, title, ...extra } });
  expect(response.status()).toBe(200);
  return await response.json() as { id: string; version: number; location: string | null };
}

test('location survives create, read, the editor round trip, clearing, and validation', async ({ page }) => {
  const { workspaceId } = await account(page);
  const task = await createTask(page, workspaceId, 'Locate me', { location: '  Room 12, Building B  ' });
  expect(task.location).toBe('Room 12, Building B');
  const read = await (await page.request.get(`/api/v1/tasks/${task.id}`)).json();
  expect(read.location).toBe('Room 12, Building B');

  // Over the shared 500-character bound is a validation failure, not a persisted row.
  const tooLong = await page.request.post('/api/v1/tasks', { headers: { ...origin, 'Idempotency-Key': randomUUID() }, data: { workspaceId, title: 'Too long', location: 'x'.repeat(501) } });
  expect(tooLong.status()).toBe(400);
  expect((await tooLong.json()).code).toBe('VALIDATION_FAILED');

  await page.goto('/inbox');
  await page.getByRole('button', { name: 'Edit "Locate me"', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit task', exact: true });
  const location = editor.getByLabel('Location', { exact: true });
  await expect(location).toHaveValue('Room 12, Building B');

  await location.fill('Dock 7');
  await editor.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(editor).not.toBeVisible();
  expect((await (await page.request.get(`/api/v1/tasks/${task.id}`)).json()).location).toBe('Dock 7');

  // Reopen: the value is restored, then cleared.
  await page.getByRole('button', { name: 'Edit "Locate me"', exact: true }).click();
  const reopened = page.getByRole('dialog', { name: 'Edit task', exact: true });
  await expect(reopened.getByLabel('Location', { exact: true })).toHaveValue('Dock 7');
  await reopened.getByLabel('Location', { exact: true }).fill('');
  await reopened.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(reopened).not.toBeVisible();
  expect((await (await page.request.get(`/api/v1/tasks/${task.id}`)).json()).location).toBeNull();
});

test('sync push and pull carry location through the writable-field boundary', async ({ page }) => {
  const { workspaceId } = await account(page);
  const id = randomUUID();

  const created = await page.request.post('/api/v1/sync/push', { headers: { ...origin, 'Idempotency-Key': randomUUID() }, data: {
    deviceId: 'location-e2e',
    mutations: [{ mutationId: randomUUID(), entityType: 'task', entityId: id, operation: 'create', payload: { title: 'Offline location', location: 'Warehouse B1', bogusField: 'dropped' }, baseVersion: null, createdAt: new Date().toISOString() }],
  } });
  expect(created.status()).toBe(200);
  expect((await created.json()).results[0].status).toBe('applied');
  expect((await (await page.request.get(`/api/v1/tasks/${id}`)).json()).location).toBe('Warehouse B1');

  const read = await (await page.request.get(`/api/v1/tasks/${id}`)).json();
  const updated = await page.request.post('/api/v1/sync/push', { headers: { ...origin, 'Idempotency-Key': randomUUID() }, data: {
    deviceId: 'location-e2e',
    mutations: [{ mutationId: randomUUID(), entityType: 'task', entityId: id, operation: 'update', payload: { location: 'Dock 7' }, baseVersion: read.version, createdAt: new Date().toISOString() }],
  } });
  expect((await updated.json()).results[0].status).toBe('applied');

  const pull = await (await page.request.get(`/api/v1/sync/pull?workspaceId=${workspaceId}&cursor=0`)).json();
  const taskChanges = pull.changes.filter((c: { entityType: string; entityId: string }) => c.entityType === 'task' && c.entityId === id);
  expect(taskChanges.map((c: { operation: string }) => c.operation)).toEqual(['create', 'update']);
  expect(taskChanges.map((c: { payload: { location: string | null } }) => c.payload.location)).toEqual(['Warehouse B1', 'Dock 7']);
});

test('foreign accounts cannot read or write another workspace location', async ({ page, request }) => {
  const owner = await account(page);
  const task = await createTask(page, owner.workspaceId, 'Private spot', { location: 'Owner only' });

  const foreign = await request.post('/api/v1/auth/register', { headers: { ...origin, 'X-Forwarded-For': '198.51.100.56' }, data: { email: `location-foreign-${randomUUID()}@test.local`, password: 'location-only-password-123', timeZone: 'UTC' } });
  expect(foreign.status()).toBe(200);
  expect((await request.get(`/api/v1/tasks/${task.id}`)).status()).toBe(404);
  const patch = await request.patch(`/api/v1/tasks/${task.id}`, { headers: { ...origin, 'Idempotency-Key': randomUUID() }, data: { version: task.version, location: 'Hijacked' } });
  expect(patch.status()).toBe(404);
  const syncPush = await request.post('/api/v1/sync/push', { headers: { ...origin, 'Idempotency-Key': randomUUID() }, data: {
    deviceId: 'location-foreign',
    mutations: [{ mutationId: randomUUID(), entityType: 'task', entityId: task.id, operation: 'update', payload: { location: 'Hijacked' }, baseVersion: task.version, createdAt: new Date().toISOString() }],
  } });
  expect((await syncPush.json()).results[0].status).toBe('rejected');
  expect((await (await page.request.get(`/api/v1/tasks/${task.id}`)).json()).location).toBe('Owner only');
});

test('the editor with a location field is accessible', async ({ page }) => {
  const { workspaceId } = await account(page);
  await createTask(page, workspaceId, 'Accessible', { location: 'Front desk' });
  await page.goto('/inbox');
  await page.getByRole('button', { name: 'Edit "Accessible"', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit task', exact: true });
  await expect(editor.getByLabel('Location', { exact: true })).toBeVisible();
  const { default: AxeBuilder } = await import('@axe-core/playwright');
  const result = await new AxeBuilder({ page }).include('.task-editor').withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(result.violations).toEqual([]);
});
