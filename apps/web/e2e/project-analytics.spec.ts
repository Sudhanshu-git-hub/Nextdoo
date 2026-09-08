import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
const origin = { Origin: 'http://localhost:3100' };
const headers = () => ({ ...origin, 'Idempotency-Key': randomUUID() });
const day = '2026-09-08';
async function fixture(page: Page) {
 const registered = await page.request.post('/api/v1/auth/register', { headers: { ...origin, 'X-Forwarded-For': '198.51.100.104' }, data: { email: `project-review-${randomUUID()}@test.local`, password: 'project-review-test-password-123', timeZone: 'Asia/Kolkata' } });
 expect(registered.status()).toBe(200); const { workspaceId } = await registered.json();
 const project = await (await page.request.post('/api/v1/projects', { headers: headers(), data: { workspaceId, name: 'Report work' } })).json();
 const create = async (dueAt: string | null, estimateMinutes?: number) => {
  const response = await page.request.post('/api/v1/tasks', { headers: headers(), data: { workspaceId, projectId: project.id, title: 'Measured task', dueAt, estimateMinutes } });
  expect(response.status()).toBe(200); return response.json();
 };
 const completed = await create(`${day}T12:00:00Z`, 30);
 expect((await page.request.post(`/api/v1/tasks/${completed.id}/complete`, { headers: headers(), data: { version: completed.version, completedAt: `${day}T11:00:00Z` } })).status()).toBe(200);
 await create(`${day}T15:00:00Z`);
 await create('2026-09-02T00:00:00Z');
 await create(null);
 return { workspaceId, project };
}
async function open(page: Page) {
 await page.goto('/projects'); await page.getByRole('button', { name: 'Open Report work', exact: true }).click();
 const trigger = page.getByRole('button', { name: 'Project analytics', exact: true }); await trigger.focus(); await trigger.press('Enter');
 return page.getByRole('region', { name: 'Project execution analytics', exact: true });
}
test('project reports display real scoped metrics, explicit UTC periods and accessible empty states', async ({ page }) => {
 await fixture(page); const report = await open(page);
 await report.getByLabel('Report date', { exact: true }).fill(day);
 await report.getByLabel('Reporting period', { exact: true }).selectOption('day');
 await report.getByRole('button', { name: 'Update report', exact: true }).click();
 await expect(report.getByTestId('plannedCount')).toHaveText('2');
 await expect(report.getByTestId('completionRate')).toHaveText('50%');
 await expect(report.getByTestId('onTimeRate')).toHaveText('100%');
 await expect(report.getByTestId('averageScore')).toHaveText('100');
 await expect(report.getByTestId('estimateVariancePct')).toHaveText('Unmeasured');
 await expect(report).toContainText('UTC');
 await expect(report).toContainText('current project');
 const { default: AxeBuilder } = await import('@axe-core/playwright');
 expect((await new AxeBuilder({ page }).include('.project-analytics').withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([]);
 await report.getByLabel('Reporting period', { exact: true }).selectOption('week');
 await report.getByRole('button', { name: 'Update report', exact: true }).click();
 await expect(report.getByTestId('plannedCount')).toHaveText('3');
 await report.getByLabel('Report date', { exact: true }).fill('2025-01-01');
 await report.getByRole('button', { name: 'Update report', exact: true }).click();
 await expect(report).toContainText('No tasks due in this window');
 await expect(report.getByTestId('averageScore')).not.toBeVisible();
 await page.getByRole('button', { name: 'Board', exact: true }).click();
 await expect(page.locator('.project-board')).toBeVisible();
 await page.getByRole('button', { name: 'List', exact: true }).click();
 await expect(page.getByRole('button', { name: 'Edit "Measured task"', exact: true })).toHaveCount(3);
});
test('project analytics validates dates and IDs and enforces HTTP tenant boundaries including archived projects', async ({ page, playwright }) => {
 const { project } = await fixture(page);
 const url = `/api/v1/projects/${project.id}/analytics`;
 const response = await page.request.get(`${url}?period=day&date=${day}`);
 expect(response.status()).toBe(200); expect(response.headers()['x-request-id']).toBeTruthy(); expect(response.headers()['cache-control']).toContain('no-store');
 expect(await response.json()).toMatchObject({ plannedCount: 2, completedCount: 1, projectId: project.id, timeZone: 'UTC' });
 for (const query of ['date=2026-02-30', 'date=0000-01-01', 'period=week&date=0001-01-01', 'date=not-a-date', 'period=month', `workspaceId=${randomUUID()}`]) expect((await page.request.get(`${url}?${query}`)).status()).toBe(400);
 expect((await page.request.get('/api/v1/projects/bad-id/analytics')).status()).toBe(400);
 const other = await playwright.request.newContext({ baseURL: 'http://localhost:3100' });
 try {
  expect((await other.get(url)).status()).toBe(401);
  expect((await other.post('/api/v1/auth/register', { headers: { ...origin, 'X-Forwarded-For': '198.51.100.105' }, data: { email: `foreign-review-${randomUUID()}@test.local`, password: 'project-review-test-password-123', timeZone: 'UTC' } })).status()).toBe(200);
  expect((await other.get(url)).status()).toBe(404);
 } finally { await other.dispose(); }
 expect((await page.request.post(`/api/v1/projects/${project.id}/archive`, { headers: headers(), data: { version: project.version } })).status()).toBe(200);
 expect((await page.request.get(`${url}?period=day&date=${day}`)).status()).toBe(200);
 await page.goto('/projects'); await page.getByRole('button', { name: /Archived projects/ }).click();
 await page.getByRole('button', { name: 'Open Report work', exact: true }).click();
 await page.getByRole('button', { name: 'Project analytics', exact: true }).click();
 await expect(page.getByRole('region', { name: 'Project execution analytics', exact: true })).toBeVisible();
});
test('failed report requests do not display old metrics and an explicit retry recovers', async ({ page }) => {
 await fixture(page); const report = await open(page);
 await report.getByLabel('Report date', { exact: true }).fill(day);
 await report.getByRole('button', { name: 'Update report', exact: true }).click();
 await expect(report.getByTestId('plannedCount')).toHaveText('3');
 let failed = false;
 await page.route('**/api/v1/projects/*/analytics?**', (route) => {
  if (!failed) { failed = true; return route.abort('failed'); } return route.continue();
 });
 await report.getByLabel('Reporting period', { exact: true }).selectOption('day');
 await report.getByRole('button', { name: 'Update report', exact: true }).click();
 await expect(report.getByRole('alert')).toContainText('Could not load');
 await expect(report.getByTestId('plannedCount')).not.toBeVisible();
 await report.getByRole('button', { name: 'Retry report', exact: true }).click();
 await expect(report.getByTestId('plannedCount')).toHaveText('2');
});

test('a delayed older report cannot replace a newer period selection', async ({ page }) => {
 await fixture(page); const report = await open(page);
 await expect(report.getByTestId('plannedCount')).toBeVisible();
 let announce!: () => void, release!: () => void;
 const captured = new Promise<void>((resolve) => { announce = resolve; });
 const proceed = new Promise<void>((resolve) => { release = resolve; });
 let held = false;
 await page.route('**/api/v1/projects/*/analytics?**', async (route) => {
   if (!held && new URL(route.request().url()).searchParams.get('period') === 'day') {
     held = true; const response = await route.fetch(); announce(); await proceed;
     await route.fulfill({ response }).catch(() => {}); return;
   }
   await route.continue();
 });
 try {
   await report.getByLabel('Report date', { exact: true }).fill(day);
   await report.getByLabel('Reporting period', { exact: true }).selectOption('day');
   await report.getByRole('button', { name: 'Update report', exact: true }).click();
   await captured;
   const canceled = page.waitForEvent('requestfailed', { predicate: (request) => request.url().includes('/analytics?') && new URL(request.url()).searchParams.get('period') === 'day' });
   await report.getByLabel('Reporting period', { exact: true }).selectOption('week');
   await report.getByRole('button', { name: 'Update report', exact: true }).click();
   await expect(report.getByTestId('plannedCount')).toHaveText('3');
   await canceled;
   release();
   await expect(report.getByTestId('plannedCount')).toHaveText('3');
   await expect(report.getByRole('status')).toContainText('2026-09-02 through 2026-09-08');
 } finally { release(); }
});
