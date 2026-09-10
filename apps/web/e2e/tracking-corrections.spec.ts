import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { createDb, runTrackingBackfill, runTrackingCycle, trackingBackfills, trackingCorrections, trackingResults, auditLogs } from '@nextdoo/db';

const connection = createDb(process.env.DATABASE_URL!, { max: 2 });
test.afterAll(() => connection.close());
const origin = { Origin: 'http://localhost:3100' };
const headers = () => ({ ...origin, 'Idempotency-Key': randomUUID() });

const dayKey = (offsetDays: number) => new Date(Date.now() - offsetDays * 86_400_000).toISOString().slice(0, 10);
/** datetime-local input values are local wall-clock time; the Playwright project pins the browser to UTC. */
const localDateTime = (d: Date) => d.toISOString().slice(0, 16);

async function register(page: Page, tag: string, ip = '198.51.100.170') {
  const r = await page.request.post('/api/v1/auth/register', {
    headers: { ...origin, 'X-Forwarded-For': ip },
    data: { email: `corrections-${tag}-${randomUUID()}@test.local`, password: 'corrections-test-password-123', timeZone: 'UTC' },
  });
  expect(r.status()).toBe(200);
  return r.json() as Promise<{ workspaceId: string }>;
}

async function fixture(page: Page, dueAt: Date) {
  const { workspaceId } = await register(page, 'fixture');
  const t = await page.request.post('/api/v1/tasks', {
    headers: headers(),
    data: { workspaceId, title: 'Correction browser task', dueAt: dueAt.toISOString() },
  });
  expect(t.status()).toBe(200);
  return { workspaceId, task: (await t.json()) as { id: string; version: number } };
}

const resultsFor = async (taskId: string) => connection.db.select().from(trackingResults).where(eq(trackingResults.taskId, taskId));

test('a due-date correction applied from the panel recalculates, keeps the original result, and is audited', async ({ page }) => {
  const { workspaceId, task } = await fixture(page, new Date(Date.now() + 10 * 60_000));
  expect((await page.request.post(`/api/v1/tasks/${task.id}/complete`, { headers: headers(), data: { version: task.version } })).status()).toBe(200);
  await runTrackingCycle(connection.db, workspaceId);
  const before = await resultsFor(task.id);
  expect(before).toHaveLength(1);
  expect(before[0]).toMatchObject({ outcome: 'ON_TIME', recalculated: false });
  const originalId = before[0]!.id;

  await page.goto(`/analytics?taskId=${task.id}`);
  await expect(page.locator('[data-tracking-state]')).toHaveAttribute('data-tracking-state', 'FRESH');
  await page.selectOption('#correction-kind', 'DUE_DATE_CORRECTED');
  const correctedDue = new Date(Date.now() - 2 * 3_600_000);
  await page.fill('#correction-due', localDateTime(correctedDue));
  await page.fill('#correction-reason', 'The original due date was entered wrong');
  await page.getByRole('button', { name: 'Apply correction', exact: true }).click();
  await expect(page.locator('.tracking-panel p[role="status"]', { hasText: 'Correction recorded and re-evaluation queued.' })).toBeVisible();
  await runTrackingCycle(connection.db, workspaceId);
  await expect(page.locator('[data-tracking-state]')).toHaveAttribute('data-tracking-state', 'FRESH', { timeout: 12_000 });

  // TR-05: new result is recalculated LATE; the original is superseded, never mutated.
  const after = await resultsFor(task.id);
  expect(after).toHaveLength(2);
  const current = after.find((r) => r.supersededAt === null)!;
  expect(current).toMatchObject({ outcome: 'LATE', recalculated: true });
  expect(current.id).not.toBe(originalId);
  const original = after.find((r) => r.id === originalId)!;
  expect(original).toMatchObject({ outcome: 'ON_TIME', recalculated: false });
  expect(original.supersededAt).toBeInstanceOf(Date);

  // The correction row preserves actor, reason and the old/new due; the task's real due date moved.
  const [row] = await connection.db.select().from(trackingCorrections).where(eq(trackingCorrections.taskId, task.id));
  expect(row).toMatchObject({ kind: 'DUE_DATE_CORRECTED', reason: 'The original due date was entered wrong' });
  expect(row!.payload).toMatchObject({ from: expect.any(String), to: expect.any(String) });
  expect(row!.actorId).toEqual(expect.any(String));
  // An audit row exists for the correction.
  const audits = await connection.db.select().from(auditLogs).where(eq(auditLogs.workspaceId, workspaceId));
  expect(audits.map((a) => a.action)).toContain('tracking.correction_due_date');
  // The recorded correction is visible in the panel list.
  await expect(page.locator('[data-tracking-correction-id]')).toHaveCount(1);

  const { default: AxeBuilder } = await import('@axe-core/playwright');
  expect((await new AxeBuilder({ page }).include('.tracking-panel').withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([]);
});

test('excluding a task from analytics removes it from the summary but keeps its stored result drill-down', async ({ page }) => {
  const due = new Date();
  due.setUTCHours(12, 0, 0, 0);
  const { workspaceId, task } = await fixture(page, due);
  await runTrackingCycle(connection.db, workspaceId);
  expect(await resultsFor(task.id)).toHaveLength(1);

  await page.goto(`/analytics?taskId=${task.id}`);
  await expect(page.locator('[data-tracking-state]')).toHaveAttribute('data-tracking-state', 'FRESH');
  await page.selectOption('#correction-kind', 'EXCLUDED_FROM_ANALYTICS');
  await page.fill('#correction-reason', 'One-off task that distorts the trend');
  await page.getByRole('button', { name: 'Apply correction', exact: true }).click();
  await expect(page.locator('.tracking-panel p[role="status"]', { hasText: 'Correction recorded and re-evaluation queued.' })).toBeVisible();
  await runTrackingCycle(connection.db, workspaceId);

  // The summary now reports the exclusion instead of silently dropping the task.
  await expect(page.getByText(/hidden by an “excluded from analytics” correction/)).toBeVisible({ timeout: 15_000 });
  // The stored result and its evidence remain available in the drill-down.
  await expect(page.locator('[data-tracking-result-id]')).toHaveCount(1);
  expect(await resultsFor(task.id)).toHaveLength(1);
});

test('recalculating a date range from analytics is observable day by day and the 10/hour limit is enforced', async ({ page }) => {
  const { workspaceId } = await register(page, 'recalc');
  await page.goto('/analytics');
  await expect(page.locator('[data-tracking-recalculate]')).toBeVisible();

  // A single-day range so each request is exactly one worker run.
  await page.getByLabel('Recalculation range start').fill(dayKey(0));
  await page.getByLabel('Recalculation range end').fill(dayKey(0));
  await page.fill('#recalc-reason', 'Milestone verification');
  await page.getByRole('button', { name: 'Start recalculation', exact: true }).click();
  await expect(page.locator('[data-tracking-recalc-progress]')).toContainText('day 1 of 1', { timeout: 10_000 });
  await runTrackingBackfill(connection.db, workspaceId);
  await expect(page.locator('[data-tracking-recalc-progress]')).toContainText('is complete (1 day(s))', { timeout: 20_000 });
  expect((await connection.db.select().from(trackingBackfills).where(eq(trackingBackfills.workspaceId, workspaceId)))[0]!.status).toBe('COMPLETED');

  // Nine more requests through the API (the UI request was number one), each run to completion.
  for (let i = 0; i < 9; i += 1) {
    const res = await page.request.post('/api/v1/tracking/recalculate', {
      headers: headers(),
      data: { from: dayKey(0), to: dayKey(0), reason: `Limit check ${i + 2}` },
    });
    expect(res.status()).toBe(200);
    await runTrackingBackfill(connection.db, workspaceId);
  }
  // The eleventh request within the hour is rate limited (PRD §14.8).
  const limited = await page.request.post('/api/v1/tracking/recalculate', {
    headers: headers(),
    data: { from: dayKey(0), to: dayKey(0), reason: 'Over the limit' },
  });
  expect(limited.status()).toBe(429);
  expect(await limited.json()).toMatchObject({ code: 'RATE_LIMITED' });
  // The rate-limited request must not consume the idempotency key: the same
  // key still works for a later (non-limited) request shape check — here we
  // only assert the problem body is a real problem, not a broken empty 200.
  expect((await limited.json()).status).toBe(429);
});

test('corrections and recalculation are authenticated, tenant scoped, and idempotency protected', async ({ page, playwright }) => {
  const { workspaceId, task } = await fixture(page, new Date(Date.now() + 60_000));
  const correction = { kind: 'EXTERNALLY_BLOCKED', action: 'SET', reason: 'Blocked waiting on a vendor' };

  const foreign = await playwright.request.newContext({ baseURL: 'http://localhost:3100' });
  try {
    // Unauthenticated: 401 on every new endpoint.
    expect((await foreign.post(`/api/v1/tracking/tasks/${task.id}/corrections`, { headers: headers(), data: correction })).status()).toBe(401);
    expect((await foreign.post('/api/v1/tracking/recalculate', { headers: headers(), data: { reason: 'Nope' } })).status()).toBe(401);
    expect((await foreign.get('/api/v1/tracking/recalculate')).status()).toBe(401);

    // Registered foreign user: another workspace's task is 404, never a leak.
    await foreign.post('/api/v1/auth/register', {
      headers: { ...origin, 'X-Forwarded-For': '198.51.100.171' },
      data: { email: `corrections-foreign-${randomUUID()}@test.local`, password: 'corrections-test-password-123', timeZone: 'UTC' },
    });
    expect((await foreign.post(`/api/v1/tracking/tasks/${task.id}/corrections`, { headers: headers(), data: correction })).status()).toBe(404);
    // A recalculation requested by the foreign user only touches their own workspace.
    expect((await foreign.post('/api/v1/tracking/recalculate', { headers: headers(), data: { reason: 'Foreign run' } })).status()).toBe(200);
    expect(await connection.db.select().from(trackingBackfills).where(eq(trackingBackfills.workspaceId, workspaceId))).toHaveLength(0);
  } finally {
    await foreign.dispose();
  }

  // Idempotency is required: no key is a 400, not a silent duplicate.
  expect((await page.request.post(`/api/v1/tracking/tasks/${task.id}/corrections`, { headers: origin, data: correction })).status()).toBe(400);

  // A valid correction through the API is recorded and audited.
  expect((await page.request.post(`/api/v1/tracking/tasks/${task.id}/corrections`, { headers: headers(), data: correction })).status()).toBe(200);
  expect((await connection.db.select().from(trackingCorrections).where(eq(trackingCorrections.taskId, task.id)))).toHaveLength(1);
  const audits = await connection.db.select().from(auditLogs).where(eq(auditLogs.workspaceId, workspaceId));
  expect(audits.filter((a) => a.action === 'tracking.correction')).toHaveLength(1);
});
