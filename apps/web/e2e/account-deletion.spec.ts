import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { createDb, purgeAccount, type Database } from '@nextdoo/db';

/**
 * M6-i7 user-visible account-deletion flow (PRD §6.1 "explicit confirmation
 * and re-authentication" + "defined retention period", §11.1 risk table
 * "Re-authentication, retention window, audit, restore path", §14.3).
 *
 * Real browser for the whole visible lifecycle: schedule (typed DELETE
 * confirmation + password), the session invalidation that follows it, the
 * restore path (signing back in during the grace window cancels and
 * announces it), and the post-purge consequences (credentials dead, email
 * released for a brand-new account). The 30-day wait itself is simulated by
 * backdating the request exactly as the other lifecycle specs do
 * (retention.spec.ts).
 *
 * Product note: scheduling revokes EVERY session of the user, so the browser
 * is sent to sign-in right after a successful request; the only authenticated
 * state a scheduled account can ever see again is the one created by the very
 * sign-in that cancels the deletion (the ?deletion=cancelled notice).
 *
 * Worker-level retry/dead-letter coverage lives in
 * apps/worker/src/account-purge.integration.test.ts.
 */

const connection = createDb(process.env.DATABASE_URL!, { max: 2 });
const db: Database = connection.db;
test.afterAll(() => connection.close());

const origin = { Origin: 'http://localhost:3100' };
// Dedicated X-Forwarded-For range: public auth routes rate-limit per IP.
const IP_A = '198.51.100.250';
const IP_B = '198.51.100.251';
const PASSWORD = 'deletion-e2e-password-123';
const DAY = 86_400_000;

async function register(page: Page, email: string, ip: string): Promise<{ id: string; email: string; workspaceId: string }> {
  const r = await page.request.post('/api/v1/auth/register', {
    headers: { ...origin, 'X-Forwarded-For': ip },
    data: { email, password: PASSWORD, timeZone: 'UTC' },
  });
  expect(r.status()).toBe(200);
  return r.json();
}

/**
 * Login that honours Retry-After on 429. Needed for the reborn login: the
 * pre-purge failed sign-in attempt (same email) records a one-second
 * account-level backoff (login-throttle), and a new account on the same
 * address can legally race it. Persistent rate-limiting still fails the test.
 */
async function apiLogin(page: Page, email: string, ip: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await page.request.post('/api/v1/auth/login', {
      headers: { ...origin, 'X-Forwarded-For': ip },
      data: { email, password: PASSWORD },
    });
    if (r.status() !== 429) return r;
    const retryAfter = Number(r.headers()['retry-after'] ?? '1');
    await page.waitForTimeout(Math.ceil((retryAfter + 0.25) * 1000));
  }
  throw new Error('login kept returning 429');
}

async function backdateAndPurge(userId: string): Promise<void> {
  await db.$client.unsafe(`update users set deletion_requested_at = now() - interval '31 days' where id = '${userId}'`);
  const purged = await purgeAccount(db, userId, new Date(Date.now() - 30 * DAY));
  expect(purged).toBe(true);
}

test('schedule with typed confirmation, then sign in again to restore the account', async ({ page }) => {
  const email = `del-e2e-${randomUUID()}@test.local`;
  await register(page, email, IP_A);
  const login = await page.request.post('/api/v1/auth/login', {
    headers: { ...origin, 'X-Forwarded-For': IP_A },
    data: { email, password: PASSWORD },
  });
  expect(login.status()).toBe(200);

  await page.goto('/settings');
  const section = page.locator('section.card', { has: page.getByRole('heading', { name: 'Delete account' }) });
  await expect(section).toBeVisible();

  // The destructive action cannot be submitted without BOTH the password and
  // the exact typed confirmation (PRD §6.1).
  const submit = section.getByRole('button', { name: 'Delete my account' });
  await expect(submit).toBeDisabled();
  await section.locator('#confirm-delete').fill('DELETE');
  await expect(submit).toBeDisabled();
  await section.locator('#delete-password').fill(PASSWORD);
  await expect(submit).toBeEnabled();

  // The deletion block itself must be accessible (WCAG AA tags).
  const { default: AxeBuilder } = await import('@axe-core/playwright');
  const results = await new AxeBuilder({ page }).include('[data-testid="delete-account"]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(results.violations).toEqual([]);

  // Scheduling revokes every session, so the visible outcome is a redirect
  // to sign-in — there is no authenticated page left on a scheduled account.
  await submit.click();
  await page.waitForURL((url) => url.pathname === '/login');

  // The restore path: signing back in during the grace window cancels the
  // scheduled deletion and announces it (PRD §6.1 "restore").
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(PASSWORD);
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL((url) => url.pathname === '/settings' && url.searchParams.get('deletion') === 'cancelled');
  await expect(page.getByRole('status').filter({ hasText: /scheduled deletion of your account has been cancelled/i })).toBeVisible();

  const status = await (await page.request.get('/api/v1/account/deletion')).json() as { scheduled: boolean };
  expect(status.scheduled).toBe(false);
  expect((await page.request.get('/api/v1/me')).status()).toBe(200);
});

test('scheduling kills the session, and after the purge the credentials are dead with the email released', async ({ page }) => {
  const email = `purged-e2e-${randomUUID()}@test.local`;
  const account = await register(page, email, IP_B); // registration signs the user in

  // Schedule through the real API (re-authenticated).
  const started = Date.now();
  const req = await page.request.post('/api/v1/account/deletion', {
    headers: { ...origin, 'X-Forwarded-For': IP_B, 'Idempotency-Key': randomUUID() },
    data: { password: PASSWORD, confirm: 'DELETE' },
  });
  expect(req.status()).toBe(200);
  const scheduled = (await req.json()) as { scheduled: boolean; requestedAt: string; purgeAfter: string };
  expect(scheduled.scheduled).toBe(true);
  const graceMs = new Date(scheduled.purgeAfter).getTime() - new Date(scheduled.requestedAt).getTime();
  expect(Math.abs(graceMs - 30 * DAY)).toBeLessThanOrEqual(60_000); // the PRD-defined 30-day window

  // Every session dies with the scheduling decision — measured, not assumed.
  const dead = await page.request.get('/api/v1/me');
  expect(dead.status()).toBe(401);
  expect(Date.now() - started).toBeLessThan(5_000);

  // Simulate the 30-day wait and run the same primitive the worker job calls.
  await backdateAndPurge(account.id);

  // Signing in with the old credentials gets the uniform rejection — the
  // address is indistinguishable from one that never existed.
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(PASSWORD);
  await page.locator('form button[type="submit"]').click();
  await expect(page.getByRole('alert').filter({ hasText: /Email or password is incorrect/i })).toBeVisible();
  expect(page.url()).not.toContain('/today');

  // The email is released: a brand-new account can be created and signed in.
  const reborn = await register(page, email, IP_B);
  expect(reborn.id).not.toBe(account.id);
  const login = await apiLogin(page, email, IP_B);
  expect(login.status()).toBe(200);

  // Keep the shared CI database clean.
  await backdateAndPurge(reborn.id);
});
