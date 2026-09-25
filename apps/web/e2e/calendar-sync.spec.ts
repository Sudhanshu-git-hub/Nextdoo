import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { createDb, calendarConnections, calendarMappings, calendarEvents } from '@nextdoo/db';
const { db: connection, close: closeDb } = createDb(process.env.DATABASE_URL!, { max: 2 });
test.afterAll(() => closeDb());

/**
 * M7 — Google Calendar two-way sync, user-visible behaviour (PRD §16, §14.3).
 *
 * This deployment runs E2E without Google credentials, so the provider
 * boundary is exercised the honest way: the UI degrades on 503
 * PROVIDER_UNAVAILABLE, and DB-seeded connections (what a verified exchange
 * would have stored) drive the reconnect prompt, conflict UI and disconnect
 * flows. The provider-facing sync behaviour itself is covered by the
 * deterministic fixture-provider integration suites.
 */

const origin = { Origin: 'http://localhost:3100' };
const IP = '198.51.100.252';
const H = 3_600_000;

async function fixture(page: Page): Promise<{ email: string; workspaceId: string; userId: string }> {
  const email = `calsync-e2e-${randomUUID()}@test.local`;
  const r = await page.request.post('/api/v1/auth/register', {
    headers: { ...origin, 'X-Forwarded-For': IP },
    data: { email, password: 'calendar-test-password-123', timeZone: 'UTC' },
  });
  expect(r.status()).toBe(200);
  const { workspaceId } = await r.json() as { workspaceId: string };
  // Resolve the user id via drizzle (users table).
  const { users } = await import('@nextdoo/db');
  const { eq } = await import('drizzle-orm');
  const [u] = await connection.select().from(users).where(eq(users.email, email)).limit(1);
  return { email, workspaceId, userId: u!.id };
}

async function seedConnection(userId: string, workspaceId: string, status: 'ACTIVE' | 'SUSPENDED', mode = 'READ_WRITE') {
  const [row] = await connection
    .insert(calendarConnections)
    .values({
      id: crypto.randomUUID(),
      userId,
      workspaceId,
      provider: 'google',
      status,
      mode,
      externalAccountId: 'e2e-user@example.com',
      accessTokenEncrypted: 'v1.seeded.seeded.seeded',
      pauseReason: status === 'SUSPENDED' ? 'TOKEN_EXPIRED' : null,
    })
    .returning();
  return row!;
}

async function createTask(page: Page, workspaceId: string, title: string, dueAt: string) {
  const r = await page.request.post('/api/v1/tasks', {
    headers: { ...origin, 'Idempotency-Key': randomUUID() },
    data: { workspaceId, title, dueAt },
  });
  expect(r.status()).toBe(200);
  return (await r.json()) as { id: string; version: number };
}

test('settings: mode is chosen before authorization; unconfigured deployment degrades honestly', async ({ page }) => {
  const { workspaceId } = await fixture(page);
  void workspaceId;
  await page.goto('/settings?section=all');
  const card = page.getByTestId('calendar-card');
  await expect(card).toBeVisible();
  // PRD §16.2: the sync mode is offered BEFORE the Google sign-in.
  await expect(page.getByLabel('Read calendar (imports busy time)')).toBeVisible();
  await expect(page.getByLabel('Read & write (also exports task due times as events)')).toBeVisible();

  // No Google credentials in this deployment → 503 → honest banner, no stub.
  await page.getByTestId('calendar-connect').click();
  await expect(page.getByTestId('calendar-unconfigured')).toBeVisible();
});

test('settings: a paused connection shows the reconnect prompt (PRD §16.6)', async ({ page }) => {
  const { workspaceId, userId } = await fixture(page);
  await seedConnection(userId, workspaceId, 'SUSPENDED');
  await page.goto('/settings?section=all');
  await expect(page.getByTestId('calendar-reconnect-prompt')).toBeVisible();
  await expect(page.getByTestId('calendar-reconnect')).toBeVisible();

  // Reconnecting also needs the provider: the unconfigured deployment says so.
  await page.getByTestId('calendar-reconnect').click();
  await expect(page.getByTestId('calendar-unconfigured')).toBeVisible();
});

test('settings: both-side conflicts show both values and resolve (PRD §16.4)', async ({ page }) => {
  const { workspaceId, userId } = await fixture(page);
  const conn = await seedConnection(userId, workspaceId, 'ACTIVE');
  const dueAt = new Date(Date.now() + 5 * H).toISOString();
  const task = await createTask(page, workspaceId, 'Board deck', dueAt);

  await connection
    .insert(calendarMappings)
    .values({
      id: crypto.randomUUID(),
      connectionId: conn.id,
      taskId: task.id,
      externalId: 'ext-board',
      calendarId: 'primary',
      syncState: 'CONFLICT',
      conflictPayload: {
        local: { dueAt, title: 'Board deck' },
        external: { startsAt: new Date(Date.now() + 8 * H).toISOString(), endsAt: new Date(Date.now() + 9 * H).toISOString(), title: 'Board deck', externalId: 'ext-board' },
        detectedAt: new Date().toISOString(),
      },
    })
    .returning();

  await page.goto('/settings?section=all');
  const conflictCard = page.getByTestId('calendar-conflict');
  await expect(conflictCard).toHaveCount(1);
  await expect(conflictCard).toContainText('NEXTDOO:');
  await expect(conflictCard).toContainText('Calendar:');

  // Keep NEXTDOO: the event would be patched to the task's values (no
  // provider in this deployment, so the decision is recorded locally).
  await conflictCard.getByRole('button', { name: 'Keep NEXTDOO' }).click();
  await expect(page.getByTestId('calendar-conflict')).toHaveCount(0);

  const after = await page.request.get(`/api/v1/calendar/connections/${conn.id}/conflicts`);
  expect(after.status()).toBe(200);
  const afterBody = (await after.json()) as { conflicts: unknown[] };
  expect(afterBody.conflicts).toHaveLength(0);
});

test('settings: disconnect stops sync and retains data (PRD §16.5)', async ({ page }) => {
  const { workspaceId, userId } = await fixture(page);
  const conn = await seedConnection(userId, workspaceId, 'ACTIVE');
  const task = await createTask(page, workspaceId, 'Kept after disconnect', new Date(Date.now() + 6 * H).toISOString());

  await connection.insert(calendarMappings).values({
    id: crypto.randomUUID(),
    connectionId: conn.id,
    taskId: task.id,
    externalId: 'ext-kept',
    calendarId: 'primary',
    syncState: 'SYNCED',
  });

  page.on('dialog', (d) => d.accept());
  await page.goto('/settings?section=all');
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(page.getByTestId('calendar-card')).toContainText('Calendar disconnected');

  const listed = await page.request.get('/api/v1/calendar/connections');
  const connections = ((await listed.json()) as { connections: Array<{ id: string; status: string }> }).connections;
  expect(connections.find((c) => c.id === conn.id)!.status).toBe('DISCONNECTED');

  // The task (imported data) survives the disconnect.
  const taskRes = await page.request.get(`/api/v1/tasks/${task.id}`);
  expect(taskRes.status()).toBe(200);
});

test('calendar view: provider events render as read-only blocks (PRD §16.3)', async ({ page }) => {
  const { workspaceId, userId } = await fixture(page);
  const conn = await seedConnection(userId, workspaceId, 'ACTIVE');

  // A busy provider event inside the visible (today, UTC) window.
  const start = new Date(Date.now() + H);
  await connection.insert(calendarEvents).values({
    id: crypto.randomUUID(),
    connectionId: conn.id,
    workspaceId,
    externalId: 'ext-e2e-block',
    calendarId: 'primary',
    title: 'E2E provider block',
    startsAt: start,
    endsAt: new Date(start.getTime() + H),
    isAllDay: false,
    busy: true,
  });

  await page.goto('/calendar');
  const ext = page.locator('.cal-chip.cal-external').filter({ hasText: 'E2E provider block' });
  await expect(ext).toBeVisible();
  // Read-only: no complete/edit affordance on provider events.
  await expect(ext.getByRole('button', { name: /Complete/ })).toHaveCount(0);
  await expect(ext.locator('.cal-ext-tag')).toHaveText('cal');
});

test('tenant isolation: conflicts are never visible across users', async ({ page, request }) => {
  const a = await fixture(page);
  const connA = await seedConnection(a.userId, a.workspaceId, 'ACTIVE');

  // User B, different IP (different account), cannot read A's connection.
  const b = await page.request.post('/api/v1/auth/register', {
    headers: { ...origin, 'X-Forwarded-For': '198.51.100.253' },
    data: { email: `calsync-e2e-b-${randomUUID()}@test.local`, password: 'calendar-test-password-123', timeZone: 'UTC' },
  });
  expect(b.status()).toBe(200);
  const bRes = await page.request.get(`/api/v1/calendar/connections/${connA.id}/conflicts`);
  expect(bRes.status()).toBe(404);
  void request;
});
