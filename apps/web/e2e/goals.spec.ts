import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

const origin = { Origin: 'http://localhost:3100' };
const headers = () => ({ ...origin, 'Idempotency-Key': randomUUID() });
async function fixture(page: Page) {
  const registration = await page.request.post('/api/v1/auth/register', {
    headers: { ...origin, 'X-Forwarded-For': `198.51.100.${100 + Math.floor(Math.random() * 100)}` },
    data: { email: `goals-${randomUUID()}@test.local`, password: 'goal-test-password-123', timeZone: 'UTC' },
  });
  expect(registration.status()).toBe(200);
  const { workspaceId } = await registration.json();
  return { workspaceId };
}
async function createGoal(page: Page, workspaceId: string, title = 'Learn Python') {
  const response = await page.request.post('/api/v1/goals', { headers: headers(), data: { workspaceId, title } });
  expect(response.status()).toBe(200);
  return await response.json() as { id: string; version: number; identifier: string };
}

test('goal, sub-goal, milestone and real task completion form a connected workflow', async ({ page }) => {
  const { workspaceId } = await fixture(page);
  const created = await page.request.post('/api/v1/tasks', { headers: headers(), data: { workspaceId, title: 'Watch Python lesson' } });
  expect(created.status()).toBe(200); const task = await created.json();
  await page.goto('/goals');
  await expect(page.getByRole('heading', { name: 'Goal Center' })).toBeVisible();
  const form = page.getByRole('form', { name: 'New goal', exact: true });
  await form.getByLabel('Goal title').fill('Learn Python');
  await form.getByLabel('Area of life').fill('Learning');
  await form.getByRole('button', { name: 'Create goal' }).click();
  await page.getByRole('link', { name: 'Learn Python', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Learn Python', exact: true })).toBeVisible();
  await expect(page.getByText('Not measured', { exact: false }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Add sub-goal', exact: true }).click();
  const subForm = page.getByRole('form', { name: 'New sub-goal' });
  await subForm.getByLabel('Goal title').fill('Complete course');
  await subForm.getByRole('button', { name: 'Create goal' }).click();
  await page.getByRole('link', { name: 'G2 · Complete course', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Complete course', exact: true })).toBeVisible();
  const milestoneForm = page.getByRole('form', { name: 'New milestone', exact: true });
  await milestoneForm.getByLabel('Milestone title').fill('Module 1');
  await milestoneForm.getByLabel('Milestone date and time').fill('2026-12-01T18:00');
  await milestoneForm.getByRole('button', { name: 'Add milestone', exact: true }).click();
  const milestone = page.getByRole('article', { name: 'G2.M1 Module 1', exact: true });
  await milestone.getByLabel('Find tasks to link').fill('Python lesson');
  await milestone.getByRole('button', { name: 'Search tasks' }).click();
  await milestone.getByRole('button', { name: 'Link Watch Python lesson', exact: true }).click();
  await expect(milestone.getByRole('button', { name: 'Watch Python lesson', exact: true })).toBeVisible();
  expect((await page.request.post(`/api/v1/tasks/${task.id}/complete`, { headers: headers(), data: { version: task.version } })).status()).toBe(200);
  await page.getByRole('button', { name: 'Refresh goal', exact: true }).click();
  await expect(milestone.getByText('100% · 1 of 1 work items complete', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Parent: Learn Python' }).click();
  await expect(page.getByRole('heading', { name: 'Learn Python', exact: true })).toBeVisible();
  await expect(page.getByText('100% · 1 of 1 work items complete', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('100% · 1 of 1 work items complete', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('goal-mobile.png'), fullPage: true });
});

test('milestone editor retains concurrent fields across conflict recovery and later edits', async ({ page }) => {
  const { workspaceId } = await fixture(page), goal = await createGoal(page, workspaceId);
  const response = await page.request.post(`/api/v1/goals/${goal.id}/milestones`, { headers: headers(), data: { title: 'First milestone' } });
  expect(response.status()).toBe(200); const milestone = await response.json();
  await page.goto(`/goals/${goal.id}`);
  await page.locator('summary').filter({ hasText: /^Edit milestone$/ }).click();
  const form = page.getByRole('form', { name: 'Edit G1.M1', exact: true });
  await form.getByLabel('Milestone title').fill('My milestone draft');
  expect((await page.request.patch(`/api/v1/milestones/${milestone.id}`, { headers: headers(), data: { version: 1, description: 'Saved elsewhere', dueAt: '2026-12-01T18:00:00Z' } })).status()).toBe(200);
  await form.getByRole('button', { name: 'Save milestone', exact: true }).click();
  await form.getByRole('button', { name: 'Review latest milestone' }).click();
  await form.getByRole('button', { name: 'Use latest version and keep draft' }).click();
  await form.getByRole('button', { name: 'Save milestone', exact: true }).click();
  await expect(form.getByLabel('Description')).toHaveValue('Saved elsewhere');
  await expect(form.getByLabel('Milestone date and time')).toHaveValue('2026-12-01T18:00');
  await form.getByLabel('Milestone title').fill('Second edit');
  await form.getByRole('button', { name: 'Save milestone', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'G1.M1 · Second edit', exact: true })).toBeVisible();
  const detail = await (await page.request.get(`/api/v1/goals/${goal.id}`)).json();
  expect(detail.milestones[0]).toMatchObject({ title: 'Second edit', description: 'Saved elsewhere', dueAt: '2026-12-01T18:00:00.000Z' });
});

test('HTTP commands validate inputs, tenant boundaries, concurrency and replay identity', async ({ page, playwright }) => {
  const { workspaceId } = await fixture(page);
  const goal = await createGoal(page, workspaceId);
  expect((await page.request.get('/api/v1/goals/invalid')).status()).toBe(400);
  for (const data of [{ title: 'No version' }, { version: 1, identifier: 'G999' }, { version: 1, title: ' ' }]) {
    expect((await page.request.patch(`/api/v1/goals/${goal.id}`, { headers: headers(), data })).status()).toBe(400);
  }
  const url = `/api/v1/goals/${goal.id}/status`, identity = headers(), data = { version: 1, status: 'COMPLETED' };
  expect((await page.request.post(url, { headers: origin, data })).status()).toBe(400);
  const first = await page.request.post(url, { headers: identity, data }); expect(first.status()).toBe(200);
  const replay = await page.request.post(url, { headers: identity, data });
  expect(await replay.json()).toEqual(await first.json()); expect(replay.headers()['idempotent-replay']).toBe('true');
  expect((await page.request.post(url, { headers: headers(), data: { version: 1, status: 'ARCHIVED' } })).status()).toBe(409);
  const other = await playwright.request.newContext({ baseURL: 'http://localhost:3100' });
  try {
    expect((await other.get(`/api/v1/goals/${goal.id}`)).status()).toBe(401);
    expect((await other.post('/api/v1/auth/register', { headers: { ...origin, 'X-Forwarded-For': '198.51.100.211' }, data: { email: `foreign-goal-${randomUUID()}@test.local`, password: 'goal-test-password-123', timeZone: 'UTC' } })).status()).toBe(200);
    expect((await other.get(`/api/v1/goals/${goal.id}`)).status()).toBe(404);
    expect((await other.patch(`/api/v1/goals/${goal.id}`, { headers: headers(), data: { version: 2, title: 'Stolen' } })).status()).toBe(404);
    expect((await other.post(`/api/v1/goals/${goal.id}/milestones`, { headers: headers(), data: { title: 'Stolen' } })).status()).toBe(404);
    expect((await other.post('/api/v1/goals', { headers: headers(), data: { workspaceId, title: 'Wrong workspace' } })).status()).toBe(403);
  } finally { await other.dispose(); }
});

test('goal editor preserves a conflicting draft and supports keyboard and accessibility checks', async ({ page }) => {
  const { default: AxeBuilder } = await import('@axe-core/playwright');
  const { workspaceId } = await fixture(page), goal = await createGoal(page, workspaceId);
  await page.goto(`/goals/${goal.id}`);
  const edit = page.getByRole('button', { name: 'Edit goal', exact: true }); await edit.focus(); await edit.press('Enter');
  const form = page.getByRole('form', { name: 'Edit goal', exact: true });
  await form.getByLabel('Goal title').fill('My preserved draft');
  expect((await page.request.patch(`/api/v1/goals/${goal.id}`, { headers: headers(), data: { version: 1, category: 'Changed elsewhere' } })).status()).toBe(200);
  await form.getByRole('button', { name: 'Save goal' }).click();
  await expect(form.getByLabel('Goal title')).toHaveValue('My preserved draft');
  await form.getByRole('button', { name: 'Review latest goal' }).click();
  await expect(form.getByText('Changed elsewhere', { exact: false })).toBeVisible();
  await form.getByRole('button', { name: 'Use latest version and keep my draft' }).click();
  await form.getByRole('button', { name: 'Save goal' }).click();
  await expect(page.getByRole('heading', { name: 'My preserved draft', exact: true })).toBeVisible();
  const detail = await (await page.request.get(`/api/v1/goals/${goal.id}`)).json();
  expect(detail.goal.category).toBe('Changed elsewhere');
  expect((await new AxeBuilder({ page }).include('.goals-view').withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([]);
});

test('lost create response retries with the same key and does not duplicate a goal', async ({ page }) => {
  await fixture(page);
  let lost = false;
  await page.route('**/api/v1/goals', async (route) => {
    if (route.request().method() === 'POST' && !lost) { lost = true; await route.fetch(); await route.abort('failed'); }
    else await route.continue();
  });
  await page.goto('/goals'); const form = page.getByRole('form', { name: 'New goal', exact: true });
  await form.getByLabel('Goal title').fill('One saved goal');
  await form.getByRole('button', { name: 'Create goal' }).click();
  await expect(form.getByRole('alert')).toBeVisible();
  await expect(form.getByLabel('Goal title')).toHaveValue('One saved goal');
  await form.getByRole('button', { name: 'Create goal' }).click();
  await expect(page.getByRole('link', { name: 'One saved goal', exact: true })).toHaveCount(1);
  expect((await (await page.request.get('/api/v1/goals')).json()).data).toHaveLength(1);
});
