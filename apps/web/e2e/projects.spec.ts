import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
const origin = { Origin: 'http://localhost:3100' };
const keyHeaders = () => ({ ...origin, 'Idempotency-Key': randomUUID() });
async function fixture(page: Page) {
  const register = await page.request.post('/api/v1/auth/register', { headers: { ...origin, 'X-Forwarded-For': '198.51.100.84' }, data: { email: `projects-${randomUUID()}@test.local`, password: 'project-test-password-123', timeZone: 'UTC' } });
  expect(register.status()).toBe(200); const { workspaceId } = await register.json();
  const created = await page.request.post('/api/v1/projects', { headers: keyHeaders(), data: { workspaceId, name: 'Work' } });
  expect(created.status()).toBe(200);
  return { workspaceId, project: await created.json() as { id: string; version: number } };
}
test('project metadata, archive and restore work without changing existing tasks', async ({ page }) => {
  const { workspaceId, project } = await fixture(page);
  const task = await page.request.post('/api/v1/tasks', { headers: keyHeaders(), data: { workspaceId, projectId: project.id, title: 'Preserved task' } });
  const entity = await task.json();
  await page.goto('/projects'); await page.getByRole('button', { name: 'Manage "Work"' }).click();
  const editor = page.getByRole('dialog', { name: 'Project settings' });
  await editor.getByLabel('Project name', { exact: true }).fill('Client work');
  await editor.getByLabel('Description', { exact: true }).fill('Plain-text project notes');
  await editor.getByRole('button', { name: 'Save project', exact: true }).click();
  await expect(editor).not.toBeVisible();
  await page.getByRole('button', { name: 'Open Client work' }).click();
  await page.getByRole('button', { name: 'Project settings', exact: true }).click();
  page.once('dialog', (d) => d.accept());
  await editor.getByRole('button', { name: 'Archive project', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'This project is archived' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit "Preserved task"' })).toBeVisible();
  expect((await (await page.request.get(`/api/v1/tasks/${entity.id}`)).json()).status).toBe('ACTIVE');
  await page.getByRole('button', { name: 'Back to projects' }).click();
  await expect(page.getByRole('button', { name: 'Open Client work' })).not.toBeVisible();
  await page.getByRole('button', { name: /Archived projects/ }).click();
  await page.getByRole('button', { name: 'Manage "Client work"' }).click();
  await editor.getByRole('button', { name: 'Restore project', exact: true }).click();
  await page.getByRole('button', { name: /Active projects/ }).click();
  await expect(page.getByRole('button', { name: 'Open Client work' })).toBeVisible();
});
test('project editor preserves conflicting drafts and passes scoped keyboard/axe checks', async ({ page }) => {
  const { default: AxeBuilder } = await import('@axe-core/playwright');
  const { project } = await fixture(page);
  await page.goto('/projects'); const trigger = page.getByRole('button', { name: 'Manage "Work"' });
  await trigger.focus(); await trigger.press('Enter');
  const editor = page.getByRole('dialog', { name: 'Project settings' });
  const name = editor.getByLabel('Project name', { exact: true }); await expect(name).toBeFocused();
  expect((await new AxeBuilder({ page }).include('.project-settings').withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([]);
  await name.fill('Unsaved project draft');
  page.once('dialog', (d) => d.dismiss());
  await page.keyboard.press('Escape');
  await expect(name).toHaveValue('Unsaved project draft');
  await name.fill('My project draft');
  const external = await page.request.patch(`/api/v1/projects/${project.id}`, { headers: keyHeaders(), data: { version: project.version, name: 'Other version', color: '#ff0000' } });
  expect(external.status()).toBe(200);
  await editor.getByRole('button', { name: 'Save project', exact: true }).click();
  await expect(name).toHaveValue('My project draft'); await expect(editor).toContainText('Other version');
  await editor.getByRole('button', { name: 'Keep my changes against this version' }).click();
  await editor.getByRole('button', { name: 'Save project', exact: true }).click();
  await expect(editor).not.toBeVisible();
  expect(await (await page.request.get(`/api/v1/projects/${project.id}`)).json()).toMatchObject({ name: 'My project draft', color: '#ff0000' });
  await expect(page.getByRole('button', { name: 'Manage "My project draft"' })).toBeFocused();
});
test('project lifecycle HTTP contracts require versions/identity and enforce tenant boundaries', async ({ page, playwright }) => {
  const { project } = await fixture(page);
  expect((await page.request.patch(`/api/v1/projects/${project.id}`, { headers: keyHeaders(), data: { name: 'No version' } })).status()).toBe(400);
  expect((await page.request.get('/api/v1/projects/not-an-id')).status()).toBe(400);
  for (const data of [{ version: project.version, name: '   ' }, { version: project.version, status: 'ARCHIVED' }, { version: project.version, color: 'invalid' }]) {
    expect((await page.request.patch(`/api/v1/projects/${project.id}`, { headers: keyHeaders(), data })).status()).toBe(400);
  }
  const url = `/api/v1/projects/${project.id}/archive`, headers = keyHeaders();
  const first = await page.request.post(url, { headers, data: { version: project.version } });
  expect(first.status()).toBe(200); const archived = await first.json();
  const replay = await page.request.post(url, { headers, data: { version: project.version } });
  expect(await replay.json()).toEqual(archived);
  expect(first.headers()['x-request-id']).toBeTruthy();
  expect((await page.request.post(url, { headers: origin, data: { version: archived.version } })).status()).toBe(400);
  const other = await playwright.request.newContext({ baseURL: 'http://localhost:3100' });
  try {
    expect((await other.get(`/api/v1/projects/${project.id}`)).status()).toBe(401);
    await other.post('/api/v1/auth/register', { headers: { ...origin, 'X-Forwarded-For': '198.51.100.85' }, data: { email: `foreign-${randomUUID()}@test.local`, password: 'project-test-password-123', timeZone: 'UTC' } });
    expect((await other.get(`/api/v1/projects/${project.id}`)).status()).toBe(404);
    expect((await other.patch(`/api/v1/projects/${project.id}`, { headers: keyHeaders(), data: { version: archived.version, name: 'Foreign change' } })).status()).toBe(404);
    expect((await other.post(`/api/v1/projects/${project.id}/restore`, { headers: keyHeaders(), data: { version: archived.version } })).status()).toBe(404);
  } finally { await other.dispose(); }
});
