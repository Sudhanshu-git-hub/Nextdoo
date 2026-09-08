import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
const origin = { Origin: 'http://localhost:3100' };
const headers = () => ({ ...origin, 'Idempotency-Key': randomUUID() });
async function fixture(page: Page) {
  const register = await page.request.post('/api/v1/auth/register', { headers: { ...origin, 'X-Forwarded-For': '198.51.100.94' }, data: { email: `board-${randomUUID()}@test.local`, password: 'board-test-password-123', timeZone: 'UTC' } });
  expect(register.status()).toBe(200); const { workspaceId } = await register.json();
  const project = await (await page.request.post('/api/v1/projects', { headers: headers(), data: { workspaceId, name: 'Board work' } })).json();
  const task = await (await page.request.post('/api/v1/tasks', { headers: headers(), data: { workspaceId, projectId: project.id, title: 'Board task' } })).json();
  return { workspaceId, project, task };
}
async function open(page: Page) {
  await page.goto('/projects'); await page.getByRole('button', { name: 'Open Board work', exact: true }).click();
  await page.getByRole('button', { name: 'Board', exact: true }).click();
}
test('sections can be created, renamed and reordered; tasks move by keyboard and drag', async ({ page }) => {
  const { task } = await fixture(page); await open(page);
  await page.getByLabel('New section', { exact: true }).fill('Review');
  await page.getByRole('button', { name: 'Add section', exact: true }).click();
  const review = page.getByRole('region', { name: 'Review section', exact: true });
  await expect(review).toBeVisible();
  await review.getByRole('button', { name: 'Rename section', exact: true }).click();
  await review.getByLabel('Section name', { exact: true }).fill('Ready');
  await review.getByRole('button', { name: 'Save section name', exact: true }).click();
  const ready = page.getByRole('region', { name: 'Ready section', exact: true });
  await expect(ready.getByRole('button', { name: 'Rename section', exact: true })).toBeFocused();
  await ready.getByRole('button', { name: 'Move section earlier', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(ready.getByRole('heading', { name: 'Ready', exact: true })).toBeFocused();
  await expect(page.locator('[data-section-id]').first()).toHaveAccessibleName('Ready section');
  const destination = page.getByLabel('Destination for "Board task"', { exact: true });
  await destination.focus(); await destination.press('ArrowDown'); await destination.press('Enter');
  await page.getByRole('button', { name: 'Move "Board task"', exact: true }).focus(); await page.keyboard.press('Enter');
  await expect(ready.getByRole('button', { name: 'Edit "Board task"', exact: true })).toBeVisible();
  const todo = page.getByRole('region', { name: 'To do section', exact: true });
  await ready.locator(`[data-task-id="${task.id}"]`).dragTo(todo);
  await expect(todo.getByRole('button', { name: 'Edit "Board task"', exact: true })).toBeVisible();
  const { default: AxeBuilder } = await import('@axe-core/playwright');
  expect((await new AxeBuilder({ page }).include('.project-board').withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([]);
  await page.reload(); await page.getByRole('button', { name: 'Open Board work', exact: true }).click(); await page.getByRole('button', { name: 'Board', exact: true }).click();
  await expect(page.getByRole('region', { name: 'To do section', exact: true }).getByRole('button', { name: 'Edit "Board task"', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'List', exact: true }).click(); await expect(page.getByRole('button', { name: 'Edit "Board task"', exact: true })).toBeVisible();
});
test('section drafts survive conflicts and stale task moves do not overwrite another edit', async ({ page }) => {
  const { project, task } = await fixture(page); await open(page);
  const section = (await (await page.request.get(`/api/v1/sections?projectId=${project.id}`)).json()).data[0];
  const todo = page.getByRole('region', { name: 'To do section', exact: true });
  await todo.getByRole('button', { name: 'Rename section', exact: true }).click();
  await todo.getByLabel('Section name', { exact: true }).fill('My section draft');
  expect((await page.request.patch(`/api/v1/sections/${section.id}`, { headers: headers(), data: { version: section.version, name: 'External section' } })).status()).toBe(200);
  await todo.getByRole('button', { name: 'Save section name', exact: true }).click();
  await expect(page.getByLabel('Section name', { exact: true })).toHaveValue('My section draft');
  await expect(page.locator('.project-board [role="alert"]')).toContainText('changed');
  await page.getByRole('button', { name: 'Save section name', exact: true }).click();
  await expect(page.getByRole('region', { name: 'My section draft section', exact: true })).toBeVisible();
  expect((await page.request.patch(`/api/v1/tasks/${task.id}`, { headers: headers(), data: { version: task.version, title: 'External task' } })).status()).toBe(200);
  await page.getByLabel('Destination for "Board task"', { exact: true }).selectOption(section.id);
  await page.getByRole('button', { name: 'Move "Board task"', exact: true }).click();
  await expect(page.locator('.project-board [role="alert"]')).toContainText('changed');
  await expect(page.getByRole('button', { name: 'Edit "External task"', exact: true })).toBeVisible();
  expect(await (await page.request.get(`/api/v1/tasks/${task.id}`)).json()).toMatchObject({ sectionId: null, title: 'External task' });
});
test('section HTTP contracts enforce versions, replay, archive and tenant boundaries', async ({ page, playwright }) => {
  const { project } = await fixture(page);
  const url = '/api/v1/sections', key = headers(), data = { projectId: project.id, name: 'Review' };
  const first = await page.request.post(url, { headers: key, data }); expect(first.status()).toBe(200); const section = await first.json();
  expect(await (await page.request.post(url, { headers: key, data })).json()).toEqual(section);
  expect((await page.request.post(url, { headers: origin, data })).status()).toBe(400);
  expect((await page.request.patch(`${url}/${section.id}`, { headers: headers(), data: { name: 'No version' } })).status()).toBe(400);
  expect((await page.request.patch(`${url}/bad-id`, { headers: headers(), data: { version: 1, name: 'Bad' } })).status()).toBe(400);
  expect((await page.request.get(`${url}?projectId=bad-id`)).status()).toBe(400);
  expect((await page.request.patch(`${url}/${section.id}`, { headers: headers(), data: { version: 1, beforeId: section.id } })).status()).toBe(400);
  const other = await playwright.request.newContext({ baseURL: 'http://localhost:3100' });
  try {
    expect((await other.get(`${url}?projectId=${project.id}`)).status()).toBe(401);
    await other.post('/api/v1/auth/register', { headers: { ...origin, 'X-Forwarded-For': '198.51.100.95' }, data: { email: `foreign-board-${randomUUID()}@test.local`, password: 'board-test-password-123', timeZone: 'UTC' } });
    expect((await other.get(`${url}?projectId=${project.id}`)).status()).toBe(404);
    expect((await other.patch(`${url}/${section.id}`, { headers: headers(), data: { version: 1, name: 'Foreign' } })).status()).toBe(404);
    expect((await other.post(url, { headers: headers(), data })).status()).toBe(404);
  } finally { await other.dispose(); }
  expect((await page.request.post(`/api/v1/projects/${project.id}/archive`, { headers: headers(), data: { version: project.version } })).status()).toBe(200);
  expect((await page.request.patch(`${url}/${section.id}`, { headers: headers(), data: { version: 1, name: 'Archived' } })).status()).toBe(400);
  expect((await page.request.post(url, { headers: headers(), data })).status()).toBe(400);
  expect((await page.request.get(`${url}?projectId=${project.id}`)).status()).toBe(200);
});
test('board pagination retains loaded cards after a page error and reaches every unsectioned task', async ({ page }) => {
  const { project, workspaceId } = await fixture(page);
  for (let i = 0; i < 51; i++) {
    expect((await page.request.post('/api/v1/tasks', { headers: headers(), data: { workspaceId, projectId: project.id, title: `Paged board ${i}` } })).status()).toBe(200);
  }
  await open(page);
  await expect(page.locator('.project-board [data-task-id]')).toHaveCount(50);
  let failed = false;
  await page.route('**/api/v1/tasks?**', (route) => {
    if (!failed && new URL(route.request().url()).searchParams.has('cursor')) { failed = true; return route.abort('failed'); }
    return route.continue();
  });
  await page.getByRole('button', { name: 'Load more tasks', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry task loading', exact: true })).toBeVisible();
  await expect(page.locator('.project-board [data-task-id]')).toHaveCount(50);
  await page.getByRole('button', { name: 'Retry task loading', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Unsectioned section', exact: true }).locator('[data-task-id]')).toHaveCount(52);
  expect(await page.locator('.project-board [data-task-id]').evaluateAll((rows) => new Set(rows.map((r) => r.getAttribute('data-task-id'))).size)).toBe(52);
  await expect(page.getByRole('button', { name: 'Load more tasks', exact: true })).not.toBeVisible();
});
test('lost section acknowledgement retains the draft and replays instead of creating duplicates', async ({ page }) => {
  const { project } = await fixture(page); await open(page);
  let dropped = false;
  const identities: string[] = [];
  await page.route('**/api/v1/sections', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    identities.push(route.request().headers()['idempotency-key']!);
    if (dropped) return route.continue();
    dropped = true; expect((await route.fetch()).status()).toBe(200); await route.abort('failed');
  });
  await page.getByLabel('New section', { exact: true }).fill('Retry once');
  await page.getByRole('button', { name: 'Add section', exact: true }).click();
  await expect(page.locator('.project-board [role="alert"]')).toContainText('Could not save');
  await expect(page.getByLabel('New section', { exact: true })).toHaveValue('Retry once');
  await page.getByRole('button', { name: 'Add section', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Retry once section', exact: true })).toBeVisible();
  expect(identities).toHaveLength(2); expect(identities[0]).toBe(identities[1]);
  expect((await (await page.request.get(`/api/v1/sections?projectId=${project.id}`)).json()).data).toHaveLength(2);
});
test('board task editor moves between projects and archived boards keep tasks visible with section controls disabled', async ({ page }) => {
  const { project, task, workspaceId } = await fixture(page);
  const section = (await (await page.request.get(`/api/v1/sections?projectId=${project.id}`)).json()).data[0];
  expect((await page.request.patch(`/api/v1/tasks/${task.id}`, { headers: headers(), data: { version: task.version, sectionId: section.id } })).status()).toBe(200);
  const other = await (await page.request.post('/api/v1/projects', { headers: headers(), data: { workspaceId, name: 'Destination project' } })).json();
  await open(page); await page.getByRole('button', { name: 'Edit "Board task"', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit task', exact: true });
  await editor.getByLabel('Project', { exact: true }).selectOption(other.id);
  await editor.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(editor).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit "Board task"', exact: true })).not.toBeVisible();
  expect(await (await page.request.get(`/api/v1/tasks/${task.id}`)).json()).toMatchObject({ projectId: other.id, sectionId: null });
  await page.getByRole('button', { name: 'Back to projects', exact: true }).click();
  await page.getByRole('button', { name: 'Open Destination project', exact: true }).click();
  await page.getByRole('button', { name: 'Board', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Unsectioned section', exact: true }).getByRole('button', { name: 'Edit "Board task"', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Project settings', exact: true }).click();
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Archive project', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'This project is archived' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add section', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Rename section', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Destination for "Board task"', { exact: true })).toBeDisabled();
  await expect(page.locator(`[data-task-id="${task.id}"]`)).toHaveAttribute('draggable', 'false');
  await expect(page.getByRole('button', { name: 'Edit "Board task"', exact: true })).toBeEnabled();
});
