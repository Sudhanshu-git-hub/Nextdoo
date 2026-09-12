import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { createDb, purgeAccount, type Database } from '@nextdoo/db';

/**
 * M6-i7 user-visible account-deletion flow (PRD §6.1 "explicit confirmation
 * and re-authentication" + "defined retention period", §11.1 risk table
 * "Re-authentication, retention window, audit, restore path", §14.3).
 *
 * Real browser for the whole visible lifecycle: schedule (typed DELETE
 * confirmation + password), the measured session invalidation, the restore
 * path (signing back in during the grace window cancels and announces it),
 * and the post-purge consequences (credentials dead, email released for a
 * brand-new account). The 30-day wait itself is simulated by backdating the
 * request exactly as the other lifecycle specs do (retention.spec.ts).
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

async function backdateAndPurge(userId: string): Promise<void> {
  await db.$client.unsafe(`update users set deletion_requested_at = now() - interval '31 days' where id = '${userId}'`);
  const purged = await purgeAccount(db, userId, new Date(Date.now() - 30 * DAY));
  expect(purged).toBe(true);
}

test('schedule with typed confirmation, measured session kill, and the sign-in restore path', async ({ page }) => {
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
  // the typed confirmation.
  const submit = section.getByRole('button', { name: 'Delete my account' });
  await expect(submit).toBeDisabled();
  await section.locator('#delete-password').fill(PASSWORD);
  await expect(submit).toBeDisabled(); // password alone is not enough
  await section.locator('#confirm-delete').fill('DELETE');
  await expect(submit).toBeEnabled();

  // Accessibility of the visible deletion surface (the Account card hosts it).
  const { default: AxeBuilder } = await import('@axe-core/playwright');
  const results = await new AxeBuilder({ page }).include('section[aria-labelledby="account-heading"]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(results.violations).toEqual([]);

  await submit.click();
  const banner = page.getByRole('alert', { name: /This account is scheduled for deletion/i });
  await expect(banner).toBeVisible();
  await expect(section).toHaveCount(0); // the form is gone once scheduled

  const status = await (await page.request.get('/api/v1/account/deletion')).json() as {
    scheduled: boolean; requestedAt: string | null; purgeAfter: string | null;
  };
  expect(status.scheduled).toBe(true);
  const gapDays = (Date.parse(status.purgeAfter!) - Date.parse(status.requestedAt!)) / DAY;
  expect(Math.round(gapDays)).toBe(30);

  // Measured: the very next request on the just-scheduling session is dead.
  const t0 = Date.now();
  expect((await page.request.get('/api/v1/me')).status()).toBe(401);
  expect(Date.now() - t0).toBeLessThan(60_000); // PRD §6.1: within 60 s

  // The restore path, as a real sign-in: the account is revoked, the owner
  // comes back, and the app tells them the deletion was cancelled.
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(PASSWORD);
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL(/\/settings\?deletion=cancelled/);
  await expect(page.getByRole('status', { name: /scheduled deletion of your account has been cancelled/i })).toBeVisible();
  const restored = await (await page.request.get('/api/v1/account/deletion')).json() as { scheduled: boolean };
  expect(restored.scheduled).toBe(false);
  // The account is fully usable again.
  expect((await page.request.get('/api/v1/me')).status()).toBe(200);
});

test('after the purge the credentials are dead and the email is released for a new account', async ({ page }) => {
  const email = `purged-e2e-${randomUUID()}@test.local`;
  const account = await register(page, email, IP_B);

  // Schedule through the real API (re-authenticated).
  const req = await page.request.post('/api/v1/account/deletion', {
    headers: { ...origin, 'Idempotency-Key': randomUUID() },
    data: { password: PASSWORD, confirm: 'DELETE' },
  });
  expect(req.status()).toBe(200);
  expect(((await req.json()) as { scheduled: boolean }).scheduled).toBe(true);

  // Simulate the 30-day wait and run the same primitive the worker job calls.
  await backdateAndPurge(account.id);

  // Signing in with the old credentials gets the uniform rejection — the
  // address is indistinguishable from one that never existed.
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(PASSWORD);
  await page.locator('form button[type="submit"]').click();
  await expect(page.getByRole('alert', { name: /Email or password is incorrect/i })).toBeVisible();
  expect(page.url()).not.toContain('/today');

  // The email is released: a brand-new account can be created and signed in.
  const reborn = await register(page, email, IP_B);
  expect(reborn.id).not.toBe(account.id);
  const login = await page.request.post('/api/v1/auth/login', {
    headers: { ...origin, 'X-Forwarded-For': IP_B },
    data: { email, password: PASSWORD },
  });
  expect(login.status()).toBe(200);

  // Keep the shared CI database clean.
  await backdateAndPurge(reborn.id);
});
