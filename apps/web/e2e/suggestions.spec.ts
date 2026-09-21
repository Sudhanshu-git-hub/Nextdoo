import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { createDb, recurrenceRules, tags, taskOccurrences, tasks, trackingResults } from '@nextdoo/db';
import { eq } from 'drizzle-orm';

/**
 * M8-i2 — advisory suggestions (PRD §5.5/§8.3/§8.5).
 *
 * Covers: visibility in Analytics and Today views, advisory wording, the S1
 * explicit-confirmation estimate raise (the only mutation a suggestion can
 * cause), S2 being view-only, the §7.9 overload toggle, tenant isolation,
 * and a11y of the new card.
 */
const connection = createDb(process.env.DATABASE_URL!, { max: 2 });
test.afterAll(() => connection.close());
const db = connection.db;
const origin = { Origin: 'http://localhost:3100' };
const headers = () => ({ ...origin, 'Idempotency-Key': randomUUID() });

interface Fixture { page: Page; userId: string; workspaceId: string }
async function fixture(page: Page, prefix: string): Promise<Fixture> {
  const registered = await page.request.post('/api/v1/auth/register', {
    headers: { ...origin, 'X-Forwarded-For': '198.51.100.142' },
    data: { email: `${prefix}-${randomUUID()}@test.local`, password: 'suggestions-test-password-123', timeZone: 'UTC' },
  });
  expect(registered.status()).toBe(200);
  const { id, workspaceId } = await registered.json();
  return { page, userId: id, workspaceId };
}

async function createTask(page: Page, workspaceId: string, extra: Record<string, unknown> = {}) {
  const response = await page.request.post('/api/v1/tasks', { headers: headers(), data: { workspaceId, title: 'Suggestion task', ...extra } });
  expect(response.status()).toBe(200);
  return response.json();
}

/** A completed task with a real tracked actual (for measured cohorts). */
async function measuredTask(page: Page, workspaceId: string, tagId: string | null, estimate: number, actual: number) {
  const task = await createTask(page, workspaceId, { title: `Measured ${actual}min`, tagIds: tagId ? [tagId] : [], dueAt: new Date().toISOString(), estimateMinutes: estimate });
  await db.update(tasks).set({ actualMinutes: actual }).where(eq(tasks.id, task.id));
  const complete = await page.request.post(`/api/v1/tasks/${task.id}/complete`, { headers: headers(), data: { version: task.version, completedAt: new Date().toISOString() } });
  expect(complete.status()).toBe(200);
  return task;
}

async function makeTag(workspaceId: string, name: string) {
  const [row] = await db.insert(tags).values({ id: randomUUID(), workspaceId, name }).returning();
  if (!row) throw new Error('tag insert failed');
  return row;
}

/**
 * Seeds data so all five themes fire for the current day window.
 * Occurrence times are pinned to fixed early-today offsets so the window
 * math never depends on the clock.
 */
async function buildAllFiveThemes(page: Page, workspaceId: string) {
  const now = new Date();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  // S1: tag cohort +50% (n=2), one active candidate at 60.
  const tag = await makeTag(workspaceId, 'Sugg deep');
  await measuredTask(page, workspaceId, tag.id, 60, 90);
  await measuredTask(page, workspaceId, tag.id, 60, 90);
  const candidate = await createTask(page, workspaceId, { title: 'Sugg candidate', tagIds: [tag.id], dueAt: now.toISOString(), estimateMinutes: 60 });

  // S2: push today's planned load far above the 480-min default workday.
  // Each piece stays below the 240-min S4 threshold so exactly one S4 fires.
  for (const n of [1, 2, 3]) {
    await createTask(page, workspaceId, { title: `Sugg load ${n}`, dueAt: now.toISOString(), estimateMinutes: 200 });
  }

  // S3: series with three measured occurrences, each completed 45 min late.
  const template = await createTask(page, workspaceId, { title: 'Sugg standup follow-up', dueAt: now.toISOString() });
  const ruleId = randomUUID();
  await db.insert(recurrenceRules).values({
    id: ruleId,
    workspaceId,
    templateTaskId: template.id,
    rule: { freq: 'DAILY', timeZone: 'UTC' },
    timeZone: 'UTC',
    seriesStart: now,
    nextRunAt: now,
    templateSnapshot: { title: 'Sugg standup follow-up' },
  });
  for (let i = 0; i < 3; i++) {
    const due = new Date(todayStart.getTime() + (10 + i * 10) * 60_000);
    const occurrence = await createTask(page, workspaceId, { title: `Sugg occurrence ${i}`, dueAt: due.toISOString(), estimateMinutes: 30 });
    await db
      .update(tasks)
      .set({ recurrenceRuleId: ruleId, actualMinutes: 30, status: 'COMPLETED', completedAt: new Date(due.getTime() + 45 * 60_000) })
      .where(eq(tasks.id, occurrence.id));
    await db.insert(taskOccurrences).values({ id: randomUUID(), recurrenceRuleId: ruleId, occurrenceKey: `${ruleId.slice(0, 8)}-${i}`, taskId: occurrence.id, dueAt: due });
    await db.insert(trackingResults).values({
      id: randomUUID(),
      workspaceId,
      taskId: occurrence.id,
      occurrenceKey: `e2e-${i}`,
      score: '90',
      outcome: 'LATE',
      components: [{ key: 'recurrence', value: 0.9, weight: 0.25, measured: true, reason: 'completed' }],
      explanation: 'e2e fixture',
      measuredWeight: '0.25',
      calculationVersion: 1,
      inputHash: 'c'.repeat(64),
    });
  }

  // S4: a big active task. S5: a frequently rescheduled active task.
  await createTask(page, workspaceId, { title: 'Sugg huge migration', dueAt: now.toISOString(), estimateMinutes: 300 });
  const shuffled = await createTask(page, workspaceId, { title: 'Sugg shuffle', dueAt: now.toISOString() });
  await db.update(tasks).set({ rescheduleCount: 4 }).where(eq(tasks.id, shuffled.id));
  return { candidate, shuffled };
}

test('unauthenticated suggestion requests are rejected (401)', async ({ page, request }) => {
  await page.goto('/login');
  const response = await request.post('/api/v1/ai/suggestions', { data: { period: 'day' } });
  expect(response.status()).toBe(401);
  expect((await response.json()).code).toBe('UNAUTHENTICATED');
});

test('malformed suggestion bodies are rejected without side effects', async ({ page }) => {
  const f = await fixture(page, 'sugg-bad');
  for (const body of [{ period: 'month' }, { period: 'day', dateKey: 'not-a-date' }, { unexpected: true }]) {
    const response = await f.page.request.post('/api/v1/ai/suggestions', { headers: headers(), data: body });
    expect(response.status()).toBe(400);
  }
  const clean = await f.page.request.post('/api/v1/ai/suggestions', { headers: headers(), data: {} });
  expect(clean.status()).toBe(200);
  expect(await clean.json()).toEqual({ ruleVersion: 1, suggestions: [] });
});

test('analytics shows all five advisory themes; S1 confirm is the only plan change; S2 never moves', async ({ page }) => {
  const { page: p, workspaceId } = await fixture(page, 'sugg-all');
  const { candidate } = await buildAllFiveThemes(p, workspaceId);

  // API contract: deterministic and advisory.
  const first = await p.request.post('/api/v1/ai/suggestions', { headers: headers(), data: { period: 'day' } });
  expect(first.status()).toBe(200);
  const payload = await first.json();
  const second = await p.request.post('/api/v1/ai/suggestions', { headers: headers(), data: { period: 'day' } });
  expect(await second.json()).toEqual(payload);
  expect(payload.suggestions.length).toBeLessThanOrEqual(11);
  const types = payload.suggestions.map((s: { type: string }) => s.type).sort();
  expect(types).toEqual(['S1_ESTIMATE', 'S2_OVERLOAD', 'S3_RECURRING', 'S4_SPLIT', 'S5_REVIEW']);
  const s1 = payload.suggestions.find((s: { type: string }) => s.type === 'S1_ESTIMATE');
  expect(s1.action).toMatchObject({ kind: 'raise_estimate', taskId: candidate.id, suggestedMinutes: 90 });

  // UI: the card is visible in Analytics with advisory wording.
  await p.goto('/analytics');
  const card = p.getByTestId('suggestions-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText('Advisory only — nothing changes until you confirm a suggestion.');
  for (const type of ['S1_ESTIMATE', 'S2_OVERLOAD', 'S3_RECURRING', 'S4_SPLIT', 'S5_REVIEW']) {
    await expect(card.locator(`[data-suggestion="${type}"]`)).toBeVisible();
  }
  // Non-punitive, plain language.
  await expect(card).not.toContainText(/you must|should have|failure/i);

  // S2 is view-only: navigation link, no move action anywhere in the card.
  const s2 = card.locator('[data-suggestion="S2_OVERLOAD"]');
  await expect(s2.locator('a', { hasText: 'View calendar' })).toBeVisible();
  await expect(card).not.toContainText(/move task|automatically moved/i);

  // S1: explicit confirmation raises the estimate through the normal PATCH.
  const before = await (await p.request.get(`/api/v1/tasks/${candidate.id}`)).json();
  expect(before.estimateMinutes).toBe(60);
  const patchP = p.waitForResponse((r) => r.url().endsWith(`/api/v1/tasks/${candidate.id}`) && r.request().method() === 'PATCH');
  await card.locator(`[data-testid="suggestion-confirm-S1_ESTIMATE:${candidate.id}"]`).click();
  expect((await patchP).status()).toBe(200);
  const after = await (await p.request.get(`/api/v1/tasks/${candidate.id}`)).json();
  expect(after.estimateMinutes).toBe(90);
  expect(after.version).toBe(before.version + 1);
  await expect(card).toContainText('now has a 90 min estimate');
  // The same task is still advised at the new base (cohort unchanged) — one row, not duplicated.
  const refreshed = await (await p.request.post('/api/v1/ai/suggestions', { headers: headers(), data: { period: 'day' } })).json();
  expect(refreshed.suggestions.filter((s: { type: string; action: { taskId?: string } }) => s.type === 'S1_ESTIMATE' && s.action.taskId === candidate.id)).toHaveLength(1);
});

test('today view shows the overload suggestion; the §7.9 toggle turns it into a neutral line', async ({ page }) => {
  const { page: p, workspaceId } = await fixture(page, 'sugg-today');
  const now = new Date();
  await createTask(p, workspaceId, { title: 'Sugg overload A', dueAt: now.toISOString(), estimateMinutes: 400 });
  await createTask(p, workspaceId, { title: 'Sugg overload B', dueAt: now.toISOString(), estimateMinutes: 200 });

  await p.goto('/today');
  const banner = p.getByTestId('today-overload-suggestion');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('no tasks are moved');

  // §7.9 toggle in settings.
  await p.goto('/settings');
  await p.getByLabel('Hide overload warnings').check();
  for (let i = 0; i < 40; i++) {
    const prefs = (await (await p.request.get('/api/v1/preferences')).json()) as { disableOverloadWarnings?: boolean };
    if (prefs.disableOverloadWarnings === true) break;
    await p.waitForTimeout(250);
  }
  expect(((await (await p.request.get('/api/v1/preferences')).json()) as { disableOverloadWarnings: boolean }).disableOverloadWarnings).toBe(true);

  // Today banner becomes a neutral planned-load line.
  await p.goto('/today');
  await expect(p.getByTestId('today-overload-neutral')).toBeVisible();
  await expect(p.getByTestId('today-overload-suggestion')).toHaveCount(0);

  // …and S2 stops being generated server-side (other themes are unaffected).
  const response = await (await p.request.post('/api/v1/ai/suggestions', { headers: headers(), data: { period: 'day' } })).json();
  expect(response.suggestions.filter((s: { type: string }) => s.type === 'S2_OVERLOAD')).toHaveLength(0);
  expect(response.suggestions.some((s: { type: string }) => s.type === 'S4_SPLIT')).toBe(true);
});

test('suggestions never leak across workspaces', async ({ page, playwright }) => {
  const a = await fixture(page, 'sugg-lease');
  const { candidate } = await buildAllFiveThemes(a.page, a.workspaceId);
  // A second user needs a separate request context: registering on the same
  // page would replace the shared context's session cookie with B's.
  const b = await playwright.request.newContext({ baseURL: 'http://localhost:3100' });
  try {
    const registered = await b.post('/api/v1/auth/register', {
      headers: { ...origin, 'X-Forwarded-For': '198.51.100.143' },
      data: { email: `sugg-tenant-${randomUUID()}@test.local`, password: 'suggestions-test-password-123', timeZone: 'UTC' },
    });
    expect(registered.status()).toBe(200);
    const bResponse = await (await b.post('/api/v1/ai/suggestions', { headers: headers(), data: { period: 'day' } })).json();
    expect(bResponse.suggestions).toHaveLength(0);
    expect(JSON.stringify(bResponse)).not.toContain('Sugg candidate');
  } finally {
    await b.dispose();
  }
  // A still sees its own.
  const aResponse = await (await a.page.request.post('/api/v1/ai/suggestions', { headers: headers(), data: { period: 'day' } })).json();
  expect(aResponse.suggestions.some((s: { action: { taskId?: string } }) => s.action.taskId === candidate.id)).toBe(true);
});

test('suggestions card passes axe (wcag2a/wcag2aa)', async ({ page }) => {
  const { page: p, workspaceId } = await fixture(page, 'sugg-axe');
  const tag = await makeTag(workspaceId, 'Sugg axe tag');
  await measuredTask(p, workspaceId, tag.id, 60, 90);
  await measuredTask(p, workspaceId, tag.id, 60, 90);
  await createTask(p, workspaceId, { title: 'Sugg axe candidate', tagIds: [tag.id], dueAt: new Date().toISOString(), estimateMinutes: 60 });
  await p.goto('/analytics');
  await expect(p.getByTestId('suggestions-card')).toBeVisible();
  const { default: AxeBuilder } = await import('@axe-core/playwright');
  const results = await new AxeBuilder({ page: p }).include('[data-testid="suggestions-card"]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(results.violations).toEqual([]);
});
