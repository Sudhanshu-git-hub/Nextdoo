import { describe, expect, it, vi } from 'vitest';
import { and, eq, isNotNull } from 'drizzle-orm';
import type { CalendarTokenSet } from '@nextdoo/contracts';
import { dedicatedDatabase } from '../../../tests/dedicated-database';

/**
 * M7 — the `calendar.sync` worker cycle (PRD §12.4): 60-second export pass,
 * 10-minute import cadence, channel renewal, retention sweep, and the
 * pause-after-5-consecutive-failures rule. The provider is injected
 * (deterministic fixture); the real Google adapter is never networked here.
 */

const dedicated = await dedicatedDatabase('nextdoo_calendar_sync_worker');
process.env.DATABASE_URL = dedicated.url;
process.env.AUTH_SECRET = 'test-only-secret-0123456789abcdefghij';
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;

const { JOBS, openCalendarTokens, sealCalendarTokens } = await import('./jobs');
const { createDb, openSecret, sealSecret } = await import('@nextdoo/db');
const {
  calendarConnections,
  calendarEvents,
  calendarMappings,
  calendarOauthStates,
  notifications,
  runCalendarSyncCycle,
  tasks,
  users,
  workspaces,
} = await import('@nextdoo/db');
const { FixtureCalendarProvider } = await import('@nextdoo/calendar');
type FixtureProvider = InstanceType<typeof FixtureCalendarProvider>;

const db = createDb(dedicated.url).db;

function mkProvider(events: Array<{ externalId: string; title: string; startsAt: string; endsAt: string }> = []) {
  const provider = new FixtureCalendarProvider({
    tokens: { accessToken: 'fx-at', refreshToken: 'fx-rt', expiresAt: new Date(Date.now() + 3600_000).toISOString(), scopes: null },
    events,
  });
  return provider;
}

async function seedConnection(provider: FixtureProvider, opts: { mode?: string; lastSyncedAt?: Date | null } = {}) {
  const [userRow] = await db.insert(users).values({ id: crypto.randomUUID(), email: `calworker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`, passwordHash: 'scrypt$deadbeef$deadbeef', name: 'Worker', timeZone: 'UTC' }).returning();
  const user = userRow!;
  const [workspaceRow] = await db.insert(workspaces).values({ id: crypto.randomUUID(), ownerId: user.id, name: 'W' }).returning();
  const workspace = workspaceRow!;
  const [connRow] = await db
    .insert(calendarConnections)
    .values({
      id: crypto.randomUUID(),
      userId: user.id,
      workspaceId: workspace.id,
      provider: 'google',
      status: 'ACTIVE',
      mode: opts.mode ?? 'READ_WRITE',
      accessTokenEncrypted: 'v1.seeded.seeded.seeded',
      lastSyncedAt: opts.lastSyncedAt ?? null,
    })
    .returning();
  void provider;
  return { user, workspace, conn: connRow! };
}

async function seedTask(workspaceId: string, title: string, dueInMs: number) {
  const [task] = await db.insert(tasks).values({ id: crypto.randomUUID(), workspaceId, title, dueAt: new Date(Date.now() + dueInMs), status: 'ACTIVE' }).returning();
  return task!;
}

describe('calendar.sync worker cycle (integration)', () => {
  it('is registered at the 60s cadence', () => {
    const job = JOBS.find((j) => j.name === 'calendar.sync');
    expect(job).toBeTruthy();
    expect(job!.intervalMs).toBe(60_000);
  });

  it('is a cheap no-op when the provider is unconfigured (no credentials)', async () => {
    await seedConnection(mkProvider());
    const result = await runCalendarSyncCycle(db, { providerFor: () => null });
    expect(result.connections).toBe(1);
    expect(result.imported).toBe(0);
    expect(result.exported).toBe(0);
  });

  it('exports every cycle, imports on the 10-minute cadence, and renews the channel', async () => {
    const provider = mkProvider([
      { externalId: 'ext-w1', title: 'Standup', startsAt: new Date(Date.now() + 3_600_000).toISOString(), endsAt: new Date(Date.now() + 3_900_000).toISOString() },
    ]);
    const { workspace, conn } = await seedConnection(provider, { lastSyncedAt: new Date(Date.now() - 30 * 60_000) }); // import due
    await seedTask(workspace.id, 'Report to boss', 4 * 3_600_000);

    // Cycle 1: export (1 created) + import (1 event, due) + channel renewal.
    const r1 = await runCalendarSyncCycle(db, {
      providerFor: (row) => (row.id === conn.id ? provider : null),
      webhookTarget: 'http://localhost:3100/api/v1/calendar/webhook',
    });
    expect(r1.exported).toBe(1);
    // Import mirrors the provider state: the external 'Standup' plus the
    // exported event (its mirror carries the etag for later patches).
    expect(r1.imported).toBe(2);
    let [row] = await db.select().from(calendarConnections).where(eq(calendarConnections.id, conn.id));
    expect(row!.channelExpiresAt).toBeInstanceOf(Date);
    expect(row!.channelExpiresAt!.getTime() > Date.now()).toBe(true);

    // Cycle 2 (immediately): export is idempotent, import is NOT due (lastSyncedAt just advanced).
    const r2 = await runCalendarSyncCycle(db, {
      providerFor: (row) => (row.id === conn.id ? provider : null),
      webhookTarget: 'http://localhost:3100/api/v1/calendar/webhook',
    });
    expect(r2.exported).toBe(0);
    [row] = await db.select().from(calendarConnections).where(eq(calendarConnections.id, conn.id));
    const syncedThrough = row!.lastSyncedAt!;
    expect(syncedThrough.getTime() > Date.now() - 5_000).toBe(true);

    // After the 10-minute cadence, import runs again (2 mirrors, unchanged).
    await db.update(calendarConnections).set({ lastSyncedAt: new Date(Date.now() - 11 * 60_000) }).where(eq(calendarConnections.id, conn.id));
    const r3 = await runCalendarSyncCycle(db, { providerFor: (row) => (row.id === conn.id ? provider : null) });
    expect(r3.imported).toBe(2);

    // The exported event and its mapping exist exactly once.
    const mappings = await db.select().from(calendarMappings).where(eq(calendarMappings.connectionId, conn.id));
    expect(mappings).toHaveLength(1);
    const events = await db.select().from(calendarEvents).where(eq(calendarEvents.connectionId, conn.id));
    expect(events).toHaveLength(2); // external 'Standup' + exported 'Report to boss'
    expect([...provider.store.values()].filter((e) => !e.deleted)).toHaveLength(2);
  });

  it('pauses with a reconnect prompt on auth failure (PRD §16.6)', async () => {
    const provider = mkProvider();
    provider.markRevoked();
    const { conn } = await seedConnection(provider);
    const result = await runCalendarSyncCycle(db, { providerFor: (row) => (row.id === conn.id ? provider : null) });
    expect(result.paused).toBe(1);
    const [row] = await db.select().from(calendarConnections).where(eq(calendarConnections.id, conn.id));
    expect(row!.status).toBe('SUSPENDED');
    expect(row!.pauseReason).toBeTruthy();
  });

  it('counts generic failures and pauses+notifies at 5 consecutive (PRD §12.4)', async () => {
    const { conn } = await seedConnection(mkProvider());
    const failing = new FixtureCalendarProvider({
      tokens: { accessToken: 'fx-at', refreshToken: 'fx-rt', expiresAt: new Date(Date.now() + 3600_000).toISOString(), scopes: null },
    });
    // Every operation throws a generic transport error.
    const boom = { ...failing };
    for (const method of ['ensureAccessToken', 'listChanges', 'writeEvent', 'deleteEvent', 'ensureChannel', 'getEvent'] as const) {
      (boom as Record<string, unknown>)[method] = async () => {
        throw new Error('connection reset');
      };
    }
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const result = await runCalendarSyncCycle(db, { providerFor: (row) => (row.id === conn.id ? (boom as unknown as FixtureProvider) : null) });
      expect(result.paused).toBe(0);
      const [row] = await db.select().from(calendarConnections).where(eq(calendarConnections.id, conn.id));
      expect(row!.consecutiveFailures).toBe(attempt);
      expect(row!.status).toBe('ACTIVE');
    }
    const final = await runCalendarSyncCycle(db, { providerFor: (row) => (row.id === conn.id ? (boom as unknown as FixtureProvider) : null) });
    expect(final.paused).toBe(1);
    const [row] = await db.select().from(calendarConnections).where(eq(calendarConnections.id, conn.id));
    expect(row!.status).toBe('SUSPENDED');
    expect(row!.pauseReason).toBe('SYNC_FAILED');
    const notes = await db.select().from(notifications).where(eq(notifications.userId, row!.userId));
    expect(notes.some((n) => n.type === 'calendar')).toBe(true);
  });

  it('sweeps expired OAuth states and 30-day post-disconnect retention', async () => {
    const provider = mkProvider();
    const { workspace, conn } = await seedConnection(provider, { lastSyncedAt: new Date() });
    const task = await seedTask(workspace.id, 'Mapped', 5 * 3_600_000);
    await db.insert(calendarMappings).values({
      id: crypto.randomUUID(),
      connectionId: conn.id,
      taskId: task.id,
      externalId: 'ext-keep',
      calendarId: 'primary',
      syncState: 'SYNCED',
    });
    await db.insert(calendarEvents).values({
      id: crypto.randomUUID(),
      connectionId: conn.id,
      workspaceId: workspace.id,
      externalId: 'ext-keep',
      calendarId: 'primary',
      title: 'Mapped',
      startsAt: task.dueAt!,
      endsAt: new Date(task.dueAt!.getTime() + 3_600_000),
      isAllDay: false,
      busy: true,
    });
    const [state] = await db
      .insert(calendarOauthStates)
      .values({ stateHash: 'deadbeef'.repeat(8), userId: conn.userId, workspaceId: workspace.id, mode: 'READ_ONLY', codeVerifier: 'v', expiresAt: new Date(Date.now() - 60_000) })
      .returning();

    const before = await runCalendarSyncCycle(db, { providerFor: (row) => (row.id === conn.id ? provider : null) });
    expect(before.retention.states).toBe(1);
    expect(before.retention.mappings).toBe(0); // not disconnected
    expect(state).toBeTruthy();

    // Disconnect 31 days ago → mappings + event mirrors are purged; the task survives.
    await db.update(calendarConnections).set({ status: 'DISCONNECTED', disconnectedAt: new Date(Date.now() - 31 * 86_400_000), accessTokenEncrypted: null }).where(eq(calendarConnections.id, conn.id));
    const after = await runCalendarSyncCycle(db, { providerFor: (row) => (row.id === conn.id ? provider : null) });
    expect(after.retention.mappings).toBe(1);
    expect(after.retention.events).toBe(1);
    const [taskStill] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(taskStill!.dueAt).not.toBeNull();
    // Nothing of another connection's data was touched.
    const other = await db.select().from(calendarMappings).where(and(eq(calendarMappings.connectionId, conn.id)));
    expect(other).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* M8-i4 — T1 (token re-seal/rotation), T4 (rate-limit backoff across  */
/* cycles, migration 0023), T6a (rate-limited job log line). Same      */
/* fixture-provider discipline as the M7 suite: deterministic, zero    */
/* network.                                                            */
/* ------------------------------------------------------------------ */

const M8_AUTH = 'test-only-secret-0123456789abcdefghij';
const M8_PURPOSE = 'calendar_token';

/**
 * A fixture provider with an explicit initial token set. `expiresAt: null`
 * never refreshes (the "unchanged" path); a past expiry forces a refresh on
 * first use. With `rotate`, the refresh also re-issues the refresh token.
 */
function tokenProvider(opts: { expired?: boolean; rotate?: boolean } = {}) {
  return new FixtureCalendarProvider({
    tokens: {
      accessToken: 'worker-at-0',
      refreshToken: 'worker-rt-0',
      expiresAt: opts.expired ? new Date(Date.now() - 1000).toISOString() : null,
      scopes: null,
    },
    rotateOnRefresh: opts.rotate ?? false,
  });
}

/**
 * Seeds an ACTIVE connection whose stored credentials are REAL sealed
 * envelopes of the provider's initial tokens — so `openCalendarTokens` (the
 * production worker seam) opens them back into the same token set.
 */
async function seedSealedConnection(provider: FixtureProvider) {
  const [userRow] = await db.insert(users).values({ id: crypto.randomUUID(), email: `calworker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`, passwordHash: 'scrypt$deadbeef$deadbeef', name: 'Worker', timeZone: 'UTC' }).returning();
  const user = userRow!;
  const [workspaceRow] = await db.insert(workspaces).values({ id: crypto.randomUUID(), ownerId: user.id, name: 'W' }).returning();
  const workspace = workspaceRow!;
  const t = provider.currentTokens();
  const [connRow] = await db
    .insert(calendarConnections)
    .values({
      id: crypto.randomUUID(),
      userId: user.id,
      workspaceId: workspace.id,
      provider: 'google',
      status: 'ACTIVE',
      mode: 'READ_WRITE',
      accessTokenEncrypted: sealSecret(t.accessToken, M8_AUTH, M8_PURPOSE),
      refreshTokenEncrypted: t.refreshToken ? sealSecret(t.refreshToken, M8_AUTH, M8_PURPOSE) : null,
      tokenExpiresAt: t.expiresAt ? new Date(t.expiresAt) : null,
      scopes: t.scopes ?? null,
      lastSyncedAt: new Date(Date.now() - 30 * 60_000), // import due
    })
    .returning();
  return { user, workspace, conn: connRow! };
}

async function connRow(id: string) {
  const [row] = await db.select().from(calendarConnections).where(eq(calendarConnections.id, id)).limit(1);
  return row!;
}

function countingSeal(): { count: { n: number }; fn: (row: { id: string }, tokens: CalendarTokenSet) => Promise<void> } {
  const count = { n: 0 };
  return {
    count,
    fn: async (row, tokens) => {
      count.n += 1;
      await sealCalendarTokens(row, tokens);
    },
  };
}

describe('M8-i4 T1 — the worker cycle re-seals refreshed/rotated tokens', () => {
  it('persists the refreshed access token (re-sealed, not plaintext)', async () => {
    const provider = tokenProvider({ expired: true, rotate: true });
    const { conn } = await seedSealedConnection(provider);
    const result = await runCalendarSyncCycle(db, {
      providerFor: (row) => (row.id === conn.id ? provider : null),
      tokensFor: openCalendarTokens,
      sealTokens: sealCalendarTokens,
    });
    expect(result.tokenUpdates).toBe(1);
    expect(provider.calls.some((c) => c.op === 'refresh')).toBe(true);
    const row = await connRow(conn.id);
    const opened = openSecret(row.accessTokenEncrypted!, M8_AUTH, M8_PURPOSE);
    expect(opened).toBe('fixture-access-1'); // the refreshed token, not the original
    expect(opened).not.toBe('worker-at-0');
  });

  it('a rotated refresh token REPLACES the old one in storage', async () => {
    const provider = tokenProvider({ expired: true, rotate: true });
    const { conn } = await seedSealedConnection(provider);
    await runCalendarSyncCycle(db, {
      providerFor: (row) => (row.id === conn.id ? provider : null),
      tokensFor: openCalendarTokens,
      sealTokens: sealCalendarTokens,
    });
    const row = await connRow(conn.id);
    expect(openSecret(row.refreshTokenEncrypted!, M8_AUTH, M8_PURPOSE)).toBe('fixture-refresh-1');
  });

  it('stores re-sealed tokens only as sealed envelopes (no plaintext at rest)', async () => {
    const provider = tokenProvider({ expired: true, rotate: true });
    const { conn } = await seedSealedConnection(provider);
    await runCalendarSyncCycle(db, {
      providerFor: (row) => (row.id === conn.id ? provider : null),
      tokensFor: openCalendarTokens,
      sealTokens: sealCalendarTokens,
    });
    const row = await connRow(conn.id);
    expect(row.accessTokenEncrypted).toMatch(/^v1\./);
    expect(row.accessTokenEncrypted).not.toContain('fixture-access-1');
    expect(row.refreshTokenEncrypted).toMatch(/^v1\./);
    expect(row.refreshTokenEncrypted).not.toContain('fixture-refresh-1');
  });

  it('preserves the expiry metadata of the refreshed set', async () => {
    const provider = tokenProvider({ expired: true, rotate: true });
    const { conn } = await seedSealedConnection(provider);
    const before = await connRow(conn.id);
    await runCalendarSyncCycle(db, {
      providerFor: (row) => (row.id === conn.id ? provider : null),
      tokensFor: openCalendarTokens,
      sealTokens: sealCalendarTokens,
    });
    const after = await connRow(conn.id);
    expect(after.tokenExpiresAt).toBeInstanceOf(Date);
    expect(after.tokenExpiresAt!.getTime() > Date.now()).toBe(true); // the fresh 1h expiry
    expect(after.tokenExpiresAt!.getTime()).not.toBe(before.tokenExpiresAt!.getTime());
  });

  it('the NEXT cycle runs with the new credentials and does not re-seal (no redundant token calls)', async () => {
    const provider = tokenProvider({ expired: true, rotate: true });
    const { conn } = await seedSealedConnection(provider);
    await runCalendarSyncCycle(db, {
      providerFor: (row) => (row.id === conn.id ? provider : null),
      tokensFor: openCalendarTokens,
      sealTokens: sealCalendarTokens,
    });
    const resealed = await connRow(conn.id);
    // The worker rebuilds the provider from the DB row on the next cycle:
    const nextTokens = openCalendarTokens(resealed);
    expect(nextTokens).toMatchObject({ accessToken: 'fixture-access-1', refreshToken: 'fixture-refresh-1' });
    expect(nextTokens!.expiresAt).not.toBeNull();
    const provider2 = new FixtureCalendarProvider({ tokens: nextTokens!, rotateOnRefresh: true });
    const { count, fn } = countingSeal();
    const r2 = await runCalendarSyncCycle(db, {
      providerFor: (row) => (row.id === conn.id ? provider2 : null),
      tokensFor: openCalendarTokens,
      sealTokens: fn,
    });
    expect(r2.tokenUpdates).toBe(0);
    expect(count.n).toBe(0); // unchanged set → zero seal writes
    expect(provider2.calls.some((c) => c.op === 'refresh')).toBe(false); // no redundant refresh
    const still = await connRow(conn.id);
    expect(still.accessTokenEncrypted).toBe(resealed.accessTokenEncrypted); // byte-identical
    expect(still.refreshTokenEncrypted).toBe(resealed.refreshTokenEncrypted);
  });

  it('an unchanged token set causes no re-seal write at all', async () => {
    const provider = tokenProvider({}); // valid, never-expiring tokens
    const { conn } = await seedSealedConnection(provider);
    const before = await connRow(conn.id);
    const { count, fn } = countingSeal();
    const result = await runCalendarSyncCycle(db, {
      providerFor: (row) => (row.id === conn.id ? provider : null),
      tokensFor: openCalendarTokens,
      sealTokens: fn,
    });
    expect(result.tokenUpdates).toBe(0);
    expect(count.n).toBe(0);
    const after = await connRow(conn.id);
    expect(after.accessTokenEncrypted).toBe(before.accessTokenEncrypted);
    expect(after.refreshTokenEncrypted).toBe(before.refreshTokenEncrypted);
  });

  it('a re-seal is not a failure: no pause, no failure counts, no notification', async () => {
    const provider = tokenProvider({ expired: true, rotate: true });
    const { user, conn } = await seedSealedConnection(provider);
    const result = await runCalendarSyncCycle(db, {
      providerFor: (row) => (row.id === conn.id ? provider : null),
      tokensFor: openCalendarTokens,
      sealTokens: sealCalendarTokens,
    });
    expect(result.tokenUpdates).toBe(1);
    expect(result.paused).toBe(0);
    expect(result.failed).toBe(0);
    const row = await connRow(conn.id);
    expect(row.status).toBe('ACTIVE');
    expect(row.pauseReason).toBeNull();
    expect(row.consecutiveFailures).toBe(0);
    const notes = await db.select().from(notifications).where(eq(notifications.userId, user.id));
    expect(notes.some((n) => n.type === 'calendar')).toBe(false);
  });

  it('a failed refresh keeps the existing failure semantics (pause, no partial re-seal)', async () => {
    const provider = tokenProvider({ expired: true, rotate: true });
    provider.markRevoked(); // every token op now throws CalendarAuthError
    const { user, conn } = await seedSealedConnection(provider);
    const before = await connRow(conn.id);
    const { count, fn } = countingSeal();
    const result = await runCalendarSyncCycle(db, {
      providerFor: (row) => (row.id === conn.id ? provider : null),
      tokensFor: openCalendarTokens,
      sealTokens: fn,
    });
    expect(result.paused).toBe(1);
    expect(result.tokenUpdates).toBe(0);
    expect(count.n).toBe(0);
    const row = await connRow(conn.id);
    expect(row.status).toBe('SUSPENDED');
    expect(row.pauseReason).toBeTruthy();
    expect(row.accessTokenEncrypted).toBe(before.accessTokenEncrypted); // untouched
    void user;
  });
});

describe('M8-i4 T4 — the 429/403 backoff window persists across worker cycles', () => {
  it('a 429 stores rate_limited_until = now + Retry-After and is a skip, not a failure or pause', async () => {
    await db.update(calendarConnections).set({ rateLimitedUntil: null }).where(isNotNull(calendarConnections.rateLimitedUntil));
    const provider = mkProvider();
    const { user, conn } = await seedConnection(provider);
    provider.setRateLimitCalls(1); // the import's listChanges receives the 429 (7 s)
    const t0 = new Date();
    const result = await runCalendarSyncCycle(db, {
      providerFor: (row) => (row.id === conn.id ? provider : null),
      now: t0,
    });
    expect(result.rateLimited).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.paused).toBe(0);
    const row = await connRow(conn.id);
    expect(row.rateLimitedUntil).toBeInstanceOf(Date);
    expect(row.rateLimitedUntil!.getTime()).toBe(t0.getTime() + 7000); // the fixture's 7 s Retry-After
    expect(row.status).toBe('ACTIVE');
    expect(row.consecutiveFailures).toBe(0);
    const notes = await db.select().from(notifications).where(eq(notifications.userId, user.id));
    expect(notes.some((n) => n.type === 'calendar')).toBe(false);
  });

  it('makes ZERO provider calls while the stored window is in the future (no export, import or renewal)', async () => {
    await db.update(calendarConnections).set({ rateLimitedUntil: null }).where(isNotNull(calendarConnections.rateLimitedUntil));
    const provider = mkProvider();
    const { conn } = await seedConnection(provider);
    provider.setRateLimitCalls(1);
    const t0 = new Date();
    await runCalendarSyncCycle(db, { providerFor: (row) => (row.id === conn.id ? provider : null), now: t0 });
    // 1 s later — still inside the 7 s window:
    const seen: string[] = [];
    const r = await runCalendarSyncCycle(db, {
      providerFor: (row) => {
        seen.push(row.id);
        return row.id === conn.id ? provider : null;
      },
      webhookTarget: 'http://localhost:3100/api/v1/calendar/webhook',
      now: new Date(t0.getTime() + 1000),
    });
    expect(r.rateLimited).toBe(1);
    expect(r.imported).toBe(0);
    expect(r.exported).toBe(0);
    expect(seen).not.toContain(conn.id); // skipped BEFORE the provider is built
    expect(provider.calls).toHaveLength(1); // only the 429'd list from the first cycle
    const row = await connRow(conn.id);
    expect(row.rateLimitedUntil!.getTime()).toBe(t0.getTime() + 7000); // window intact
    expect(row.consecutiveFailures).toBe(0);
    expect(row.status).toBe('ACTIVE');
  });

  it('retries at and after the window expiry, clearing the marker; a new 429 opens a new window', async () => {
    await db.update(calendarConnections).set({ rateLimitedUntil: null }).where(isNotNull(calendarConnections.rateLimitedUntil));
    const provider = mkProvider();
    const { conn } = await seedConnection(provider);
    provider.setRateLimitCalls(1);
    const t0 = new Date();
    await runCalendarSyncCycle(db, { providerFor: (row) => (row.id === conn.id ? provider : null), now: t0 });

    // AT the expiry boundary (now === until) the window is over: the pass runs.
    const seen: string[] = [];
    const rAt = await runCalendarSyncCycle(db, {
      providerFor: (row) => {
        seen.push(row.id);
        return row.id === conn.id ? provider : null;
      },
      now: new Date(t0.getTime() + 7000),
    });
    expect(seen).toContain(conn.id);
    expect(rAt.rateLimited).toBe(0);
    let row = await connRow(conn.id);
    expect(row.rateLimitedUntil).toBeNull(); // cleared before the pass ran

    // A SECOND 429 (import due again) opens a fresh window from the new now.
    await db.update(calendarConnections).set({ lastSyncedAt: new Date(t0.getTime() + 7000 - 30 * 60_000) }).where(eq(calendarConnections.id, conn.id));
    provider.setRateLimitCalls(1);
    const t1 = new Date(t0.getTime() + 7000);
    const r2 = await runCalendarSyncCycle(db, { providerFor: (row) => (row.id === conn.id ? provider : null), now: t1 });
    expect(r2.rateLimited).toBe(1);
    row = await connRow(conn.id);
    expect(row.rateLimitedUntil!.getTime()).toBe(t1.getTime() + 7000);
  });

  it('a concurrent 429 never SHRINKS a longer stored window (max-window guard)', async () => {
    const { runCalendarImport } = await import('@nextdoo/db');
    const provider = mkProvider();
    const { conn } = await seedConnection(provider);
    const t0 = new Date();
    // A long stored window, as a previous pass recorded it:
    await db.update(calendarConnections).set({ rateLimitedUntil: new Date(t0.getTime() + 300_000) }).where(eq(calendarConnections.id, conn.id));
    provider.setRateLimitCalls(1);
    // A direct engine pass (e.g. a manual sync) while the window is still in the future:
    const out = await runCalendarImport({ db, connectionId: conn.id, provider, now: t0 });
    expect(out.rateLimitedSeconds).toBe(7);
    const row = await connRow(conn.id);
    // The new 429 wants t0+7 s — SHORTER than the stored t0+300 s → kept, not shrunk.
    expect(row.rateLimitedUntil!.getTime()).toBe(t0.getTime() + 300_000);
  });

  it('keeps connections isolated: one backoff never blocks or pauses the others', async () => {
    await db.update(calendarConnections).set({ rateLimitedUntil: null }).where(isNotNull(calendarConnections.rateLimitedUntil));
    const t0 = new Date();
    const inWindow = (offsetMs: number) => new Date(t0.getTime() + offsetMs).toISOString();
    const pa = mkProvider([{ externalId: 'ext-a', title: 'A event', startsAt: inWindow(3_600_000), endsAt: inWindow(3_900_000) }]);
    const pb = mkProvider([{ externalId: 'ext-b', title: 'B event', startsAt: inWindow(3_600_000), endsAt: inWindow(3_900_000) }]);
    const { conn: connA } = await seedConnection(pa);
    const { conn: connB } = await seedConnection(pb);
    pa.setRateLimitCalls(1);

    const r = await runCalendarSyncCycle(db, {
      providerFor: (row) => (row.id === connA.id ? pa : row.id === connB.id ? pb : null),
      now: t0,
    });
    expect(r.rateLimited).toBe(1);
    // B synced normally in the SAME cycle:
    expect(await db.select().from(calendarEvents).where(eq(calendarEvents.connectionId, connB.id))).toHaveLength(1);
    let rowA = await connRow(connA.id);
    const rowB = await connRow(connB.id);
    expect(rowA.rateLimitedUntil).toBeInstanceOf(Date);
    expect(rowB.rateLimitedUntil).toBeNull();
    expect(rowB.lastSyncedAt).toBeInstanceOf(Date);
    expect(rowA.status).toBe('ACTIVE');
    expect(rowB.status).toBe('ACTIVE');
    expect(rowA.consecutiveFailures).toBe(0);

    // Next cycle (still inside A's window): A is skipped with zero calls, B syncs again.
    const seen: string[] = [];
    const r2 = await runCalendarSyncCycle(db, {
      providerFor: (row) => {
        seen.push(row.id);
        return row.id === connA.id ? pa : row.id === connB.id ? pb : null;
      },
      now: new Date(t0.getTime() + 1000),
    });
    expect(seen).not.toContain(connA.id);
    expect(seen).toContain(connB.id);
    expect(r2.rateLimited).toBe(1);
    rowA = await connRow(connA.id);
    expect(rowA.status).toBe('ACTIVE');
  });
});

describe('M8-i4 T6a — the calendar.sync job logs rate-limited cycles', () => {
  it('warns calendar.sync.rate_limited with the result fields — no credentials, no pause/failed noise', async () => {
    const provider = mkProvider();
    const { conn } = await seedConnection(provider);
    // Deterministic count: clear any windows earlier tests stored.
    await db.update(calendarConnections).set({ rateLimitedUntil: null }).where(isNotNull(calendarConnections.rateLimitedUntil));
    await db.update(calendarConnections).set({ rateLimitedUntil: new Date(Date.now() + 60_000) }).where(eq(calendarConnections.id, conn.id));

    const job = JOBS.find((j) => j.name === 'calendar.sync')!;
    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      const result = await job.run();
      expect((result.details as { rateLimited: number }).rateLimited).toBe(1);
      const lines = written.map((l) => JSON.parse(l) as Record<string, unknown>);
      const rl = lines.find((l) => l.message === 'calendar.sync.rate_limited');
      expect(rl).toBeTruthy();
      expect(rl!.level).toBe('warn');
      expect(rl!.rateLimited).toBe(1);
      expect(lines.some((l) => l.message === 'calendar.sync.paused' || l.message === 'calendar.sync.failed')).toBe(false);
      // No token material in any line the job wrote:
      for (const l of written) {
        expect(l).not.toContain('fixture-access');
        expect(l).not.toContain('worker-at-0');
        expect(l).not.toContain('v1.');
      }
    } finally {
      spy.mockRestore();
    }
  });
});
