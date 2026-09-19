import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, and } from 'drizzle-orm';

/**
 * M8-i3 (PRD §7.9) — route-level guarantees for `GET/PATCH /v1/preferences`
 * and the `disableScores` end-to-end coupling at the HTTP boundary:
 *
 * - 401 unauthenticated, strict six-key contract (unknown key / empty body /
 *   non-boolean rejected with 400),
 * - exact PRD-derived default vector for a fresh user,
 * - idempotent replay of a PATCH (same key + body returns the original
 *   result; one row, one audit record),
 * - `disableScores` through the real tracking summary route: score figures
 *   disappear from the response when enabled (TR-07) and return when
 *   disabled, while the user's own trend data stays present throughout.
 *
 * `/v1/me` is intentionally not touched (locked contract; covered by the
 * sessions/account-sessions suites).
 */

const state = vi.hoisted(() => ({ auth: null as { userId: string; workspaceId: string; sessionId: string } | null }));
vi.mock('../auth', async (original) => {
  const { AppError } = await import('@nextdoo/contracts');
  return {
    ...((await original()) as Record<string, unknown>),
    requireAuth: async () => {
      if (!state.auth) throw new AppError('UNAUTHENTICATED', 'Authentication required.');
      return state.auth;
    },
  };
});
const { WELLBEING_PREFERENCE_DEFAULTS } = await import('@nextdoo/contracts');
const { tasks, trackingResults, userPreferences, auditLogs } = await import('@nextdoo/db');
const { requireTestDatabase } = await import('../../../../../tests/database');
const { getDb } = await import('../db');
const { registerUser } = await import('./accounts');
const { createTask, completeTask } = await import('./tasks');
const preferencesRoute = await import('../../app/api/v1/preferences/route');
const summaryRoute = await import('../../app/api/v1/tracking/summary/route');

await requireTestDatabase();
const db = getDb();

const TODAY = new Date().toISOString().slice(0, 10); // live window: result rows are stamped `now`

beforeAll(async () => {
  const u = await registerUser({ email: `prefs-route-${randomUUID()}@test.local`, name: null, passwordHash: 'test-not-login', timeZone: 'UTC' });
  state.auth = { userId: u.id, workspaceId: u.workspaceId, sessionId: randomUUID() };
});

const get = (path: string) => new Request(`http://localhost${path}`, { method: 'GET' });
const patch = (path: string, body: unknown, key?: string) =>
  new Request(`http://localhost${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost', ...(key ? { 'Idempotency-Key': key } : {}) },
    body: JSON.stringify(body),
  });

describe('GET/PATCH /v1/preferences (M8-i3)', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const saved = state.auth;
    state.auth = null;
    try {
      expect((await preferencesRoute.GET(get('/api/v1/preferences'))).status).toBe(401);
      expect((await preferencesRoute.PATCH(patch('/api/v1/preferences', { disableScores: true }))).status).toBe(401);
    } finally {
      state.auth = saved;
    }
  });

  it('returns the exact PRD-derived default vector and rejects malformed patches', async () => {
    const fresh = await registerUser({ email: `prefs-fresh-${randomUUID()}@test.local`, name: null, passwordHash: 'test-not-login', timeZone: 'UTC' });
    const saved = state.auth;
    state.auth = { userId: fresh.id, workspaceId: fresh.workspaceId, sessionId: randomUUID() };
    try {
      const res = await preferencesRoute.GET(get('/api/v1/preferences'));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(WELLBEING_PREFERENCE_DEFAULTS);

      for (const body of [{ disableBogus: true }, {}, { disableScores: 'yes' }, { disableStreaks: 1 }]) {
        const bad = await preferencesRoute.PATCH(patch('/api/v1/preferences', body));
        expect(bad.status).toBe(400);
        expect((await bad.json()).code).toBe('VALIDATION_FAILED');
      }
      expect(await db.select().from(userPreferences).where(eq(userPreferences.userId, fresh.id))).toHaveLength(0);
    } finally {
      state.auth = saved;
    }
  });

  it('applies a strict partial patch and replays it idempotently (one row, one audit)', async () => {
    const key = randomUUID();
    const first = await preferencesRoute.PATCH(patch('/api/v1/preferences', { disableScores: true }, key));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ...WELLBEING_PREFERENCE_DEFAULTS, disableScores: true });

    const replay = await preferencesRoute.PATCH(patch('/api/v1/preferences', { disableScores: true }, key));
    expect(replay.status).toBe(200);
    expect(replay.headers.get('Idempotent-Replay')).toBe('true');
    expect(await replay.json()).toEqual({ ...WELLBEING_PREFERENCE_DEFAULTS, disableScores: true });

    const rows = await db.select().from(userPreferences).where(eq(userPreferences.userId, state.auth!.userId));
    expect(rows.map((r) => r.key)).toEqual(['disableScores']);
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.action, 'account.preferences_updated'));
    expect(audits.filter((r) => r.actorId === state.auth!.userId)).toHaveLength(1);
  });
});

describe('disableScores end-to-end through the real summary route (TR-07)', () => {
  let taskId: string;
  let savedAuth: { userId: string; workspaceId: string; sessionId: string } | null;

  beforeAll(async () => {
    // Dedicated user: the earlier patch/replay tests already wrote this
    // suite's shared user's preferences, and this flow must start from
    // defaults.
    savedAuth = state.auth;
    const scoreUser = await registerUser({ email: `prefs-scores-${randomUUID()}@test.local`, name: null, passwordHash: 'test-not-login', timeZone: 'UTC' });
    state.auth = { userId: scoreUser.id, workspaceId: scoreUser.workspaceId, sessionId: randomUUID() };
    const actor = { userId: state.auth!.userId, workspaceId: state.auth!.workspaceId } as const;
    const task = await createTask(actor, {
      workspaceId: state.auth!.workspaceId,
      title: 'Prefs route measured task',
      priority: 'NONE',
      tagIds: [],
      dueAt: new Date().toISOString(),
      estimateMinutes: 60,
    });
    await db.update(tasks).set({ actualMinutes: 90 }).where(eq(tasks.id, task.id));
    await completeTask(actor, task.id, task.version, new Date().toISOString());
    await new Promise((r) => setTimeout(r, 300)); // let the best-effort evaluation settle
    await db.insert(trackingResults).values({
      id: randomUUID(),
      workspaceId: state.auth!.workspaceId,
      taskId: task.id,
      occurrenceKey: `prefs-${task.id.slice(0, 8)}`,
      score: '90',
      outcome: 'LATE',
      components: [{ key: 'timing', value: 76, weight: 0.25, measured: true, reason: 'late' }],
      explanation: 'prefs route fixture',
      measuredWeight: '0.25',
      calculationVersion: 1,
      inputHash: 'c'.repeat(64),
    });
    taskId = task.id;
  });

  afterAll(() => {
    state.auth = savedAuth;
  });

  const summaryUrl = () => `http://localhost/api/v1/tracking/summary?workspaceId=${state.auth!.workspaceId}&period=day&date=${TODAY}`;

  it('strips score figures when enabled and restores them when disabled, keeping own trend data', async () => {
    const before = (await (await summaryRoute.GET(get(summaryUrl()))).json()) as Record<string, unknown> & {
      scoresEnabled: boolean;
      averageScore?: number | null;
      days: Array<Record<string, unknown>>;
    };
    expect(before.scoresEnabled).toBe(true);
    expect(before.averageScore).not.toBeNull();
    expect(before.days[0]!.score).not.toBeNull();
    expect(before.days[0]!.plannedMinutes).toBe(60);

    // Stored results are the substrate: they must be untouched by the toggle.
    const resultRows = () =>
      db.select({ score: trackingResults.score }).from(trackingResults).where(and(eq(trackingResults.workspaceId, state.auth!.workspaceId), eq(trackingResults.taskId, taskId)));
    const stored = await resultRows();

    const on = await preferencesRoute.PATCH(patch('/api/v1/preferences', { disableScores: true }, randomUUID()));
    expect(on.status).toBe(200);
    const off = (await (await summaryRoute.GET(get(summaryUrl()))).json()) as typeof before;
    expect(off.scoresEnabled).toBe(false);
    expect('averageScore' in off).toBe(false); // stripped, not nulled
    expect('score' in off.days[0]!).toBe(false);
    expect(off.days[0]!.plannedMinutes).toBe(60); // own trend data intact
    expect(await resultRows()).toEqual(stored);

    const back = await preferencesRoute.PATCH(patch('/api/v1/preferences', { disableScores: false }, randomUUID()));
    expect(back.status).toBe(200);
    const restored = (await (await summaryRoute.GET(get(summaryUrl()))).json()) as typeof before;
    expect(restored.scoresEnabled).toBe(true);
    expect(restored.averageScore).not.toBeNull();
    expect(restored.days[0]!.score).not.toBeNull();
    expect(await resultRows()).toEqual(stored);
  });

  it('a second user is unaffected by the first user\'s preference (owner scoping at the route)', async () => {
    const other = await registerUser({ email: `prefs-other-${randomUUID()}@test.local`, name: null, passwordHash: 'test-not-login', timeZone: 'UTC' });
    const saved = state.auth;
    state.auth = { userId: other.id, workspaceId: other.workspaceId, sessionId: randomUUID() };
    try {
      const res = await preferencesRoute.GET(get('/api/v1/preferences'));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(WELLBEING_PREFERENCE_DEFAULTS); // own defaults, incl. scores shown
      expect(await db.select().from(userPreferences).where(eq(userPreferences.userId, other.id))).toHaveLength(0);
    } finally {
      state.auth = saved;
    }
  });
});
