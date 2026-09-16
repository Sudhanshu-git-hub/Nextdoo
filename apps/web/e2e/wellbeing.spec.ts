import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { WELLBEING_PREFERENCE_DEFAULTS, type WellbeingPreferences } from '@nextdoo/contracts';
import { createDb, tasks } from '@nextdoo/db';
import { eq } from 'drizzle-orm';

/**
 * M8-i3 (PRD §7.9) — wellbeing preference controls, real browser.
 *
 * Covers: the exact six-key default vector from the API; malformed patch
 * rejection; the "Hide numeric scores" toggle end-to-end (Settings →
 * Analytics, TR-07 behavior, restore on untoggle); the forward-gate keys
 * (streaks/celebrations/sounds/comparative metrics) being persisted but
 * visibly inert, including that the user's own trend data is unaffected by
 * the comparative-metrics key; cross-user isolation; and a11y of the
 * Wellbeing card.
 */
const connection = createDb(process.env.DATABASE_URL!, { max: 2 });
test.afterAll(() => connection.close());
const db = connection.db;
const origin = { Origin: 'http://localhost:3100' };
const headers = () => ({ ...origin, 'Idempotency-Key': randomUUID() });

interface Fixture { page: Page; userId: string; workspaceId: string }
async function fixture(page: Page, prefix: string): Promise<Fixture> {
  const registered = await page.request.post('/api/v1/auth/register', {
    headers: { ...origin, 'X-Forwarded-For': '198.51.100.150' },
    data: { email: `${prefix}-${randomUUID()}@test.local`, password: 'wellbeing-test-password-123', timeZone: 'UTC' },
  });
  expect(registered.status()).toBe(200);
  const { id, workspaceId } = await registered.json();
  return { page, userId: id, workspaceId };
}

/** A completed task with estimate + actual so a real score exists. */
async function measuredTask(page: Page, workspaceId: string) {
  const created = await (await page.request.post('/api/v1/tasks', {
    headers: headers(),
    data: { workspaceId, title: 'Wellbeing measured task', priority: 'NONE', tagIds: [], dueAt: new Date().toISOString(), estimateMinutes: 60 },
  })).json();
  await db.update(tasks).set({ actualMinutes: 90 }).where(eq(tasks.id, created.id));
  const complete = await page.request.post(`/api/v1/tasks/${created.id}/complete`, {
    headers: headers(),
    data: { version: created.version, completedAt: new Date().toISOString() },
  });
  expect(complete.status()).toBe(200);
}

/** Waits for the best-effort evaluation to produce a stored score. */
async function waitForScore(page: Page, workspaceId: string) {
  for (let i = 0; i < 40; i++) {
    const summary = (await (await page.request.get(`/api/v1/tracking/summary?workspaceId=${workspaceId}&period=day`)).json()) as {
      scoredCount: number; averageScore: number | null;
    };
    if (summary.scoredCount > 0 && summary.averageScore !== null) return;
    await page.waitForTimeout(250);
  }
  throw new Error('no stored score appeared within the wait window');
}

async function getPrefs(page: Page): Promise<WellbeingPreferences> {
  return (await (await page.request.get('/api/v1/preferences')).json()) as WellbeingPreferences;
}

test('a fresh user gets the exact six-key default vector; malformed patches are rejected', async ({ page }) => {
  const f = await fixture(page, 'wellbeing-defaults');
  expect(await getPrefs(f.page)).toEqual(WELLBEING_PREFERENCE_DEFAULTS);

  for (const body of [{ disableBogus: true }, {}, { disableScores: 'yes' }]) {
    const response = await f.page.request.patch('/api/v1/preferences', { headers: headers(), data: body });
    expect(response.status()).toBe(400);
    expect((await response.json()).code).toBe('VALIDATION_FAILED');
  }
  // Nothing was written by the rejected bodies.
  expect(await getPrefs(f.page)).toEqual(WELLBEING_PREFERENCE_DEFAULTS);
});

test('hiding numeric scores via Settings strips scores from Analytics and restores them', async ({ page }) => {
  const f = await fixture(page, 'wellbeing-scores');
  await measuredTask(f.page, f.workspaceId);
  await waitForScore(f.page, f.workspaceId);

  // Scores visible in Analytics by default.
  await f.page.goto('/analytics');
  const scoreStat = f.page.getByText('Execution score', { exact: true });
  await expect(scoreStat).toBeVisible();
  expect(await getPrefs(f.page)).toMatchObject({ disableScores: false });

  // Toggle in Settings → the well-known TR-07 hidden state in Analytics.
  await f.page.goto('/settings');
  const toggle = f.page.getByLabel('Hide numeric scores', { exact: true });
  await expect(toggle).toBeVisible();
  const patchP = f.page.waitForResponse((r) => r.url().endsWith('/api/v1/preferences') && r.request().method() === 'PATCH');
  await toggle.check();
  expect((await patchP).status()).toBe(200);
  expect(await getPrefs(f.page)).toMatchObject({ disableScores: true });

  await f.page.goto('/analytics');
  await expect(f.page.getByText('Numeric scores are hidden by your stored preference.')).toBeVisible();
  await expect(f.page.getByText('Execution score', { exact: true })).toHaveCount(0);
  await expect(f.page.getByRole('columnheader', { name: 'Score', exact: true })).toHaveCount(0);

  // Untoggle → scores return from the same stored results.
  await f.page.goto('/settings');
  const patchBack = f.page.waitForResponse((r) => r.url().endsWith('/api/v1/preferences') && r.request().method() === 'PATCH');
  await toggle.uncheck();
  expect((await patchBack).status()).toBe(200);
  await f.page.goto('/analytics');
  await expect(f.page.getByText('Execution score', { exact: true })).toBeVisible();
  await expect(f.page.getByText('Numeric scores are hidden by your stored preference.')).toHaveCount(0);
});

test('the forward-gate keys persist and audit but change no product behavior (comparative key keeps own trends)', async ({ page }) => {
  const f = await fixture(page, 'wellbeing-gates');
  await measuredTask(f.page, f.workspaceId);
  await waitForScore(f.page, f.workspaceId);

  const summaryOf = async () => {
    const s = (await (await f.page.request.get(`/api/v1/tracking/summary?workspaceId=${f.workspaceId}&period=day`)).json()) as {
      days: unknown[]; insights: string[]; averageScore: number | null; plannedMinutes: number;
    };
    return { days: s.days, insights: s.insights, averageScore: s.averageScore, plannedMinutes: s.plannedMinutes };
  };
  const before = await summaryOf();
  expect(before.insights.length).toBeGreaterThan(0);

  const gates = { disableStreaks: true, disableCelebrations: false, disableSounds: true, disableComparativeMetrics: false };
  const patch = await f.page.request.patch('/api/v1/preferences', { headers: headers(), data: gates });
  expect(patch.status()).toBe(200);
  expect(await getPrefs(f.page)).toMatchObject(gates);

  // Persisted, but every own-trend figure is byte-identical.
  expect(await summaryOf()).toEqual(before);

  // And the Analytics page itself renders the same content.
  await f.page.goto('/analytics');
  await expect(f.page.getByText('Execution score', { exact: true })).toBeVisible(); // scores unaffected by gate keys
  expect(f.page.getByText('You completed 1 of 1 scheduled task(s).')).toBeVisible();

  // Untoggle all four back to defaults — still inert.
  const backToDefaults = {
    disableStreaks: WELLBEING_PREFERENCE_DEFAULTS.disableStreaks,
    disableCelebrations: WELLBEING_PREFERENCE_DEFAULTS.disableCelebrations,
    disableSounds: WELLBEING_PREFERENCE_DEFAULTS.disableSounds,
    disableComparativeMetrics: WELLBEING_PREFERENCE_DEFAULTS.disableComparativeMetrics,
  };
  const back = await f.page.request.patch('/api/v1/preferences', { headers: headers(), data: backToDefaults });
  expect(back.status()).toBe(200);
  expect(await summaryOf()).toEqual(before);
  expect(await getPrefs(f.page)).toEqual(WELLBEING_PREFERENCE_DEFAULTS);
});

test('wellbeing preferences are owner-scoped across accounts', async ({ page, playwright }) => {
  const a = await fixture(page, 'wellbeing-owner');
  const patch = await a.page.request.patch('/api/v1/preferences', { headers: headers(), data: { disableScores: true } });
  expect(patch.status()).toBe(200);
  expect(await getPrefs(a.page)).toMatchObject({ disableScores: true });

  // A second account in its own request context (shared context would
  // overwrite the session cookie).
  const b = await playwright.request.newContext({ baseURL: 'http://localhost:3100' });
  try {
    const registered = await b.post('/api/v1/auth/register', {
      headers: { ...origin, 'X-Forwarded-For': '198.51.100.151' },
      data: { email: `wellbeing-other-${randomUUID()}@test.local`, password: 'wellbeing-test-password-123', timeZone: 'UTC' },
    });
    expect(registered.status()).toBe(200);
    const bPrefs = (await (await b.get('/api/v1/preferences')).json()) as WellbeingPreferences;
    expect(bPrefs).toEqual(WELLBEING_PREFERENCE_DEFAULTS);
    const bPatch = await b.patch('/api/v1/preferences', { headers: headers(), data: { disableScores: false } });
    expect(bPatch.status()).toBe(200);
    // A is untouched by B's write.
    expect(await getPrefs(a.page)).toMatchObject({ disableScores: true });
  } finally {
    await b.dispose();
  }
});

test('the Wellbeing card passes axe (wcag2a/wcag2aa) and is keyboard operable', async ({ page }) => {
  const f = await fixture(page, 'wellbeing-axe');
  await f.page.goto('/settings');
  const card = f.page.locator('section[aria-labelledby="wellbeing-heading"]');
  await expect(card).toBeVisible();

  // Keyboard operability: Tab reaches the checkbox, Space toggles it.
  const toggle = f.page.getByLabel('Hide numeric scores', { exact: true });
  await toggle.focus();
  const patchP = f.page.waitForResponse((r) => r.url().endsWith('/api/v1/preferences') && r.request().method() === 'PATCH');
  await toggle.press('Space');
  expect((await patchP).status()).toBe(200);
  expect(await getPrefs(f.page)).toMatchObject({ disableScores: true });
  await toggle.press('Space');
  await f.page.waitForResponse((r) => r.url().endsWith('/api/v1/preferences') && r.request().method() === 'PATCH');
  expect(await getPrefs(f.page)).toMatchObject({ disableScores: false });

  const { default: AxeBuilder } = await import('@axe-core/playwright');
  const results = await new AxeBuilder({ page: f.page }).include('section[aria-labelledby="wellbeing-heading"]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(results.violations).toEqual([]);
});
