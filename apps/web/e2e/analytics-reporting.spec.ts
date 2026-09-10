import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { createDb, runTrackingCycle, recurrenceRules, taskOccurrences, tasks, timerSessions } from '@nextdoo/db';
import { eq } from 'drizzle-orm';
const connection = createDb(process.env.DATABASE_URL!, { max: 2 });
test.afterAll(() => connection.close());
const origin = { Origin: 'http://localhost:3100' };
const headers = () => ({ ...origin, 'Idempotency-Key': randomUUID() });

/** Fixed-offset helpers for Asia/Kolkata (UTC+5:30, no DST). */
const IST_MS = 5.5 * 3600_000;
const DAY_MS = 86_400_000;
/** The UTC instant of the local IST midnight of "today" (offsetDays shifts the local day). */
function istMidnightUtc(offsetDays = 0): Date {
  const wall = new Date(Date.now() + IST_MS);
  // Local midnight of wall date D is 18:30 UTC on D-1.
  return new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate(), 18, 30) - DAY_MS + offsetDays * DAY_MS);
}
const localKey = (date: Date, timeZone: string) => new Intl.DateTimeFormat('en-CA', { timeZone }).format(date);

interface Fixture { page: Page; userId: string; workspaceId: string }
async function fixture(page: Page, timeZone: string = 'UTC'): Promise<Fixture> {
  const registered = await page.request.post('/api/v1/auth/register', {
    headers: { ...origin, 'X-Forwarded-For': '198.51.100.131' },
    data: { email: `reporting-${randomUUID()}@test.local`, password: 'reporting-test-password-123', timeZone },
  });
  expect(registered.status()).toBe(200);
  const { id, workspaceId } = await registered.json();
  return { page, userId: id, workspaceId };
}
async function setWorkspace(page: Page, workspaceId: string, patch: Record<string, unknown>) {
  const response = await page.request.patch(`/api/v1/workspaces/${workspaceId}`, { headers: headers(), data: { version: 1, ...patch } });
  expect(response.status()).toBe(200);
  return response.json();
}
async function createTask(page: Page, workspaceId: string, extra: Record<string, unknown> = {}) {
  const response = await page.request.post('/api/v1/tasks', { headers: headers(), data: { workspaceId, title: 'Reporting task', ...extra } });
  expect(response.status()).toBe(200);
  return response.json();
}

test('workspace time zone defines day and week windows, not UTC', async ({ page }) => {
  const { page: p, workspaceId } = await fixture(page);
  await setWorkspace(p, workspaceId, { timeZone: 'Asia/Kolkata' });
  // Both instants fall on the same UTC day but different IST days.
  const yesterdayEvening = new Date(istMidnightUtc(0).getTime() - 3600_000); // local yesterday 23:00
  const todayEarly = new Date(istMidnightUtc(0).getTime() + 3600_000); // local today 01:00
  await createTask(p, workspaceId, { title: 'Before local midnight', dueAt: yesterdayEvening.toISOString() });
  await createTask(p, workspaceId, { title: 'After local midnight', dueAt: todayEarly.toISOString() });
  const yesterday = localKey(istMidnightUtc(-1), 'Asia/Kolkata');
  const today = localKey(istMidnightUtc(0), 'Asia/Kolkata');
  expect(yesterday).not.toBe(today);
  const asDay = async (date: string) => {
    const r = await p.request.get(`/api/v1/tracking/summary?workspaceId=${workspaceId}&period=day&date=${date}`);
    expect(r.status()).toBe(200);
    return r.json();
  };
  expect(await asDay(yesterday)).toMatchObject({ plannedCount: 1, timeZone: 'Asia/Kolkata' });
  expect(await asDay(today)).toMatchObject({ plannedCount: 1, timeZone: 'Asia/Kolkata' });
  // The week starts on the workspace's configured week start (Monday by default).
  const weekdayIndex = (now: Date) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', weekday: 'short' }).format(now));
  const backToMonday = (weekdayIndex(new Date()) - 1 + 7) % 7;
  const week = await (await p.request.get(`/api/v1/tracking/summary?workspaceId=${workspaceId}&period=week`)).json();
  expect(week).toMatchObject({
    weekStart: 1,
    timeZone: 'Asia/Kolkata',
    from: new Date(istMidnightUtc(0).getTime() - backToMonday * DAY_MS).toISOString(),
  });
  expect(week.days.map((d: { day: string }) => d.day)).toEqual(
    Array.from({ length: backToMonday + 1 }, (_, i) => localKey(new Date(istMidnightUtc(0).getTime() + (i - backToMonday) * DAY_MS), 'Asia/Kolkata')),
  );
  // The UI states the zone and the week start plainly.
  await p.goto('/analytics');
  await p.getByRole('button', { name: 'Today', exact: true }).click();
  await expect(p.getByText('times in Asia/Kolkata', { exact: false })).toBeVisible();
  await expect(p.locator('[aria-label="Tracking freshness"]')).toContainText('starts on Monday');
  // The week table shows today's local row with exactly the after-midnight task.
  const table = p.locator('[data-day-table]');
  await expect(table).toBeVisible();
  const todayRow = table.locator('tr', { hasText: new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }).format(new Date(istMidnightUtc(0))) });
  await expect(todayRow.locator('[data-day-planned]')).toHaveText('1');
});

test('weekly trends render real data with plain, non-judgemental explanations', async ({ page }) => {
  const { page: p, userId, workspaceId } = await fixture(page);
  const db = connection.db;
  const at = (h: number, m = 0) => { const d = new Date(); d.setUTCHours(h, m, 0, 0); return d.toISOString(); };
  const tag = await (await p.request.post('/api/v1/tags', { headers: headers(), data: { workspaceId, name: 'client-work' } })).json();
  const t1 = await createTask(p, workspaceId, { title: 'Overrun one', dueAt: at(12), estimateMinutes: 60, tagIds: [tag.id] });
  const t2 = await createTask(p, workspaceId, { title: 'Overrun two', dueAt: at(12), estimateMinutes: 60, tagIds: [tag.id] });
  const t3 = await createTask(p, workspaceId, { title: 'Moved twice', dueAt: at(12) });
  const t3a = (await (await p.request.patch(`/api/v1/tasks/${t3.id}`, { headers: headers(), data: { version: t3.version, dueAt: at(12, 30) } })).json());
  await p.request.patch(`/api/v1/tasks/${t3.id}`, { headers: headers(), data: { version: t3a.version, dueAt: at(13) } });
  const t4 = await createTask(p, workspaceId, { title: 'Recurring', dueAt: at(12) });
  await createTask(p, workspaceId, { title: 'Big day', dueAt: at(12), estimateMinutes: 600 });
  // Occurrences: 3 of 4 completed -> recurrence component 75.
  const ruleId = randomUUID();
  await db.insert(recurrenceRules).values({ id: ruleId, workspaceId, templateTaskId: t4.id, rule: {}, timeZone: 'UTC', seriesStart: new Date() });
  await db.update(tasks).set({ recurrenceRuleId: ruleId }).where(eq(tasks.id, t4.id));
  await db.insert(taskOccurrences).values(Array.from({ length: 4 }, (_, i) => ({ id: randomUUID(), recurrenceRuleId: ruleId, occurrenceKey: `${ruleId}:${i}`, dueAt: new Date(), status: i === 3 ? 'SKIPPED' as const : 'COMPLETED' as const })));
  // Tracked time: one hour of focus today; actuals over estimate for the tagged pair.
  await db.insert(timerSessions).values({ id: randomUUID(), workspaceId, taskId: t1.id, userId, deviceId: 'e2e', startedAt: new Date(at(8)), endedAt: new Date(at(9)), accumulatedSeconds: 3600, status: 'STOPPED' });
  await db.update(tasks).set({ actualMinutes: 90, actualSecondsRemainder: 0 }).where(eq(tasks.id, t1.id));
  await db.update(tasks).set({ actualMinutes: 80, actualSecondsRemainder: 0 }).where(eq(tasks.id, t2.id));
  await (await p.request.post(`/api/v1/tasks/${t1.id}/complete`, { headers: headers(), data: { version: t1.version, completedAt: at(13) } })).json();
  await (await p.request.post(`/api/v1/tasks/${t2.id}/complete`, { headers: headers(), data: { version: t2.version, completedAt: at(11) } })).json();
  await runTrackingCycle(db, workspaceId);
  await p.goto('/analytics');
  const report = p;
  // Timing summary includes the mean lateness.
  await expect(report.getByText('1 finished late, average 1h 0m over')).toBeVisible();
  // Day trend row: today is over the 8h workday and has a stored score.
  const table = report.locator('[data-day-table]');
  await expect(table).toBeVisible();
  const todayRow = table.locator('tr', { hasText: new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date()) });
  await expect(todayRow.locator('[data-day-planned]')).toHaveText('5');
  await expect(todayRow.locator('[data-day-focus]')).toHaveText('1h 0m');
  await expect(todayRow.locator('[data-day-overloaded]')).toContainText('over the 8h 0m workday');
  await expect(todayRow.locator('[data-day-score]')).not.toHaveText('—');
  // Weekly trend cards carry the PRD §7.8 metrics.
  await expect(report.locator('[data-week-recurring] [data-recurrence-adherence]')).toHaveText('75%');
  await expect(report.locator('[data-week-focus] [data-week-focus-total]')).toHaveText('1h 0m');
  await expect(report.locator('[data-week-rescheduled] [data-rescheduled-task]')).toHaveText('Moved twice — moved 2 times');
  await expect(report.locator('[data-week-tags] [data-tag-variance]')).toHaveText('client-work — about +42% over estimate (2 tasks)');
  // Explanations are plain language with tag attribution.
  await expect(report.getByText(/Tasks tagged 'client-work' took about 42% longer than estimated \(2 task\(s\)\)/)).toBeVisible();
  await expect(report.getByText('Most rescheduled: "Moved twice" (moved 2 times).')).toBeVisible();
  await expect(report.getByText('Recurring task adherence was 75% across 1 recurring task(s).')).toBeVisible();
  await expect(report.getByText('You tracked about 1h of focus time in this window.')).toBeVisible();
  // Explanations are descriptive, never judgemental (PRD §7.8).
  await expect(report.locator('[data-insights]')).not.toContainText(/fail(ed|ure)?|bad|lazy|procrastinat/i);
  const { default: AxeBuilder } = await import('@axe-core/playwright');
  expect((await new AxeBuilder({ page: p }).include('[data-day-table], [data-week-recurring], [data-week-focus], [data-week-rescheduled], [data-week-tags]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([]);
});

test('excluding a task from analytics also removes its focus time from the report', async ({ page }) => {
  const { page: p, userId, workspaceId } = await fixture(page);
  const db = connection.db;
  const at = (h: number, m = 0) => { const d = new Date(); d.setUTCHours(h, m, 0, 0); return d.toISOString(); };
  const task = await createTask(p, workspaceId, { title: 'One-off', dueAt: at(12) });
  await db.insert(timerSessions).values({ id: randomUUID(), workspaceId, taskId: task.id, userId, deviceId: 'e2e', startedAt: new Date(at(8)), endedAt: new Date(at(8, 30)), accumulatedSeconds: 1800, status: 'STOPPED' });
  await runTrackingCycle(db, workspaceId);
  await p.goto('/analytics');
  await p.getByRole('button', { name: 'Today', exact: true }).click();
  await expect(p.locator('[data-day-table] [data-day-focus]')).toHaveText('30m', { timeout: 10_000 });
  const correction = await p.request.post(`/api/v1/tracking/tasks/${task.id}/corrections`, {
    headers: headers(),
    data: { kind: 'EXCLUDED_FROM_ANALYTICS', action: 'SET', reason: 'One-off that distorts the trend' },
  });
  expect(correction.status()).toBe(200);
  await expect(p.getByText(/hidden by an “excluded from analytics” correction/)).toBeVisible({ timeout: 15_000 });
  await expect(p.locator('[data-day-table]')).toHaveCount(0, { timeout: 15_000 });
  await expect(p.getByText('Nothing to review yet')).toBeVisible();
});

test('review notes save per local day, validate, persist across reloads, and stay tenant-private', async ({ page, playwright }) => {
  const { page: p, workspaceId } = await fixture(page);
  await p.goto('/analytics');
  // Empty workspace: the loop is explained and the optional note is still available.
  await expect(p.getByText('Nothing to review yet')).toBeVisible();
  const note = p.locator('[data-review-note]');
  await expect(note).toBeVisible();
  const body = note.locator('#review-note-body');
  await body.fill('Shipped the hard part; the rest is polish.');
  await note.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(note.getByRole('status')).toContainText('Saved for this day.', { timeout: 10_000 });
  await p.reload();
  await expect(p.locator('#review-note-body')).toHaveValue('Shipped the hard part; the rest is polish.', { timeout: 10_000 });
  await p.locator('[data-review-note-clear]').click();
  await expect(p.locator('#review-note-body')).toHaveValue('');
  // Validation and per-day scoping over the API.
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(new Date());
  const tooLong = await p.request.put(`/api/v1/tracking/review-notes?workspaceId=${workspaceId}&day=${today}`, { headers: headers(), data: { body: 'x'.repeat(501) } });
  expect(tooLong.status()).toBe(400);
  expect((await p.request.get(`/api/v1/tracking/review-notes?workspaceId=${workspaceId}&day=${today}`)).status()).toBe(204);
  const otherDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(new Date(Date.now() - DAY_MS));
  expect((await p.request.get(`/api/v1/tracking/review-notes?workspaceId=${workspaceId}&day=${otherDay}`)).status()).toBe(204);
  // Another tenant cannot read or write this workspace's note.
  const foreign = await playwright.request.newContext({ baseURL: 'http://localhost:3100' });
  const foreignRegistered = await foreign.post('/api/v1/auth/register', {
    headers: { ...origin, 'X-Forwarded-For': '198.51.100.132' },
    data: { email: `reporting-foreign-${randomUUID()}@test.local`, password: 'reporting-test-password-123', timeZone: 'UTC' },
  });
  expect(foreignRegistered.status()).toBe(200);
  expect((await foreign.get(`/api/v1/tracking/review-notes?workspaceId=${workspaceId}&day=${today}`)).status()).toBe(403);
  expect((await foreign.put(`/api/v1/tracking/review-notes?workspaceId=${workspaceId}&day=${today}`, { headers: headers(), data: { body: 'intrusion' } })).status()).toBe(403);
  const { default: AxeBuilder } = await import('@axe-core/playwright');
  expect((await new AxeBuilder({ page: p }).include('[data-review-note]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([]);
  await foreign.dispose();
});
