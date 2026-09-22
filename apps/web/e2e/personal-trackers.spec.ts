import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { createDb, ingestPersonalTrackerEvents, schedulePersonalTrackerReports } from '@nextdoo/db';
import { createTrackerDefinition } from '@nextdoo/core';
const connection = createDb(process.env.DATABASE_URL!, { max: 2 });
test.afterAll(() => connection.close());
const origin = { Origin: 'http://localhost:3100' }, headers = () => ({ ...origin, 'Idempotency-Key': randomUUID() });
async function fixture(page: Page) {
  const r = await page.request.post('/api/v1/auth/register', { headers: { ...origin, 'X-Forwarded-For': `198.51.100.${100 + Math.floor(Math.random() * 100)}` }, data: { email: `personal-tracker-${randomUUID()}@test.local`, password: 'tracker-test-password-123', timeZone: 'UTC' } });
  expect(r.status()).toBe(200); return await r.json() as { workspaceId: string };
}
async function trackerFor(page: Page, workspaceId: string) {
  const response = await page.request.post('/api/v1/trackers', { headers: headers(), data: { workspaceId, name: 'My tracker', startDate: '2026-01-01', timeZone: 'UTC', definition: createTrackerDefinition() } });
  expect(response.status()).toBe(200); return await response.json();
}

test('template preview creates an independent table, manual rules score records, reports use both denominators', async ({ page }) => {
  await fixture(page); await page.goto('/trackers'); await page.getByRole('button', { name: 'Templates', exact: true }).click();
  await page.getByRole('button', { name: 'Preview Exercise', exact: true }).click();
  const preview = page.getByRole('article', { name: 'Template preview' });
  const download = page.waitForEvent('download'); await preview.getByRole('button', { name: 'Download template' }).click(); expect((await download).suggestedFilename()).toBe('exercise-tracker-template.json');
  await preview.getByRole('button', { name: 'Use Exercise', exact: true }).click();
  const form = page.getByRole('form', { name: 'New tracker', exact: true });
  await form.getByLabel('Tracker name', { exact: true }).fill('My exercise table'); await form.getByLabel('Tracking start date').fill('2026-01-01');
  await form.locator('summary').filter({ hasText: /^Column headers$/ }).click(); await form.getByLabel('date column name', { exact: true }).fill('Day');
  await form.getByRole('button', { name: 'Create tracker', exact: true }).click();
  await page.getByRole('link', { name: 'My exercise table', exact: true }).click(); await expect(page.getByRole('heading', { name: 'My exercise table', exact: true })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Day', exact: true })).toBeVisible();
  for (const [day, value] of [['2026-01-01', '90'], ['2026-01-03', '60']]) {
    await page.getByRole('button', { name: 'New Entry', exact: true }).click();
    const entry = page.getByRole('form', { name: 'New tracking record' }); await entry.getByLabel('Tracking date').fill(day!); await entry.getByLabel('Exercise', { exact: true }).fill(value!);
    await entry.getByLabel('Tracking notes').fill('An actual observation'); await entry.getByRole('button', { name: 'Add record', exact: true }).click();
    await expect(entry).toHaveCount(0);
  }
  await page.getByLabel('Report through').fill('2026-01-10'); await page.getByRole('button', { name: 'Apply range' }).click();
  await page.getByRole('button', { name: 'Report', exact: true }).click();
  const report = page.getByRole('region', { name: 'Tracker report' });
  await expect(report.getByText('Total stars: 8. Average: 0.80 = total ÷ 10 calendar days. Relative: 4.00 = total ÷ 2 tracked days.', { exact: true })).toBeVisible();
  await expect(page.getByRole('table').getByRole('row')).toHaveCount(3);
  expect((await (await page.request.get('/api/v1/trackers/templates')).json())[0].definition.columns[0].label).toBe('Date');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: test.info().outputPath('tracker-mobile.png'), fullPage: true });
  expect(await page.evaluate(() => [...document.querySelectorAll('main > *, .tracker-view > *')].filter((el) => el.getBoundingClientRect().right > innerWidth).map((el) => ({ tag: el.tagName, class: el.className, width: el.getBoundingClientRect().width })))).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('configured linked task completion is consumed durably and appears automatically in the table', async ({ page }) => {
  const { workspaceId } = await fixture(page);
  const created = await page.request.post('/api/v1/tasks', { headers: headers(), data: { workspaceId, title: 'Gym workout' } }); expect(created.status()).toBe(200); const task = await created.json();
  await page.goto('/trackers'); await page.getByRole('button', { name: 'New Tracker', exact: true }).click();
  const form = page.getByRole('form', { name: 'New tracker', exact: true }); await form.getByLabel('Tracker name', { exact: true }).fill('Automatic exercise');
  await form.locator('summary').filter({ hasText: /^Input fields$/ }).click(); await form.getByLabel('Field 1 source').selectOption('task_completed');
  await form.getByRole('button', { name: 'Create tracker', exact: true }).click(); await page.getByRole('link', { name: 'Automatic exercise', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Automatic exercise', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Linked Tasks', exact: true }).click();
  await page.getByLabel('Find tasks to link').fill('Gym workout'); await page.getByRole('button', { name: 'Search tasks', exact: true }).click();
  await page.getByRole('button', { name: 'Link Gym workout', exact: true }).click(); await expect(page.getByRole('button', { name: 'Unlink Gym workout', exact: true })).toBeVisible();
  expect((await page.request.post(`/api/v1/tasks/${task.id}/complete`, { headers: headers(), data: { version: task.version } })).status()).toBe(200);
  expect(await ingestPersonalTrackerEvents(connection.db, workspaceId)).toMatchObject({ processed: 1 });
  await expect(page.getByRole('table').getByLabel('5 out of 5 stars')).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole('table').getByRole('button', { name: 'Gym workout', exact: true })).toBeVisible();
  expect(await ingestPersonalTrackerEvents(connection.db, workspaceId)).toMatchObject({ processed: 0 });
  await page.getByRole('button', { name: 'Refresh tracker' }).click(); await expect(page.getByRole('table').getByRole('row')).toHaveCount(2);
});

test('HTTP contracts enforce isolation, typed inputs, rule validation and request replay', async ({ page, playwright }) => {
  const { workspaceId } = await fixture(page), tracker = await trackerFor(page, workspaceId);
  const identity = headers(), body = { day: '2026-01-01', values: { input: 90 }, notes: 'Saved once' }, url = `/api/v1/trackers/${tracker.id}/entries`;
  const first = await page.request.post(url, { headers: identity, data: body }); expect(first.status()).toBe(200);
  const replay = await page.request.post(url, { headers: identity, data: body }); expect(await replay.json()).toEqual(await first.json());
  expect(replay.headers()['idempotent-replay']).toBe('true');
  for (const data of [{ day: '2026-01-02', values: { input: 'wrong type' } }, { day: '2026-01-02', values: {}, stars: 5 }, { day: '2026-02-30', values: { input: 90 } }]) expect((await page.request.post(url, { headers: headers(), data })).status()).toBe(400);
  const bad = structuredClone(tracker.definition); bad.rules[0].statusId = 'missing';
  expect((await page.request.patch(`/api/v1/trackers/${tracker.id}`, { headers: headers(), data: { version: 1, definition: bad } })).status()).toBe(400);
  expect((await page.request.get('/api/v1/trackers/not-a-uuid')).status()).toBe(400);
  const other = await playwright.request.newContext({ baseURL: 'http://localhost:3100' });
  try {
    expect((await other.get(`/api/v1/trackers/${tracker.id}`)).status()).toBe(401);
    expect((await other.post('/api/v1/auth/register', { headers: { ...origin, 'X-Forwarded-For': '198.51.100.219' }, data: { email: `other-tracker-${randomUUID()}@test.local`, password: 'tracker-test-password-123' } })).status()).toBe(200);
    expect((await other.get(`/api/v1/trackers/${tracker.id}`)).status()).toBe(404);
    expect((await other.post(url, { headers: headers(), data: body })).status()).toBe(404);
  } finally { await other.dispose(); }
});

test('conflicting settings keep the draft and preserve unrelated edits; table and editor are accessible', async ({ page }) => {
  const { workspaceId } = await fixture(page), tracker = await trackerFor(page, workspaceId);
  await page.goto(`/trackers/${tracker.id}`); await page.getByRole('button', { name: 'Conditions, Scoring & Settings' }).click();
  const form = page.getByRole('form', { name: 'Tracker settings', exact: true }); await form.getByLabel('Tracker name', { exact: true }).fill('Preserved draft');
  expect((await page.request.patch(`/api/v1/trackers/${tracker.id}`, { headers: headers(), data: { version: 1, description: 'Changed elsewhere' } })).status()).toBe(200);
  await form.getByRole('button', { name: 'Save settings' }).click(); await expect(form.getByLabel('Tracker name', { exact: true })).toHaveValue('Preserved draft');
  await form.getByRole('button', { name: 'Review latest settings' }).click(); await expect(form.getByText('Changed elsewhere', { exact: false })).toBeVisible();
  await form.getByRole('button', { name: 'Use latest version and keep draft' }).click(); await form.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByRole('heading', { name: 'Preserved draft', exact: true })).toBeVisible(); expect((await (await page.request.get(`/api/v1/trackers/${tracker.id}`)).json()).tracker.description).toBe('Changed elsewhere');
  await page.getByRole('button', { name: 'Conditions, Scoring & Settings' }).click(); await form.locator('summary').filter({ hasText: /^Conditions$/ }).click();
  const { default: AxeBuilder } = await import('@axe-core/playwright'); expect((await new AxeBuilder({ page }).include('.tracker-view').withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([]);
});

test('monthly report settings show unavailable external delivery honestly', async ({ page }) => {
  const { workspaceId } = await fixture(page), tracker = await trackerFor(page, workspaceId);
  await page.goto(`/trackers/${tracker.id}`); await page.getByRole('button', { name: 'Conditions, Scoring & Settings' }).click();
  const form = page.getByRole('form', { name: 'Tracker settings', exact: true }); await form.locator('summary').filter({ hasText: /^Monthly report delivery$/ }).click();
  await form.getByLabel('Enable monthly reports').check(); await form.getByLabel('Report channel').selectOption('TELEGRAM'); await form.getByLabel('Report delivery time').fill('00:00');
  await form.getByRole('button', { name: 'Save settings' }).click(); await expect(form).toHaveCount(0);
  const outcome = await schedulePersonalTrackerReports(connection.db, { smtpConfigured: false, authSecret: 'e2e-only-secret', mailFrom: 'test@nextdoo.local', appUrl: 'http://localhost:3100' }, new Date(), workspaceId); expect(outcome.blocked).toBe(1);
  await page.getByRole('button', { name: 'Refresh tracker' }).click(); await page.getByRole('button', { name: 'Report', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Tracker report' }).getByText('TELEGRAM · blocked · Provider unavailable', { exact: false })).toBeVisible();
});

test('lost creation response retries with its original identity and creates one tracker', async ({ page }) => {
  await fixture(page); let lost = false;
  await page.route('**/api/v1/trackers', async (route) => { if (route.request().method() === 'POST' && !lost) { lost = true; await route.fetch(); await route.abort('failed'); } else await route.continue(); });
  await page.goto('/trackers'); await page.getByRole('button', { name: 'New Tracker', exact: true }).click(); const form = page.getByRole('form', { name: 'New tracker', exact: true });
  await form.getByLabel('Tracker name', { exact: true }).fill('One tracker'); await form.getByRole('button', { name: 'Create tracker' }).click(); await expect(form.getByRole('alert')).toBeVisible();
  await form.getByRole('button', { name: 'Create tracker' }).click(); await expect(page.getByRole('link', { name: 'One tracker', exact: true })).toHaveCount(1);
  expect((await (await page.request.get('/api/v1/trackers')).json()).data).toHaveLength(1);
});

test('custom conditions and star mappings persist through record corrections and archive recovery', async ({ page }) => {
  const { workspaceId } = await fixture(page), tracker = await trackerFor(page, workspaceId);
  await page.goto(`/trackers/${tracker.id}`); await page.getByRole('button', { name: 'Conditions, Scoring & Settings' }).click();
  const settings = page.getByRole('form', { name: 'Tracker settings' });
  await settings.locator('summary').filter({ hasText: /^Statuses and star scores$/ }).click();
  await settings.getByLabel('Status 4 name', { exact: true }).fill('My target'); await settings.getByLabel('Status 4 stars', { exact: true }).selectOption('4');
  await settings.locator('summary').filter({ hasText: /^Conditions$/ }).click();
  await settings.getByLabel('Rule 1 condition 1 value', { exact: true }).fill('75');
  await settings.getByRole('button', { name: 'Save settings' }).click(); await expect(settings).toHaveCount(0);
  await page.getByRole('button', { name: 'New Entry', exact: true }).click();
  const entry = page.getByRole('form', { name: 'New tracking record' });
  await entry.getByLabel('Observation', { exact: true }).fill('80'); await entry.getByRole('button', { name: 'Add record' }).click();
  const table = page.getByRole('table'); await expect(table.getByLabel('4 out of 5 stars')).toBeVisible(); await expect(table.getByText('My target', { exact: true })).toBeVisible();
  await table.getByRole('button', { name: 'Edit record' }).click(); const edit = page.getByRole('form', { name: 'Edit tracking record' });
  await edit.getByLabel('Observation', { exact: true }).fill('30'); await edit.getByLabel('Tracking notes').fill('Corrected observation'); await edit.getByRole('button', { name: 'Save record' }).click();
  await expect(table.getByLabel('2 out of 5 stars')).toBeVisible(); await expect(table.getByText('Corrected observation')).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await table.getByRole('button', { name: 'Delete record' }).click(); await expect(table.getByRole('row')).toHaveCount(1);
  await page.getByLabel('Show deleted records').check(); await table.getByRole('button', { name: 'Restore record' }).click(); await expect(table.getByLabel('2 out of 5 stars')).toBeVisible();
  await page.getByRole('button', { name: 'Pause tracker' }).click(); await expect(page.getByRole('button', { name: 'New Entry', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Resume tracker' }).click(); await expect(page.getByRole('button', { name: 'New Entry', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Archive tracker' }).click(); await expect(page.getByRole('button', { name: 'Restore tracker' })).toBeVisible();
  await page.reload(); await page.getByRole('button', { name: 'Restore tracker' }).click(); await expect(page.getByRole('button', { name: 'Pause tracker' })).toBeVisible();
  await expect(table.getByText('Corrected observation')).toBeVisible();
});
