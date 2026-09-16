import { describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';

/**
 * PRD §7.9 Wellbeing Controls (M8-i3) — service-level guarantees for the
 * six per-user preference keys:
 *
 * - the exact PRD-derived default vector (streaks on, celebrations off,
 *   comparisons absent in MVP; scores/sounds/overload shown),
 * - strict partial updates (only provided keys change), idempotent upserts,
 * - audit records naming exactly the changed `preferences.*` fields,
 * - owner scoping across accounts,
 * - zero planning-data mutation from any preference write,
 * - the `disableScores` control wiring (TR-07): the scoresEnabled reader,
 *   the task tracking detail, and the stored tracking_results rows,
 * - forward-gate keys are inert: they persist/audit but change no analytics
 *   figures, and `disableComparativeMetrics` never touches the user's own
 *   trend reporting (§7.8).
 */

await (await import('../../../../../tests/database')).requireTestDatabase();

const { getDb } = await import('../db');
const { hashPassword } = await import('../auth');
const { registerUser } = await import('./accounts');
const { getWellbeingPreferences, setWellbeingPreferences } = await import('./preferences');
const { scoresEnabled } = await import('./tracking-freshness');
const { getSummary } = await import('./tracking');
const { getTrackingDetail } = await import('./tracking-history');
const { createTask, completeTask } = await import('./tasks');

const db = getDb();
const { auditLogs, tasks, trackingResults, userPreferences } = await import('@nextdoo/db');
const { randomUUID } = await import('node:crypto');

const PASSWORD = 'preferences-test-password-1';
const DAY = '2026-09-08'; // fixed window (Tuesday in a Monday-start week); no clock drift

/** PRD-derived default vector — the shape a fresh user must always get. */
const DEFAULTS = {
  disableScores: false,
  disableStreaks: false,
  disableCelebrations: true,
  disableSounds: false,
  disableComparativeMetrics: true,
  disableOverloadWarnings: false,
};

async function newAccount() {
  return registerUser({
    email: `prefs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`,
    passwordHash: await hashPassword(PASSWORD),
    name: 'Preferences Test',
    timeZone: 'UTC',
  });
}

async function auditRows(userId: string, action: string) {
  const rows = await db.select().from(auditLogs).where(eq(auditLogs.action, action));
  return rows.filter((r) => r.actorId === userId);
}

async function prefRows(userId: string) {
  return db.select().from(userPreferences).where(eq(userPreferences.userId, userId));
}

async function measuredTask(account: { id: string; workspaceId: string }) {
  const actor = { userId: account.id, workspaceId: account.workspaceId } as const;
  const task = await createTask(actor, {
    workspaceId: account.workspaceId,
    title: 'Prefs measured task',
    priority: 'NONE',
    tagIds: [],
    dueAt: `${DAY}T12:00:00Z`,
    estimateMinutes: 60,
  });
  await db.update(tasks).set({ actualMinutes: 90 }).where(eq(tasks.id, task.id));
  await completeTask(actor, task.id, task.version, `${DAY}T12:30:00Z`);
  // Let the best-effort fast-path evaluation settle so snapshots are stable.
  await new Promise((r) => setTimeout(r, 300));
  // A stored result with a real score (deterministic for the detail assertions).
  await db.insert(trackingResults).values({
    id: randomUUID(),
    workspaceId: account.workspaceId,
    taskId: task.id,
    occurrenceKey: `prefs-${task.id.slice(0, 8)}`,
    score: '90',
    outcome: 'LATE',
    components: [{ key: 'timing', value: 76, weight: 0.25, measured: true, reason: 'late' }],
    explanation: 'prefs fixture',
    measuredWeight: '0.25',
    calculationVersion: 1,
    inputHash: 'c'.repeat(64),
  });
  return task;
}

describe('preferences service (§7.9, M8-i3)', () => {
  it('defaults to the exact PRD-derived six-key vector (streaks on, celebrations off, comparisons absent)', async () => {
    const account = await newAccount();
    expect(await getWellbeingPreferences(account.id)).toEqual(DEFAULTS);
    expect(await prefRows(account.id)).toHaveLength(0); // no rows: defaults are computed, not stored
  });

  it('partial patches change only the provided keys and audit exactly those fields', async () => {
    const account = await newAccount();
    const after = await setWellbeingPreferences(account.id, { disableScores: true });
    expect(after).toEqual({ ...DEFAULTS, disableScores: true });

    const rows = await prefRows(account.id);
    expect(rows.map((r) => r.key)).toEqual(['disableScores']);
    expect(rows[0]!.value).toBe(true);
    expect(await auditRows(account.id, 'account.preferences_updated')).toHaveLength(1);

    const multi = await setWellbeingPreferences(account.id, { disableStreaks: true, disableComparativeMetrics: false });
    expect(multi).toEqual({ ...DEFAULTS, disableScores: true, disableStreaks: true, disableComparativeMetrics: false });
    expect((await prefRows(account.id)).map((r) => r.key)).toEqual(['disableScores', 'disableStreaks', 'disableComparativeMetrics']);
    const audits = await auditRows(account.id, 'account.preferences_updated');
    expect(audits).toHaveLength(2);
    expect(audits[0]!.metadata).toMatchObject({ fields: ['preferences.disableScores'] });
    expect(audits[1]!.metadata).toMatchObject({
      fields: ['preferences.disableStreaks', 'preferences.disableComparativeMetrics'],
    });

    // Toggling back to the default is a real upsert (row kept with false), no duplicates.
    const back = await setWellbeingPreferences(account.id, { disableStreaks: false });
    expect(back.disableStreaks).toBe(false);
    expect((await prefRows(account.id)).filter((r) => r.key === 'disableStreaks')).toHaveLength(1);
  });

  it('an empty patch writes no rows and no audit record', async () => {
    const account = await newAccount();
    const after = await setWellbeingPreferences(account.id, {});
    expect(after).toEqual(DEFAULTS);
    expect(await prefRows(account.id)).toHaveLength(0);
    expect(await auditRows(account.id, 'account.preferences_updated')).toHaveLength(0);
  });

  it('is owner-scoped: a second user keeps their own defaults and rows', async () => {
    const a = await newAccount();
    const b = await newAccount();
    await setWellbeingPreferences(a.id, { disableScores: true, disableCelebrations: false });

    expect(await getWellbeingPreferences(b.id)).toEqual(DEFAULTS);
    expect(await prefRows(b.id)).toHaveLength(0);

    await setWellbeingPreferences(b.id, { disableScores: false });
    expect(await getWellbeingPreferences(a.id)).toEqual({ ...DEFAULTS, disableScores: true, disableCelebrations: false });
    expect(await getWellbeingPreferences(b.id)).toEqual(DEFAULTS);
  });

  it('preference writes mutate zero planning data', async () => {
    const account = await newAccount();
    const actor = { userId: account.id, workspaceId: account.workspaceId } as const;
    await createTask(actor, { workspaceId: account.workspaceId, title: 'Prefs planning task', priority: 'NONE', tagIds: [], dueAt: `${DAY}T10:00:00Z` });
    const snapshot = () => Promise.all([
      db.select({ n: sql<number>`count(*)` }).from(sql.raw('tasks')).where(sql`workspace_id=${account.workspaceId}`),
      db.select({ n: sql<number>`count(*)` }).from(sql.raw('tracking_events')).where(sql`workspace_id=${account.workspaceId}`),
      db.select({ n: sql<number>`count(*)` }).from(sql.raw('tracking_results')).where(sql`workspace_id=${account.workspaceId}`),
      db.select({ n: sql<number>`count(*)` }).from(sql.raw('reminders')).where(sql`workspace_id=${account.workspaceId}`),
      db.select({ n: sql<number>`count(*)` }).from(sql.raw('sync_changes')).where(sql`workspace_id=${account.workspaceId}`),
    ]).then((rows) => rows.map((r) => Number(r[0]!.n)));

    const before = await snapshot();
    await setWellbeingPreferences(account.id, { disableScores: true, disableStreaks: true, disableSounds: true });
    expect(await snapshot()).toEqual(before);
    expect((await prefRows(account.id)).map((r) => r.key).sort()).toEqual(['disableScores', 'disableSounds', 'disableStreaks']);
  });

  it('disableScores is a display control (TR-07): detail omits the result, stored rows stay untouched, re-enable restores', async () => {
    const account = await newAccount();
    const actor = { userId: account.id, workspaceId: account.workspaceId } as const;
    const task = await measuredTask(account);
    expect(await scoresEnabled(account.id)).toBe(true);

    const resultRows = () =>
      db.select({ score: trackingResults.score }).from(trackingResults).where(and(eq(trackingResults.workspaceId, account.workspaceId), eq(trackingResults.taskId, task.id)));
    // `completeTask` may leave a best-effort engine row alongside the
    // deterministic fixture row — both must survive the toggle untouched.
    const before = await resultRows();
    expect(before.length).toBeGreaterThanOrEqual(1);
    // `score` is a numeric column: the fixture row reads back as '90.0'.
    expect(before.map((r) => r.score)).toContain('90.0');

    // Disabled: the detail payload is the 403-free empty shape; the summary
    // window data (individual trend reporting) is still fully present.
    await setWellbeingPreferences(account.id, { disableScores: true });
    expect(await scoresEnabled(account.id)).toBe(false);
    expect(await getTrackingDetail(actor, task.id)).toMatchObject({ scoresEnabled: false, result: null, events: [], history: [] });
    const summaryOff = await getSummary(account.workspaceId, 'day', `${DAY}`);
    expect(summaryOff.days).toHaveLength(1);
    expect(summaryOff.days[0]!.plannedMinutes).toBe(60);
    expect(summaryOff.insights.length).toBeGreaterThan(0); // own history/trends survive
    expect(await resultRows()).toEqual(before); // stored results untouched

    // Re-enabled: the stored result comes back from the same rows.
    await setWellbeingPreferences(account.id, { disableScores: false });
    expect(await scoresEnabled(account.id)).toBe(true);
    const detail = await getTrackingDetail(actor, task.id);
    expect(detail.scoresEnabled).toBe(true);
    expect(detail.result).toMatchObject({ score: 90 });
    expect(await resultRows()).toEqual(before);
  });

  it('disableComparativeMetrics never hides the user\'s own trend reporting', async () => {
    const account = await newAccount();
    await measuredTask(account);
    const summaryOn = await getSummary(account.workspaceId, 'day', DAY);

    // The key defaults to true (comparisons absent in MVP); exercise both values.
    for (const value of [false, true]) {
      await setWellbeingPreferences(account.id, { disableComparativeMetrics: value });
      const summary = await getSummary(account.workspaceId, 'day', DAY);
      expect(summary.days).toEqual(summaryOn.days); // identical own-trend figures
      expect(summary.insights).toEqual(summaryOn.insights);
      expect(summary.averageScore === summaryOn.averageScore || (summary.averageScore === null && summaryOn.averageScore === null)).toBe(true);
    }
  });
});
