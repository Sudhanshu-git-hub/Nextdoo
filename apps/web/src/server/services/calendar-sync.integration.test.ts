import { afterAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { dedicatedDatabase, type DedicatedDatabase } from '../../../../../tests/dedicated-database';

/**
 * M7 — Google Calendar two-way sync (PRD §16) — engine + web service
 * integration tests against a real PostgreSQL database with a
 * deterministic in-memory provider (FixtureCalendarProvider).
 *
 * These tests never touch the network: the provider boundary
 * (@nextdoo/contracts) is the only calendar abstraction and the fixture
 * implements it faithfully (sync tokens, etags, 401/429, channels).
 * Live Google verification is separately blocked (see the milestone doc).
 */

const AUTH_SECRET = 'test-only-secret-0123456789abcdefghij';

// Top-level await (codebase pattern for integration suites): the dedicated
// database must exist before collection so `maybe()` sees it.
let dedicated: DedicatedDatabase | null = null;
let available = false;
try {
  dedicated = await dedicatedDatabase('nextdoo_calendar_sync_web');
  process.env.DATABASE_URL = dedicated.url;
  process.env.AUTH_SECRET = AUTH_SECRET;
  available = true;
} catch (error) {
  console.error('CALENDAR-DB-SETUP-FAILED', error);
}

afterAll(async () => {
  await dedicated?.close();
});

const maybe = () => (available ? it : it.skip);

const H = 3_600_000;

interface Seed {
  userId: string;
  workspaceId: string;
  provider: import('@nextdoo/calendar').FixtureCalendarProvider;
}

/** Registers a user and seeds an ACTIVE google connection (READ_WRITE) with a fixture provider. */
async function seedConnection(opts: { name?: string; mode?: 'READ_ONLY' | 'READ_WRITE' } = {}): Promise<Seed> {
  const { registerUser } = await import('./accounts');
  const { upsertVerifiedConnection } = await import('./calendar-connections');
  const { FixtureCalendarProvider } = await import('@nextdoo/calendar');
  const user = await registerUser({
    email: `calsync-${opts.name ?? 'x'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`,
    passwordHash: 'scrypt$deadbeef$deadbeef',
    name: opts.name ?? 'Cal Sync',
    timeZone: 'UTC',
  });
  const provider = new FixtureCalendarProvider({
    tokens: { accessToken: 'fx-at', refreshToken: 'fx-rt', expiresAt: new Date(Date.now() + 3600_000).toISOString(), scopes: null },
  });
  await upsertVerifiedConnection(user.id, user.workspaceId, {
    provider: 'google',
    accessToken: 'sealed-access-token-value',
    refreshToken: 'sealed-refresh-token-value',
    tokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    externalAccountId: 'fixture-user@test.local',
    mode: opts.mode ?? 'READ_WRITE',
  });
  return { userId: user.id, workspaceId: user.workspaceId, provider };
}

async function seedTask(workspaceId: string, title: string, dueInMs: number, opts: { unschedule?: boolean } = {}) {
  const { getDb } = await import('../db');
  const { tasks } = await import('@nextdoo/db');
  const [row] = await getDb()
    .insert(tasks)
    .values({ id: crypto.randomUUID(), workspaceId, title, dueAt: opts.unschedule ? null : new Date(Date.now() + dueInMs), status: 'ACTIVE' })
    .returning();
  return row!;
}

async function connectionIdOf(userId: string) {
  const { getDb } = await import('../db');
  const { calendarConnections } = await import('@nextdoo/db');
  const [row] = await getDb().select().from(calendarConnections).where(eq(calendarConnections.userId, userId)).limit(1);
  return row!;
}

async function seedMapping(seed: Seed, task: { id: string }, externalId: string, overrides: Record<string, unknown> = {}) {
  const { getDb } = await import('../db');
  const { calendarMappings } = await import('@nextdoo/db');
  const conn = await connectionIdOf(seed.userId);
  const [row] = await getDb()
    .insert(calendarMappings)
    .values({
      id: crypto.randomUUID(),
      connectionId: conn.id,
      taskId: task.id,
      externalId,
      calendarId: 'primary',
      syncState: 'SYNCED',
      externalUpdatedAt: new Date('2026-09-01T00:00:00.000Z'),
      localUpdatedAt: null,
      ...overrides,
    })
    .returning();
  return row!;
}

describe('calendar sync engine + services (integration, fixture provider)', () => {
  maybe()('AC-1/AC-4: due-time task becomes an event; re-running never duplicates', async () => {
    const seed = await seedConnection({ name: 'ac1' });
    const conn = await connectionIdOf(seed.userId);
    const task = await seedTask(seed.workspaceId, 'Ship the report', 5 * H);

    const { runCalendarExport } = await import('@nextdoo/db');
    const first = await runCalendarExport({ db: (await import('../db')).getDb(), connectionId: conn.id, provider: seed.provider });
    expect(first.exportedCreated).toBe(1);
    expect(first.exportedUpdated).toBe(0);
    const exported = [...seed.provider.store.values()].filter((e) => !e.deleted);
    expect(exported).toHaveLength(1);
    expect(exported[0]!.title).toBe('Ship the report');

    // The mapping is the dedup key (unique (connection, task)).
    const { getDb } = await import('../db');
    const { calendarMappings, calendarEvents } = await import('@nextdoo/db');
    const mappings = await getDb().select().from(calendarMappings).where(eq(calendarMappings.connectionId, conn.id));
    expect(mappings).toHaveLength(1);
    expect(mappings[0]!.syncState).toBe('SYNCED');
    const mirrors = await getDb().select().from(calendarEvents).where(eq(calendarEvents.connectionId, conn.id));
    expect(mirrors).toHaveLength(1);

    // Re-run: idempotent, no duplicate event.
    const second = await runCalendarExport({ db: getDb(), connectionId: conn.id, provider: seed.provider });
    expect(second.exportedCreated).toBe(0);
    expect([...seed.provider.store.values()].filter((e) => !e.deleted)).toHaveLength(1);
    void task;
  });

  maybe()('AC-2: deleting the task removes the mapped event (and is idempotent)', async () => {
    const seed = await seedConnection({ name: 'ac2' });
    const conn = await connectionIdOf(seed.userId);
    const { runCalendarExport } = await import('@nextdoo/db');
    const task = await seedTask(seed.workspaceId, 'Call the client', 6 * H);
    expect((await runCalendarExport({ db: (await import('../db')).getDb(), connectionId: conn.id, provider: seed.provider })).exportedCreated).toBe(1);

    // Delete the task (soft).
    const { getDb } = await import('../db');
    const { tasks } = await import('@nextdoo/db');
    await getDb().update(tasks).set({ status: 'DELETED', deletedAt: new Date() }).where(eq(tasks.id, task.id));

    const out = await runCalendarExport({ db: getDb(), connectionId: conn.id, provider: seed.provider });
    expect(out.exportedDeleted).toBe(1);
    expect([...seed.provider.store.values()].every((e) => e.deleted)).toBe(true);
    const { calendarMappings } = await import('@nextdoo/db');
    expect(await getDb().select().from(calendarMappings).where(eq(calendarMappings.connectionId, conn.id))).toHaveLength(0);

    // Re-run: nothing left to delete (no duplicate deletes, no error).
    const again = await runCalendarExport({ db: getDb(), connectionId: conn.id, provider: seed.provider });
    expect(again.exportedDeleted).toBe(0);
  });

  maybe()('AC-3: an external deletion unschedules the task and notifies', async () => {
    const seed = await seedConnection({ name: 'ac3' });
    const conn = await connectionIdOf(seed.userId);
    const task = await seedTask(seed.workspaceId, 'Dentist appointment', 7 * H);
    seed.provider.pushEvent({ externalId: 'ext-dentist', title: 'Dentist', startsAt: task.dueAt!.toISOString(), endsAt: new Date(task.dueAt!.getTime() + H).toISOString(), updatedAt: '2026-09-05T00:00:00.000Z' });
    await seedMapping(seed, task, 'ext-dentist');

    seed.provider.deleteEventExternal('ext-dentist');
    const { runCalendarImport } = await import('@nextdoo/db');
    const out = await runCalendarImport({ db: (await import('../db')).getDb(), connectionId: conn.id, provider: seed.provider });
    expect(out.unscheduledTasks).toBe(1);
    expect(out.removedExternal).toBe(1);

    const { getDb } = await import('../db');
    const { tasks, notifications, calendarMappings, syncChanges } = await import('@nextdoo/db');
    const [after] = await getDb().select().from(tasks).where(eq(tasks.id, task.id));
    expect(after!.dueAt).toBeNull();
    expect(after!.rescheduleCount).toBe(1);
    expect(after!.version).toBe(2);
    // The task change is on the device sync cursor, like any reschedule.
    const changes = await getDb().select().from(syncChanges).where(and(eq(syncChanges.entityId, task.id), eq(syncChanges.entityType, 'task')));
    expect(changes).toHaveLength(1);
    const notes = await getDb().select().from(notifications).where(eq(notifications.taskId, task.id));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.type).toBe('calendar');
    expect(await getDb().select().from(calendarMappings).where(eq(calendarMappings.connectionId, conn.id))).toHaveLength(0);
  });

  maybe()('PRD §16.4: both-side change → CONFLICT with both values, never a silent overwrite', async () => {
    const seed = await seedConnection({ name: 'conflict' });
    const conn = await connectionIdOf(seed.userId);
    const task = await seedTask(seed.workspaceId, 'Design review', 8 * H);
    seed.provider.pushEvent({ externalId: 'ext-review', title: 'Design review', startsAt: task.dueAt!.toISOString(), endsAt: new Date(task.dueAt!.getTime() + H).toISOString(), updatedAt: '2026-09-01T00:00:00.000Z' });
    await seedMapping(seed, task, 'ext-review', { localUpdatedAt: new Date('2026-09-02T00:00:00.000Z') }); // locally modified after last external apply

    // Google moves the event too (after the last applied external change).
    const t2 = new Date(task.dueAt!.getTime() + 2 * H);
    seed.provider.pushEvent({ externalId: 'ext-review', title: 'Design review (moved)', startsAt: t2.toISOString(), endsAt: new Date(t2.getTime() + H).toISOString(), updatedAt: '2026-09-03T00:00:00.000Z' });

    const { runCalendarImport } = await import('@nextdoo/db');
    const out = await runCalendarImport({ db: (await import('../db')).getDb(), connectionId: conn.id, provider: seed.provider });
    expect(out.conflicts).toBe(1);
    expect(out.externalApplied).toBe(0);

    const { getDb } = await import('../db');
    const { calendarMappings, tasks } = await import('@nextdoo/db');
    const [mapping] = await getDb().select().from(calendarMappings).where(eq(calendarMappings.connectionId, conn.id));
    expect(mapping!.syncState).toBe('CONFLICT');
    const payload = mapping!.conflictPayload as { local: { dueAt: string }; external: { startsAt: string; title: string } };
    expect(payload.local.dueAt).toBe(task.dueAt!.toISOString());
    expect(payload.external.startsAt).toBe(t2.toISOString());
    // The task title and time were NOT silently overwritten.
    const [taskNow] = await getDb().select().from(tasks).where(eq(tasks.id, task.id));
    expect(taskNow!.title).toBe('Design review');
    expect(taskNow!.dueAt!.toISOString()).toBe(task.dueAt!.toISOString());
  });

  maybe()('external-only change is applied to the task through the task invariants', async () => {
    const seed = await seedConnection({ name: 'extonly' });
    const conn = await connectionIdOf(seed.userId);
    const task = await seedTask(seed.workspaceId, 'Pickup keys', 9 * H);
    seed.provider.pushEvent({ externalId: 'ext-keys', title: 'Pickup keys', startsAt: task.dueAt!.toISOString(), endsAt: new Date(task.dueAt!.getTime() + H).toISOString(), updatedAt: '2026-09-01T00:00:00.000Z' });
    await seedMapping(seed, task, 'ext-keys');

    const moved = new Date(task.dueAt!.getTime() - 2 * H);
    seed.provider.pushEvent({ externalId: 'ext-keys', title: 'Pickup keys', startsAt: moved.toISOString(), endsAt: new Date(moved.getTime() + H).toISOString(), updatedAt: '2026-09-04T00:00:00.000Z' });

    const { runCalendarImport } = await import('@nextdoo/db');
    const out = await runCalendarImport({ db: (await import('../db')).getDb(), connectionId: conn.id, provider: seed.provider });
    expect(out.externalApplied).toBe(1);
    expect(out.conflicts).toBe(0);

    const { getDb } = await import('../db');
    const { tasks, calendarMappings } = await import('@nextdoo/db');
    const [after] = await getDb().select().from(tasks).where(eq(tasks.id, task.id));
    expect(after!.dueAt!.toISOString()).toBe(moved.toISOString());
    expect(after!.version).toBe(2);
    const [mapping] = await getDb().select().from(calendarMappings).where(eq(calendarMappings.connectionId, conn.id));
    expect(mapping!.syncState).toBe('SYNCED');
    expect((mapping!.externalUpdatedAt as Date).toISOString()).toBe('2026-09-04T00:00:00.000Z');

    // Re-import with no further external change: a no-op.
    const again = await runCalendarImport({ db: getDb(), connectionId: conn.id, provider: seed.provider });
    expect(again.externalApplied).toBe(0);
    expect(again.conflicts).toBe(0);
  });

  maybe()('AC-5: a revoked/expired token pauses the connection with a reconnect prompt', async () => {
    const seed = await seedConnection({ name: 'revoked' });
    const conn = await connectionIdOf(seed.userId);
    seed.provider.markRevoked();

    const { runCalendarImport } = await import('@nextdoo/db');
    const out = await runCalendarImport({ db: (await import('../db')).getDb(), connectionId: conn.id, provider: seed.provider });
    expect(out.paused).toBeTruthy();

    const { getDb } = await import('../db');
    const { calendarConnections, notifications } = await import('@nextdoo/db');
    const [row] = await getDb().select().from(calendarConnections).where(eq(calendarConnections.id, conn.id));
    expect(row!.status).toBe('SUSPENDED');
    expect(row!.pauseReason).toBeTruthy();
    const notes = await getDb().select().from(notifications).where(eq(notifications.userId, seed.userId));
    expect(notes.some((n) => n.type === 'calendar')).toBe(true);

    // A paused connection cannot be synced until reconnected.
    const { syncConnectionNow } = await import('./calendar-connections');
    await expect(syncConnectionNow(seed.userId, conn.id)).rejects.toThrow(/paused|Reconnect/i);
  });

  maybe()('a 429 skips the pass without state changes or failure counts', async () => {
    const seed = await seedConnection({ name: 'ratelimit' });
    const conn = await connectionIdOf(seed.userId);
    seed.provider.setRateLimitCalls(2);

    const { runCalendarImport, runCalendarExport } = await import('@nextdoo/db');
    const imp = await runCalendarImport({ db: (await import('../db')).getDb(), connectionId: conn.id, provider: seed.provider });
    expect(imp.rateLimitedSeconds).toBe(7);
    expect(imp.imported).toBe(0);
    const exp = await runCalendarExport({ db: (await import('../db')).getDb(), connectionId: conn.id, provider: seed.provider });
    expect(exp.rateLimitedSeconds).toBe(7);

    const { getDb } = await import('../db');
    const { calendarConnections } = await import('@nextdoo/db');
    const [row] = await getDb().select().from(calendarConnections).where(eq(calendarConnections.id, conn.id));
    expect(row!.status).toBe('ACTIVE');
    expect(row!.consecutiveFailures).toBe(0);
    expect(row!.syncToken).toBeNull(); // no checkpoint advance
  });

  maybe()('disconnect (PRD §16.5): revokes best-effort, wipes tokens, retains mappings', async () => {
    const seed = await seedConnection({ name: 'disc' });
    const conn = await connectionIdOf(seed.userId);
    const task = await seedTask(seed.workspaceId, 'Kept after disconnect', 10 * H);
    const { runCalendarExport } = await import('@nextdoo/db');
    await runCalendarExport({ db: (await import('../db')).getDb(), connectionId: conn.id, provider: seed.provider });

    // The service uses the injected provider (fixture) for the revoke.
    const svc = await import('./calendar-connections');
    svc.setCalendarProviderFactoryForTests(() => seed.provider);
    const view = await svc.disconnectConnection(seed.userId, conn.id);
    svc.setCalendarProviderFactoryForTests(null);
    expect(view.status).toBe('DISCONNECTED');
    expect(seed.provider.calls.some((c) => c.op === 'revoke')).toBe(true);

    const { getDb } = await import('../db');
    const { calendarConnections, calendarMappings, tasks } = await import('@nextdoo/db');
    const [row] = await getDb().select().from(calendarConnections).where(eq(calendarConnections.id, conn.id));
    expect(row!.accessTokenEncrypted).toBeNull(); // PRD §16.5: delete tokens
    expect(row!.refreshTokenEncrypted).toBeNull();
    expect(row!.syncToken).toBeNull();
    expect(row!.disconnectedAt).toBeInstanceOf(Date);
    // Mappings retained (30-day retention, worker purges); imported tasks remain.
    expect(await getDb().select().from(calendarMappings).where(eq(calendarMappings.connectionId, conn.id))).toHaveLength(1);
    const [kept] = await getDb().select().from(tasks).where(eq(tasks.id, task.id));
    expect(kept!.dueAt).not.toBeNull();
  });

  maybe()('conflict resolution: keep-task / keep-calendar / unlink — all audit-logged', async () => {
    const seed = await seedConnection({ name: 'resolve' });
    const conn = await connectionIdOf(seed.userId);
    const task = await seedTask(seed.workspaceId, 'Board deck', 11 * H);
    const externalStart = new Date(task.dueAt!.getTime() + 3 * H);
    seed.provider.pushEvent({ externalId: 'ext-deck', title: 'Board deck', startsAt: task.dueAt!.toISOString(), endsAt: new Date(task.dueAt!.getTime() + H).toISOString(), updatedAt: '2026-09-01T00:00:00.000Z' });
    const mapping = await seedMapping(seed, task, 'ext-deck', {
      syncState: 'CONFLICT',
      localUpdatedAt: new Date('2026-09-02T00:00:00.000Z'),
      conflictPayload: {
        local: { dueAt: task.dueAt!.toISOString(), title: 'Board deck' },
        external: { startsAt: externalStart.toISOString(), endsAt: new Date(externalStart.getTime() + H).toISOString(), title: 'Board deck', externalId: 'ext-deck' },
      },
    });

    const svc = await import('./calendar-connections');
    svc.setCalendarProviderFactoryForTests(() => seed.provider);

    // KEEP_TASK: the external event is patched to the task's values.
    await svc.resolveCalendarConflict(seed.userId, conn.id, mapping.id, 'KEEP_TASK');
    const patchCall = seed.provider.calls.find((c) => c.op === 'patch' && c.externalId === 'ext-deck');
    expect(patchCall).toBeTruthy();
    const { getDb } = await import('../db');
    const { calendarMappings, auditLogs } = await import('@nextdoo/db');
    const [m1] = await getDb().select().from(calendarMappings).where(eq(calendarMappings.id, mapping.id));
    expect(m1!.syncState).toBe('SYNCED');
    expect(m1!.conflictPayload).toBeNull();
    let audits = await getDb().select().from(auditLogs).where(and(eq(auditLogs.action, 'calendar.conflict_resolved'), eq(auditLogs.targetId, mapping.id)));
    expect(audits).toHaveLength(1);
    expect((audits[0]!.metadata as { action: string }).action).toBe('KEEP_TASK');

    // Re-create the conflict, then KEEP_CALENDAR: the task moves to the external time.
    await getDb()
      .update(calendarMappings)
      .set({
        syncState: 'CONFLICT',
        conflictPayload: {
          local: { dueAt: task.dueAt!.toISOString(), title: 'Board deck' },
          external: { startsAt: externalStart.toISOString(), endsAt: new Date(externalStart.getTime() + H).toISOString(), title: 'Board deck', externalId: 'ext-deck' },
        },
      })
      .where(eq(calendarMappings.id, mapping.id));
    await svc.resolveCalendarConflict(seed.userId, conn.id, mapping.id, 'KEEP_CALENDAR');
    const { tasks } = await import('@nextdoo/db');
    const [taskNow] = await getDb().select().from(tasks).where(eq(tasks.id, task.id));
    expect(taskNow!.dueAt!.toISOString()).toBe(externalStart.toISOString());
    expect(taskNow!.version).toBe(2);
    audits = await getDb().select().from(auditLogs).where(and(eq(auditLogs.action, 'calendar.conflict_resolved'), eq(auditLogs.targetId, mapping.id)));
    expect(audits.map((a) => (a.metadata as { action: string }).action)).toEqual(['KEEP_TASK', 'KEEP_CALENDAR']);

    // UNLINK: the mapping disappears; task and external event both survive.
    await getDb().update(calendarMappings).set({ syncState: 'CONFLICT' }).where(eq(calendarMappings.id, mapping.id));
    await svc.resolveCalendarConflict(seed.userId, conn.id, mapping.id, 'UNLINK');
    expect(await getDb().select().from(calendarMappings).where(eq(calendarMappings.id, mapping.id))).toHaveLength(0);
    expect([...seed.provider.store.values()].some((e) => !e.deleted)).toBe(true);
    const [taskStill] = await getDb().select().from(tasks).where(eq(tasks.id, task.id));
    expect(taskStill!.status).toBe('ACTIVE');

    // Resolving again is a clean error (not a silent success).
    await expect(svc.resolveCalendarConflict(seed.userId, conn.id, mapping.id, 'KEEP_TASK')).rejects.toThrow();
    svc.setCalendarProviderFactoryForTests(null);
  });

  maybe()('OAuth flow: mode-before-auth, PKCE state is single-use, 503 when unconfigured', async () => {
    const svc = await import('./calendar-connections');
    const { FixtureCalendarProvider } = await import('@nextdoo/calendar');
    const { AppError } = await import('@nextdoo/contracts');

    // Unconfigured deployment: honest 503, no stub.
    svc.setGoogleConfigForTests(() => null);
    const { id: userId, workspaceId } = await (await import('./accounts')).registerUser({
      email: `calsync-unconfigured-${Date.now()}@test.local`,
      passwordHash: 'scrypt$deadbeef$deadbeef',
      name: 'Unconfigured',
      timeZone: 'UTC',
    });
    svc.setGoogleConfigForTests(() => null);
    await expect(svc.startGoogleAuthorization(userId, workspaceId, 'READ_ONLY')).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });

    // Configured: READ_ONLY gets the readonly scope; READ_WRITE the write scope.
    const flow = () => new FixtureCalendarProvider();
    svc.setCalendarProviderFactoryForTests(flow);
    svc.setGoogleConfigForTests(() => ({ clientId: 'test-client', clientSecret: 'test-secret', redirectUri: 'http://localhost:3100/api/v1/calendar/connections/google/callback' }));

    const ro = await svc.startGoogleAuthorization(userId, workspaceId, 'READ_ONLY');
    expect(ro.authorizationUrl).toContain('mode=READ_ONLY');
    const rw = await svc.startGoogleAuthorization(userId, workspaceId, 'READ_WRITE');
    expect(rw.authorizationUrl).toContain('mode=READ_WRITE');

    // The callback finishes the exchange and applies the chosen mode.
    const state = ro.authorizationUrl.match(/state=([^&]+)/)?.[1];
    expect(state).toBeTruthy();
    const view = await svc.completeGoogleCallback(state!, 'auth-code-1');
    expect(view.status).toBe('ACTIVE');
    expect(view.mode).toBe('READ_ONLY');

    // Single-use: replaying the same state fails.
    await expect(svc.completeGoogleCallback(state!, 'auth-code-1')).rejects.toThrow(/state/i);
    // Unknown state fails too.
    await expect(svc.completeGoogleCallback('never-stored-state', 'auth-code-2')).rejects.toThrow(/state/i);
    // A Google-side denial (error param) maps to a failed sign-in.
    await expect(svc.completeGoogleCallback('x', '')).rejects.toBeInstanceOf(AppError);

    svc.setGoogleConfigForTests(null);
    svc.setCalendarProviderFactoryForTests(null);
  });

  maybe()('manual sync + events listing + webhook (tenant-scoped)', async () => {
    const a = await seedConnection({ name: 'events-a' });
    const b = await seedConnection({ name: 'events-b' });
    const connA = await connectionIdOf(a.userId);
    const { runCalendarExport } = await import('@nextdoo/db');
    const taskA = await seedTask(a.workspaceId, 'A meeting', 12 * H);
    a.provider.pushEvent({ externalId: 'ext-a-busy', title: 'A busy block', startsAt: new Date(Date.now() + H).toISOString(), endsAt: new Date(Date.now() + 2 * H).toISOString() });
    b.provider.pushEvent({ externalId: 'ext-b-busy', title: 'B busy block', startsAt: new Date(Date.now() + H).toISOString(), endsAt: new Date(Date.now() + 2 * H).toISOString() });
    await runCalendarExport({ db: (await import('../db')).getDb(), connectionId: connA.id, provider: a.provider });

    const svc = await import('./calendar-connections');
    svc.setCalendarProviderFactoryForTests((row) => (row?.id === connA.id ? a.provider : b.provider));

    // The webhook triggers the import that brings 'A busy block' into the mirror.
    const hook = await svc.handleCalendarWebhook(connA.id);
    expect(hook.ok).toBe(true);

    const start = new Date(Date.now() - H).toISOString();
    const end = new Date(Date.now() + 24 * H).toISOString();
    const listed = await svc.listCalendarEvents(a.userId, start, end);
    expect(listed.map((e) => e.title).sort()).toEqual(['A busy block', 'A meeting']);
    // B's own webhook imports B's events — and nothing of A's.
    const connB = await connectionIdOf(b.userId);
    await svc.handleCalendarWebhook(connB.id);
    const listedB = await svc.listCalendarEvents(b.userId, start, end);
    expect(listedB.map((e) => e.title)).toEqual(['B busy block']);

    // Unknown channel tokens are ignored (no cross-tenant import).
    expect((await svc.handleCalendarWebhook(crypto.randomUUID())).ok).toBe(false);

    // Manual sync runs import + export and reports the totals.
    const sync = await svc.syncConnectionNow(a.userId, connA.id);
    expect(sync.exportedCreated + sync.exportedUpdated + sync.exportedDeleted).toBeGreaterThanOrEqual(0);
    expect(sync.imported).toBeGreaterThanOrEqual(0);
    void taskA;
    svc.setCalendarProviderFactoryForTests(null);
  });
});
