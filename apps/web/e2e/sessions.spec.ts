import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';

/**
 * Account & session management E2E (PRD §6.1, §11.2, §14.3).
 *
 * Real browsers, two independent device contexts. Revocation latency is
 * MEASURED, not assumed: a revoked session must fail its very next request,
 * well inside the PRD's 60-second bound.
 */

const origin = { Origin: 'http://localhost:3100' };
const headers = () => ({ ...origin, 'Idempotency-Key': randomUUID() });
const PASSWORD = 'session-e2e-password-123';

async function fixture(page: Page, prefix = 'sessions') {
  const email = `${prefix}-${randomUUID()}@test.local`;
  const r = await page.request.post('/api/v1/auth/register', {
    headers: { ...origin, 'X-Forwarded-For': '198.51.100.201' },
    data: { email, password: PASSWORD, timeZone: 'UTC' },
  });
  expect(r.status()).toBe(200);
  return { email };
}

/** Second browser device: sign in as the same user (creates a second session). */
async function secondDevice(pageB: Page, email: string) {
  const r = await pageB.request.post('/api/v1/auth/login', {
    headers: { ...origin, 'X-Forwarded-For': '198.51.100.202' },
    data: { email, password: PASSWORD },
  });
  expect(r.status()).toBe(200);
}

test('settings lists both devices; revoking one signs it out immediately (measured)', async ({ page, browser }) => {
  const { email } = await fixture(page);
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  try {
    await secondDevice(pageB, email);
    await pageB.goto('/settings');
    const cardB = pageB.getByTestId('sessions-card');
    await expect(cardB.getByText('This device')).toHaveCount(1);
    expect(await cardB.locator('li').count()).toBe(2);

    // Revoke the row that is NOT this device.
    const otherRow = cardB.locator('li').filter({ hasNot: pageB.getByText('This device') });
    pageB.once('dialog', (d) => d.accept());
    await otherRow.getByRole('button').click();
    await expect(cardB.getByRole('status')).toContainText('Session revoked.');
    expect(await cardB.locator('li').count()).toBe(1);

    // The revoked device's next request must 401 — measured.
    const t0 = Date.now();
    const dead = await page.request.get('/api/v1/me');
    const latencyMs = Date.now() - t0;
    console.log(`[e2e] individual revocation measured latency to effect: ${latencyMs}ms`);
    expect(dead.status()).toBe(401);
    expect(latencyMs).toBeLessThan(5_000); // PRD bound: 60_000ms.

    // The revoked browser is logged out on its next navigation.
    await page.goto('/today');
    expect(page.url()).toContain('/login');
    // The surviving device still works.
    expect((await pageB.request.get('/api/v1/me')).status()).toBe(200);
  } finally {
    await ctxB.close();
  }
});

test('revoking the current session signs that client out at once', async ({ page, browser }) => {
  const { email } = await fixture(page);
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  try {
    await secondDevice(pageB, email);
    await pageB.goto('/settings');
    const cardB = pageB.getByTestId('sessions-card');
    const currentRow = cardB.locator('li').filter({ has: pageB.getByText('This device') });
    pageB.once('dialog', (d) => d.accept());
    await currentRow.getByRole('button', { name: /Revoke & sign out/i }).click();
    await expect(pageB).toHaveURL(/\/login/);
    expect((await pageB.request.get('/api/v1/me')).status()).toBe(401);
  } finally {
    await ctxB.close();
  }
});

test('sign out everywhere revokes ALL sessions, including the caller’s (measured)', async ({ page, browser }) => {
  const { email } = await fixture(page);
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  try {
    await secondDevice(pageB, email);
    await pageB.goto('/settings');
    const cardB = pageB.getByTestId('sessions-card');
    expect(await cardB.locator('li').count()).toBe(2);

    pageB.once('dialog', (d) => d.accept());
    await cardB.getByRole('button', { name: 'Sign out everywhere', exact: true }).click();
    await expect(pageB).toHaveURL(/\/login/);

    const t0 = Date.now();
    const deadB = await pageB.request.get('/api/v1/me');
    const deadA = await page.request.get('/api/v1/me');
    const latencyMs = Date.now() - t0;
    console.log(`[e2e] sign-out-everywhere measured latency to effect: ${latencyMs}ms`);
    expect(deadB.status()).toBe(401); // the caller’s own session
    expect(deadA.status()).toBe(401); // the other device
    expect(latencyMs).toBeLessThan(5_000); // PRD bound: 60_000ms.
  } finally {
    await ctxB.close();
  }
});

test('profile editing saves name and time zone, persists, and rejects invalid values', async ({ page }) => {
  await fixture(page);
  await page.goto('/settings');
  const form = page.getByRole('form', { name: 'Profile' });

  await form.getByLabel('Display name', { exact: true }).fill('Session E2E');
  await form.getByLabel('Time zone', { exact: true }).fill('Asia/Kolkata');
  await form.getByRole('button', { name: 'Save profile', exact: true }).click();
  await expect(form.getByRole('status')).toContainText('Profile saved.');
  await page.reload();
  await expect(page.getByLabel('Display name', { exact: true })).toHaveValue('Session E2E');
  await expect(page.getByLabel('Time zone', { exact: true })).toHaveValue('Asia/Kolkata');

  const me = await (await page.request.get('/api/v1/me')).json();
  expect(me.name).toBe('Session E2E');
  expect(me.timeZone).toBe('Asia/Kolkata');
  expect(me.emailVerified).toBeUndefined(); // the profile view never leaks other state
  expect(Object.keys(me).sort()).toEqual(['createdAt', 'email', 'id', 'mfaEnabled', 'name', 'timeZone']);

  await page.getByLabel('Time zone', { exact: true }).fill('Not/AZone');
  await form.getByRole('button', { name: 'Save profile', exact: true }).click();
  await expect(form.getByRole('alert')).toContainText(/time zone/i);
});

test('HTTP contracts: authentication, ownership, strict fields, origin and idempotency', async ({ page, playwright }) => {
  await fixture(page);

  // Anonymous: everything is 401.
  const guest = await playwright.request.newContext({ baseURL: 'http://localhost:3100' });
  try {
    expect((await guest.get('/api/v1/me')).status()).toBe(401);
    expect((await guest.get('/api/v1/me/sessions')).status()).toBe(401);
    expect((await guest.delete(`/api/v1/me/sessions/${randomUUID()}`)).status()).toBe(401);
    expect((await guest.post('/api/v1/auth/logout-all', { headers: headers() })).status()).toBe(401);
    expect((await guest.patch('/api/v1/me', { headers: headers(), data: { name: 'Nope' } })).status()).toBe(401);

    // Cross-user isolation: a stranger cannot see or revoke this user's sessions.
    expect((await guest.post('/api/v1/auth/register', { headers: { ...origin, 'X-Forwarded-For': '198.51.100.203' }, data: { email: `outsider-${randomUUID()}@test.local`, password: PASSWORD, timeZone: 'UTC' } })).status()).toBe(200);
    const own = await (await page.request.get('/api/v1/me/sessions')).json();
    expect(Array.isArray(own)).toBe(true);
    expect(own.length).toBe(1);
    expect((await guest.get('/api/v1/me/sessions')).json()).not.toEqual(own);
    expect((await guest.delete(`/api/v1/me/sessions/${own[0].id}`, { headers: headers() })).status()).toBe(404);

    // Malformed id is a 400, not a 404.
    expect((await page.request.delete('/api/v1/me/sessions/not-a-uuid', { headers: headers() })).status()).toBe(400);

    // The session list never exposes token or IP material.
    for (const row of own) {
      expect(Object.keys(row).sort()).toEqual(['createdAt', 'current', 'deviceLabel', 'id', 'lastSeenAt']);
      expect(JSON.stringify(row)).not.toMatch(/token|hash|ip/i);
    }
  } finally {
    await guest.dispose();
  }

  // Strict field validation + origin + idempotency on PATCH /me.
  const base = { name: 'Contracted' };
  const key = headers();
  expect((await page.request.patch('/api/v1/me', { headers: { ...origin }, data: base })).status()).toBe(400); // no Idempotency-Key
  expect((await page.request.patch('/api/v1/me', { headers: headers(), data: {} })).status()).toBe(400); // empty patch
  expect((await page.request.patch('/api/v1/me', { headers: headers(), data: { timeZone: 'Nope/Nowhere' } })).status()).toBe(400);
  expect((await page.request.patch('/api/v1/me', { headers: { ...headers(), Origin: 'https://evil.test' }, data: base })).status()).toBe(403);

  const first = await page.request.patch('/api/v1/me', { headers: key, data: base });
  expect(first.status()).toBe(200);
  expect(await (await page.request.patch('/api/v1/me', { headers: key, data: base })).json()).toEqual(await first.json()); // replay
  expect((await page.request.patch('/api/v1/me', { headers: key, data: { name: 'Changed' } })).status()).toBe(409); // key reuse with new body
});

test('sessions area is accessible (axe) and works from the keyboard', async ({ page, browser }) => {
  const { email } = await fixture(page);
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  try {
    await secondDevice(pageB, email);
    await pageB.goto('/settings');
    const card = pageB.getByTestId('sessions-card');

    const { default: AxeBuilder } = await import('@axe-core/playwright');
    const results = await new AxeBuilder({ page: pageB }).include('[data-testid="sessions-card"]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
    expect(results.violations).toEqual([]);

    // Keyboard: focus the other device’s revoke button and press Enter.
    const otherRow = card.locator('li').filter({ hasNot: pageB.getByText('This device') });
    await otherRow.getByRole('button').focus();
    expect(await pageB.evaluate(() => document.activeElement?.tagName)).toBe('BUTTON');
    pageB.once('dialog', (d) => d.accept());
    await pageB.keyboard.press('Enter');
    await expect(card.getByRole('status')).toContainText('Session revoked.');
    expect(await card.locator('li').count()).toBe(1);
  } finally {
    await ctxB.close();
  }
});
