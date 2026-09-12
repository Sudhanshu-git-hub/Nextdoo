import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
const origin = { Origin: 'http://localhost:3100' };
async function account(page: Page) {
  const response = await page.request.post('/api/v1/auth/register', { headers: { ...origin, 'X-Forwarded-For': '198.51.100.42' }, data: { email: `online-${randomUUID()}@test.local`, password: 'online-only-password-123', timeZone: 'UTC' } });
  expect(response.status()).toBe(200); return await response.json() as { workspaceId: string };
}
async function task(page: Page, workspaceId: string, title: string) {
  const response = await page.request.post('/api/v1/tasks', { headers: { ...origin, 'Idempotency-Key': randomUUID() }, data: { workspaceId, title } });
  expect(response.status()).toBe(200); return await response.json() as { id: string; version: number };
}
test('structured capture confirms then persists tags and the existing project with replay identity', async ({ page }) => {
  const { workspaceId } = await account(page);
  const p = await page.request.post('/api/v1/projects', { headers: { ...origin, 'Idempotency-Key': randomUUID() }, data: { workspaceId, name: 'Work' } });
  const project = await p.json();
  await page.goto('/inbox');
  const raw = 'Prepare brief today at 11:59pm for 30 minutes #finance +Work';
  await page.locator('#capture').fill(raw); await page.locator('#capture').press('Enter');
  const confirmation = page.getByRole('group', { name: 'Confirm interpreted task details' });
  await expect(confirmation).toBeVisible(); await expect(confirmation).toContainText('finance'); await expect(confirmation).toContainText('Work');
  await expect(page.locator('#capture')).toHaveValue(raw);
  const saved = page.waitForResponse((r) => r.url().endsWith('/api/v1/tasks') && r.request().method() === 'POST');
  await confirmation.getByRole('button', { name: 'Save as shown' }).click();
  const response = await saved; expect(response.status()).toBe(200);
  const entity = await response.json(); expect(entity.projectId).toBe(project.id);
  const details = await (await page.request.get(`/api/v1/tasks/${entity.id}`)).json(); expect(details.tagIds).toHaveLength(1);
  const replay = await page.request.post('/api/v1/tasks', { headers: { ...origin, 'Idempotency-Key': response.request().headers()['idempotency-key']! }, data: response.request().postDataJSON() });
  expect((await replay.json()).id).toBe(entity.id);
  await page.goto('/projects'); await page.getByRole('button', { name: 'Open Work' }).click();
  await expect(page.getByRole('button', { name: 'Edit "Prepare brief"', exact: true })).toBeVisible();
});
test('editor keeps a conflicting draft and reapplies only deliberately changed fields', async ({ page }) => {
  const { workspaceId } = await account(page), initial = await task(page, workspaceId, 'Original');
  await page.goto('/inbox'); await page.getByRole('button', { name: 'Edit "Original"' }).click();
  const editor = page.getByRole('dialog', { name: 'Edit task' });
  await editor.getByLabel('Title', { exact: true }).fill('My draft');
  await editor.getByLabel('Description', { exact: true }).fill('<script>private notes</script>');
  await page.request.patch(`/api/v1/tasks/${initial.id}`, { headers: { ...origin, 'Idempotency-Key': randomUUID() }, data: { version: initial.version, title: 'Other device', priority: 'HIGH' } });
  await editor.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(editor.getByLabel('Title', { exact: true })).toHaveValue('My draft');
  await expect(editor).toContainText('Other device');
  await editor.getByRole('button', { name: 'Keep my changes against this version' }).click();
  await editor.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(editor).not.toBeVisible();
  const final = await (await page.request.get(`/api/v1/tasks/${initial.id}`)).json();
  expect(final).toMatchObject({ title: 'My draft', priority: 'HIGH', description: '<script>private notes</script>' });
});
test('inbox can reach more than one page without duplicates', async ({ page }) => {
  const { workspaceId } = await account(page);
  for (let i = 0; i < 52; i++) await task(page, workspaceId, `Paged ${i}`);
  await page.goto('/inbox');
  await expect(page.getByRole('button', { name: /^Edit "Paged/ })).toHaveCount(50);
  let failPage = true;
  await page.route('**/api/v1/tasks?**', (route) => {
    if (new URL(route.request().url()).searchParams.has('cursor') && failPage) { failPage = false; return route.abort('failed'); }
    return route.continue();
  });
  await page.getByRole('button', { name: 'Load more tasks', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry task loading' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Edit "Paged/ })).toHaveCount(50);
  await page.getByRole('button', { name: 'Retry task loading' }).click();
  await expect(page.getByRole('button', { name: /^Edit "Paged/ })).toHaveCount(52);
  await expect(page.getByRole('button', { name: 'Load more tasks', exact: true })).not.toBeVisible();
  await page.goto('/focus');
  await expect(page.getByRole('button', { name: /^Start a focus timer for Paged/ })).toHaveCount(50);
  await page.getByRole('button', { name: 'Load more tasks', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Start a focus timer for Paged/ })).toHaveCount(52);
});

test('lost capture acknowledgement is enqueued and reconciled without duplicate tasks or tags', async ({ page }) => {
  const { workspaceId } = await account(page);
  await page.goto('/inbox');
  await page.locator('#capture').fill('Retried capture #once'); await page.locator('#capture').press('Enter');
  let dropped = false;
  await page.route('**/api/v1/tasks', async (route) => {
    if (route.request().method() !== 'POST' || dropped) return route.continue();
    dropped = true;
    const accepted = await route.fetch(); expect(accepted.status()).toBe(200);
    await route.abort('failed');
  });
  await page.getByRole('button', { name: 'Save as shown' }).click();
  // The server accepted the create but the acknowledgement was lost: the
  // capture is durably enqueued under its client-generated entity id.
  // (The parser splits "#once" off the title into a tag.)
  await expect(page.getByText('Saved offline: "Retried capture" will sync when you\'re back online.', { exact: true })).toBeVisible();
  await expect(page.locator('#capture')).toHaveValue('');
  // Reconcile re-pushes the same create; the server dedupes it to `duplicate`.
  const result = await page.waitForFunction(async (ws) => {
    const r = await fetch(`/api/v1/tasks?workspaceId=${ws}`);
    const body = await r.json();
    return body.data.length === 1;
  }, workspaceId, { timeout: 20000 });
  await result;
  const tasks = await (await page.request.get(`/api/v1/tasks?workspaceId=${workspaceId}`)).json();
  expect(tasks.data).toHaveLength(1);
  expect(tasks.data[0].title).toBe('Retried capture');
  expect((await (await page.request.get('/api/v1/tags')).json()).data).toHaveLength(1);
  // The queue drained: nothing left waiting to sync.
  await expect(page.getByRole('status').filter({ hasText: /change/ })).toHaveCount(0, { timeout: 10000 });
});

test('task editor supports keyboard dismissal, draft confirmation and automated accessibility checks', async ({ page }) => {
  const { default: AxeBuilder } = await import('@axe-core/playwright');
  const { workspaceId } = await account(page); await task(page, workspaceId, 'Keyboard task');
  await page.goto('/inbox');
  const trigger = page.getByRole('button', { name: 'Edit "Keyboard task"' });
  await trigger.focus(); await trigger.press('Enter');
  const editor = page.getByRole('dialog', { name: 'Edit task' });
  const title = editor.getByLabel('Title', { exact: true });
  await expect(title).toBeFocused();
  const accessibility = await new AxeBuilder({ page }).include('.task-editor').withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(accessibility.violations).toEqual([]);
  await title.fill('Unsaved keyboard draft');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.keyboard.press('Escape');
  await expect(title).toHaveValue('Unsaved keyboard draft');
  page.once('dialog', (dialog) => dialog.accept());
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(editor).not.toBeVisible(); await expect(trigger).toBeFocused();
});
