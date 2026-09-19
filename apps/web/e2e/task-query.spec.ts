import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
const origin = { Origin: 'http://localhost:3100' };
const headers = () => ({ ...origin, 'Idempotency-Key': randomUUID() });
async function fixture(page: Page) {
 const result = await page.request.post('/api/v1/auth/register', { headers: { ...origin, 'X-Forwarded-For': '198.51.100.134' }, data: { email: `task-query-${randomUUID()}@test.local`, password: 'task-query-password-123', timeZone: 'UTC' } });
 expect(result.status()).toBe(200); const { workspaceId } = await result.json();
 const create = async (title: string, extra = {}) => {
  const r = await page.request.post('/api/v1/tasks', { headers: headers(), data: { workspaceId, title, ...extra } });
  expect(r.status()).toBe(200); return r.json();
 };
 return { workspaceId, create };
}
const rows = (page: Page) => page.locator('[data-task-id]');
const apply = (page: Page) => page.getByRole('button', { name: 'Apply filters', exact: true }).click();
test('workspace task browser combines filters, resets, and supports keyboard and accessible controls', async ({ page }) => {
 const { workspaceId, create } = await fixture(page);
 const project = await (await page.request.post('/api/v1/projects', { headers: headers(), data: { workspaceId, name: 'Query project' } })).json();
 const tag = await (await page.request.post('/api/v1/tags', { headers: headers(), data: { workspaceId, name: 'selected' } })).json();
 await create('Matching task', { description: 'needle', projectId: project.id, tagIds: [tag.id], priority: 'HIGH', dueAt: '2026-09-08T12:00:00Z' });
 await create('Other task', { priority: 'LOW' }); await create('No tag', { description: 'needle', projectId: project.id, priority: 'HIGH', dueAt: '2026-09-08T12:00:00Z' });
 const done = await create('Completed result'); expect((await page.request.post(`/api/v1/tasks/${done.id}/complete`, { headers: headers(), data: { version: 1 } })).status()).toBe(200);
 await page.goto('/inbox'); await page.getByRole('link', { name: 'Browse tasks', exact: true }).click();
 await expect(rows(page)).toHaveCount(3);
 await page.getByLabel('Search words', { exact: true }).fill('needle');
 await page.getByLabel('Project', { exact: true }).selectOption(project.id);
 await page.getByLabel('Tag', { exact: true }).selectOption(tag.id);
 await page.getByLabel('Priority', { exact: true }).selectOption('HIGH');
 await page.getByLabel('Due from', { exact: true }).fill('2026-09-08'); await page.getByLabel('Due through', { exact: true }).fill('2026-09-08');
 await page.getByRole('button', { name: 'Apply filters', exact: true }).focus(); await page.keyboard.press('Enter');
 await expect(rows(page)).toHaveCount(1); await expect(rows(page)).toContainText('Matching task');
 const { default: AxeBuilder } = await import('@axe-core/playwright');
 expect((await new AxeBuilder({ page }).include('.task-browser').withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([]);
 await page.getByLabel('Search words', { exact: true }).fill('absentword'); await apply(page);
 await expect(page.getByText('No matching tasks', { exact: true })).toBeVisible();
 await page.getByRole('button', { name: 'Reset filters', exact: true }).click(); await expect(rows(page)).toHaveCount(3);
 await expect(page.getByLabel('Project', { exact: true })).toHaveValue(''); await expect(page.getByLabel('Due from', { exact: true })).toHaveValue('');
 await page.getByLabel('Status', { exact: true }).selectOption('COMPLETED'); await apply(page); await expect(rows(page)).toHaveCount(1); await expect(rows(page)).toContainText('Completed result');
 await page.getByRole('button', { name: 'Reset filters', exact: true }).click();
 await page.getByLabel('Due date', { exact: true }).selectOption('false'); await apply(page); await expect(rows(page)).toHaveCount(1); await expect(rows(page)).toContainText('Other task');
});
test('sorted continuation preserves rows on failure and filter changes discard pages and late responses', async ({ page }) => {
 const { create } = await fixture(page);
 for (let i = 0; i < 52; i++) await create(`Ordered ${String(i).padStart(2, '0')}`, { estimateMinutes: i, priority: i === 51 ? 'HIGH' : 'LOW' });
 await page.goto('/tasks'); await page.getByLabel('Sort by', { exact: true }).selectOption('estimateMinutes'); await page.getByLabel('Direction', { exact: true }).selectOption('asc'); await apply(page);
 await expect(rows(page)).toHaveCount(50); await expect(rows(page).first()).toContainText('Ordered 00'); await expect(rows(page).last()).toContainText('Ordered 49');
 let failed = false;
 await page.route('**/api/v1/tasks?**', (route) => {
  if (!failed && new URL(route.request().url()).searchParams.has('cursor')) { failed = true; return route.abort('failed'); } return route.continue();
 });
 await page.getByRole('button', { name: 'Load more tasks', exact: true }).click();
 await expect(page.getByRole('button', { name: 'Retry task loading', exact: true })).toBeVisible(); await expect(rows(page)).toHaveCount(50);
 await page.getByRole('button', { name: 'Retry task loading', exact: true }).click(); await expect(rows(page)).toHaveCount(52); await expect(rows(page).last()).toContainText('Ordered 51');
 await page.getByLabel('Priority', { exact: true }).selectOption('HIGH'); await apply(page); await expect(rows(page)).toHaveCount(1); await expect(rows(page)).toContainText('Ordered 51');
 await page.getByRole('button', { name: 'Reset filters', exact: true }).click(); await expect(rows(page)).toHaveCount(50);
 let release!: () => void; const wait = new Promise<void>((resolve) => { release = resolve; });
 let settled!: () => void; const finished = new Promise<void>((resolve) => { settled = resolve; });
 let started!: () => void; const pending = new Promise<void>((resolve) => { started = resolve; });
 await page.route('**/api/v1/tasks?**', async (route) => {
  if (!new URL(route.request().url()).searchParams.has('cursor')) return route.continue();
  const response = await route.fetch(); started(); await wait; await route.fulfill({ response }).catch(() => {}); settled();
 });
 await page.getByRole('button', { name: 'Load more tasks', exact: true }).click(); await pending;
 await page.getByLabel('Priority', { exact: true }).selectOption('HIGH'); await apply(page); await expect(rows(page)).toHaveCount(1);
 release(); await finished; await expect(rows(page)).toHaveCount(1); await expect(rows(page)).toContainText('Ordered 51');
});
test('initial load can retry; invalid date ranges never replace applied results', async ({ page }) => {
 const { create } = await fixture(page); await create('Retained result');
 let failed = false;
 await page.route('**/api/v1/tasks?**', (route) => { if (!failed) { failed = true; return route.abort('failed'); } return route.continue(); });
 await page.goto('/tasks'); await expect(page.locator('.task-browser').getByRole('alert')).toContainText('Could not'); await page.getByRole('button', { name: 'Retry', exact: true }).click(); await expect(rows(page)).toHaveCount(1);
 await page.getByLabel('Due from', { exact: true }).fill('2026-09-09'); await page.getByLabel('Due through', { exact: true }).fill('2026-09-08'); await apply(page);
 await expect(page.locator('.task-browser').getByRole('alert')).toContainText('start'); await expect(rows(page)).toHaveCount(1);
});
test('HTTP query rejects invalid tokens and cross-tenant access without changing its envelope', async ({ page, playwright }) => {
 const { workspaceId, create } = await fixture(page); await create('A'); await create('B');
 const base = `/api/v1/tasks?workspaceId=${workspaceId}`;
 const first = await page.request.get(`${base}&sortBy=priority&sortOrder=desc&limit=1`); expect(first.status()).toBe(200); expect(first.headers()['cache-control']).toContain('no-store'); expect(first.headers()['x-request-id']).toBeTruthy();
 const body = await first.json(); expect(body.data).toHaveLength(1); expect(body.pagination.has_more).toBe(true);
 const cursor = encodeURIComponent(body.pagination.next_cursor);
 expect((await page.request.get(`${base}&sortBy=priority&sortOrder=desc&limit=2&cursor=${cursor}`)).status()).toBe(200);
 for (const query of ['sortBy=bogus', 'sortOrder=bogus', 'hasDueDate=maybe', 'priority=URGENT', 'cursor=bad', `sortBy=priority&sortOrder=asc&cursor=${cursor}`, 'hasDueDate=false&dueBefore=2026-09-08T00:00:00Z']) expect((await page.request.get(`${base}&${query}`)).status()).toBe(400);
 const other = await playwright.request.newContext({ baseURL: 'http://localhost:3100' });
 try {
  expect((await other.get(base)).status()).toBe(401);
  expect((await other.post('/api/v1/auth/register', { headers: { ...origin, 'X-Forwarded-For': '198.51.100.135' }, data: { email: `foreign-query-${randomUUID()}@test.local`, password: 'task-query-password-123', timeZone: 'UTC' } })).status()).toBe(200);
  expect((await other.get(`${base}&sortBy=priority&cursor=${cursor}`)).status()).toBe(403);
 } finally { await other.dispose(); }
});
test.describe('browser-local calendar bounds', () => {
 test.use({ timezoneId: 'Asia/Kolkata' });
 test('a local due-day includes both edges and excludes the following day', async ({ page }) => {
  const { create } = await fixture(page);
  await create('Day start', { dueAt: '2026-09-07T18:30:00Z' });
  await create('Day end', { dueAt: '2026-09-08T18:29:59.999Z' });
  await create('Next day', { dueAt: '2026-09-08T18:30:00Z' });
  await page.goto('/tasks'); await expect(rows(page)).toHaveCount(3);
  await page.getByLabel('Due from', { exact: true }).fill('2026-09-08'); await page.getByLabel('Due through', { exact: true }).fill('2026-09-08');
  const request = page.waitForRequest((r) => r.url().includes('/api/v1/tasks?') && new URL(r.url()).searchParams.has('dueBefore'));
  await apply(page); const params = new URL((await request).url()).searchParams;
  expect(params.get('dueAfter')).toBe('2026-09-07T18:30:00.000Z'); expect(params.get('dueBefore')).toBe('2026-09-08T18:29:59.999999Z');
  await expect(rows(page)).toHaveCount(2); await expect(page.getByRole('button', { name: 'Edit "Next day"', exact: true })).not.toBeVisible();
 });
});
