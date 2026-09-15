import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';

/**
 * M6 commercial-readiness (PRD §18.1, §7.10): the entitlement endpoint and
 * the authenticated JSON export path, exercised through the real HTTP layer
 * with a real browser session.
 *
 * Plan-boundary behavior (200/201 tasks, 3/4 projects, 30-day history,
 * retention windows, privacy scrubbing) is covered by
 * entitlements.export.integration.test.ts; async export generation, download
 * authorisation and idempotent replay by exports.spec.ts. This spec covers the
 * endpoints those suites do not: GET /api/v1/account/entitlements and
 * GET /api/v1/account/export.
 */

const origin = { Origin: 'http://localhost:3100' };

async function fixture(page: Page) {
  const email = `entitlements-${randomUUID()}@test.local`;
  const r = await page.request.post('/api/v1/auth/register', {
    headers: { ...origin, 'X-Forwarded-For': '198.51.100.207' },
    data: { email, password: 'entitlements-test-password-123', timeZone: 'UTC' },
  });
  expect(r.status()).toBe(200);
  const body = await r.json();
  const t = await page.request.post('/api/v1/tasks', {
    headers: { ...origin, 'Idempotency-Key': randomUUID() },
    data: { workspaceId: body.workspaceId, title: 'Entitlement browser task', dueAt: new Date().toISOString() },
  });
  expect(t.status()).toBe(200);
  return { email, workspaceId: body.workspaceId as string };
}

test('the entitlement endpoint is auth-gated and exposes server-configured limits', async ({ page, browser }) => {
  // Unauthenticated: a clean context without the session cookie.
  const anon = await browser.newContext();
  const denied = await anon.request.get('/api/v1/account/entitlements');
  expect(denied.status()).toBe(401);
  await anon.close();

  await fixture(page);
  const res = await page.request.get('/api/v1/account/entitlements');
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.plan).toBe('FREE');
  expect(body.limits).toMatchObject({
    activeTasks: 200,
    projects: 3,
    calendarConnections: 1,
    trackingHistoryDays: 30,
    exportsPerDay: 1,
    auditLogRetentionDays: 0,
  });
  expect(body.usage).toMatchObject({ activeTasks: 1, projects: 0, calendarConnections: 0 });
});

test('the authenticated JSON export is a complete, private snapshot of the account', async ({ page, browser }) => {
  const anon = await browser.newContext();
  const denied = await anon.request.get('/api/v1/account/export');
  expect(denied.status()).toBe(401);
  // A 401 must not leak export content — it is a problem document only.
  const deniedBody = await denied.text();
  expect(deniedBody).not.toContain('formatVersion');
  expect(deniedBody).not.toContain('tasks');
  await anon.close();

  const { email } = await fixture(page);
  const res = await page.request.get('/api/v1/account/export');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('application/json');
  expect(res.headers()['content-disposition'] ?? '').toContain('attachment');
  expect(res.headers()['cache-control']).toContain('no-store');

  const bundle = await res.json();
  expect(bundle.formatVersion).toBe(1);
  expect(bundle.account.email).toBe(email);
  expect(bundle.tasks.some((t: { title: string }) => t.title === 'Entitlement browser task')).toBe(true);
  // Credentials must never be part of the snapshot.
  const flat = JSON.stringify(bundle);
  expect(flat.toLowerCase().includes('passwordhash')).toBe(false);
  expect(flat.includes('entitlements-test-password-123')).toBe(false);
});

test('the free plan quota blocks a second export the same day through the API', async ({ page }) => {
  await fixture(page);

  const first = await page.request.post('/api/v1/exports', {
    headers: { ...origin, 'Idempotency-Key': randomUUID() },
    data: { format: 'json' },
  });
  expect(first.status()).toBe(200);

  const second = await page.request.post('/api/v1/exports', {
    headers: { ...origin, 'Idempotency-Key': randomUUID() },
    data: { format: 'csv' },
  });
  expect(second.status()).toBe(402);

  const list = await page.request.get('/api/v1/exports');
  expect(list.status()).toBe(200);
  const pageBody = await list.json();
  expect(pageBody.data).toHaveLength(1);
});

test('the settings screen shows the server-configured plan and live usage', async ({ page }) => {
  await fixture(page);
  await page.goto('/settings');
  await expect(page.getByRole('row', { name: 'Plan' })).toContainText('FREE');
  await expect(page.getByText('1 of 200')).toBeVisible();
  await expect(page.getByText('0 of 3')).toBeVisible();
});
