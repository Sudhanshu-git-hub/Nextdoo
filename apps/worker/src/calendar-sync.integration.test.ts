import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
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

const { JOBS } = await import('./jobs');
const { createDb } = await import('@nextdoo/db');
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
