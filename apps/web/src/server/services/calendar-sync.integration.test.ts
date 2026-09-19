import { afterAll, describe, expect, it, vi } from 'vitest';
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

  // ------------------------------------------------------------------
  // M8-i4 — T5 (invalid sync-token recovery) and T1 (manual-sync
  // re-seal). Same fixture-provider discipline as the M7 suite.
  // ------------------------------------------------------------------

  const t5Event = (id: string, title: string, offsetH: number, updated: string) => ({
    externalId: id,
    title,
    startsAt: new Date(Date.now() + offsetH * H).toISOString(),
    endsAt: new Date(Date.now() + (offsetH + 1) * H).toISOString(),
    updatedAt: updated,
  });

  maybe()('M8-i4 T5: an invalidated stored sync token is cleared, the bounded window re-imported, and a fresh checkpoint adopted — audited, no pause, idempotent', async () => {
    const seed = await seedConnection({ name: 't5main' });
    const conn = await connectionIdOf(seed.userId);
    const { getDb } = await import('../db');
    const { runCalendarImport, calendarEvents, auditLogs } = await import('@nextdoo/db');

    // Pass 1 establishes the checkpoint with two events.
    seed.provider.pushEvent(t5Event('ext-t5a', 'T5 A', 2, '2026-09-01T00:00:00.000Z'));
    seed.provider.pushEvent(t5Event('ext-t5b', 'T5 B', 3, '2026-09-01T00:00:00.000Z'));
    const first = await runCalendarImport({ db: getDb(), connectionId: conn.id, provider: seed.provider });
    expect(first.syncTokenReset).toBe(false);
    expect(first.imported).toBe(2);
    const storedToken = (await connectionIdOf(seed.userId)).syncToken;
    expect(storedToken).toBeTruthy();

    // Google invalidates the stored token (change-count lifetime exhausted)
    // and a new event lands on the provider side.
    seed.provider.invalidateSyncToken();
    seed.provider.pushEvent(t5Event('ext-t5c', 'T5 C', 4, '2026-09-06T00:00:00.000Z'));

    const second = await runCalendarImport({ db: getDb(), connectionId: conn.id, provider: seed.provider });
    expect(second.syncTokenReset).toBe(true);
    expect(second.imported).toBe(3); // bounded full-window re-import
    const row = await connectionIdOf(seed.userId);
    // A FRESH checkpoint from the tokenless call — the stale token is gone:
    expect(row.syncToken).toBe(seed.provider.lastDeliveredSyncToken);
    expect(row.syncToken).not.toBe(storedToken);
    // Structured audit, not a failure:
    const audits = await getDb().select().from(auditLogs).where(and(eq(auditLogs.action, 'calendar.sync_token_reset'), eq(auditLogs.targetId, conn.id)));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata).toMatchObject({ reason: 'invalid_sync_token', reimported: 3 });
    // No pause, no generic failure count, no sync_failed audit:
    expect(row.status).toBe('ACTIVE');
    expect(row.consecutiveFailures).toBe(0);
    expect(row.pauseReason).toBeNull();
    const failed = await getDb().select().from(auditLogs).where(eq(auditLogs.action, 'calendar.sync_failed'));
    expect(failed.filter((a) => a.targetId === conn.id)).toHaveLength(0);
    // The mirror has exactly the three events — the re-import duplicated nothing:
    const events = await getDb().select().from(calendarEvents).where(eq(calendarEvents.connectionId, conn.id));
    expect(events.map((e) => e.externalId).sort()).toEqual(['ext-t5a', 'ext-t5b', 'ext-t5c']);

    // Idempotent: the next pass runs the adopted checkpoint normally — no
    // second reset, no second audit, no duplicates.
    const third = await runCalendarImport({ db: getDb(), connectionId: conn.id, provider: seed.provider });
    expect(third.syncTokenReset).toBe(false);
    expect(await getDb().select().from(calendarEvents).where(eq(calendarEvents.connectionId, conn.id))).toHaveLength(3);
    const auditsAfter = await getDb().select().from(auditLogs).where(and(eq(auditLogs.action, 'calendar.sync_token_reset'), eq(auditLogs.targetId, conn.id)));
    expect(auditsAfter).toHaveLength(1);
    expect((await connectionIdOf(seed.userId)).syncToken).toBe(row.syncToken); // checkpoint stable
  });

  maybe()('M8-i4 T5: the token reset is connection-scoped (tenant isolation)', async () => {
    const a = await seedConnection({ name: 't5iso-a' });
    const b = await seedConnection({ name: 't5iso-b' });
    const connA = await connectionIdOf(a.userId);
    const connB = await connectionIdOf(b.userId);
    a.provider.pushEvent(t5Event('ext-iso-a', 'Iso A', 2, '2026-09-01T00:00:00.000Z'));
    b.provider.pushEvent(t5Event('ext-iso-b', 'Iso B', 2, '2026-09-01T00:00:00.000Z'));
    const { runCalendarImport } = await import('@nextdoo/db');
    const { getDb } = await import('../db');
    const { calendarEvents } = await import('@nextdoo/db');
    await runCalendarImport({ db: getDb(), connectionId: connA.id, provider: a.provider });
    await runCalendarImport({ db: getDb(), connectionId: connB.id, provider: b.provider });
    const tokenA = (await connectionIdOf(a.userId)).syncToken!;
    const tokenB = (await connectionIdOf(b.userId)).syncToken!;

    // A's token is invalidated and A gets a new event; only A is re-imported.
    a.provider.invalidateSyncToken();
    a.provider.pushEvent(t5Event('ext-iso-a2', 'Iso A2', 3, '2026-09-02T00:00:00.000Z'));
    const out = await runCalendarImport({ db: getDb(), connectionId: connA.id, provider: a.provider });
    expect(out.syncTokenReset).toBe(true);

    // A reset; B is untouched — same checkpoint, same mirror.
    const aRow = await connectionIdOf(a.userId);
    const bRow = await connectionIdOf(b.userId);
    expect(aRow.syncToken).not.toBe(tokenA);
    expect(bRow.syncToken).toBe(tokenB);
    expect(await getDb().select().from(calendarEvents).where(eq(calendarEvents.connectionId, connA.id))).toHaveLength(2);
    const bEvents = await getDb().select().from(calendarEvents).where(eq(calendarEvents.connectionId, connB.id));
    expect(bEvents).toHaveLength(1);
    expect(bEvents[0]!.externalId).toBe('ext-iso-b');
  });

  maybe()('M8-i4 T5: a reset re-import never duplicates mirrors and preserves an open conflict', async () => {
    const seed = await seedConnection({ name: 't5conf' });
    const conn = await connectionIdOf(seed.userId);
    const task = await seedTask(seed.workspaceId, 'Conflict keeper', 8 * H);
    seed.provider.pushEvent(t5Event('ext-conf', 'Conflict keeper', 5, '2026-09-01T00:00:00.000Z'));
    // Locally modified after the last external apply → an external change is a conflict.
    await seedMapping(seed, task, 'ext-conf', { localUpdatedAt: new Date('2026-09-02T00:00:00.000Z') });
    seed.provider.pushEvent(t5Event('ext-plain', 'Plain block', 6, '2026-09-01T00:00:00.000Z'));

    const { runCalendarImport } = await import('@nextdoo/db');
    const { getDb } = await import('../db');
    const { calendarEvents, calendarMappings, tasks } = await import('@nextdoo/db');
    await runCalendarImport({ db: getDb(), connectionId: conn.id, provider: seed.provider }); // establish

    // Google moves the mapped event (after the local change), and the stored
    // sync token is invalidated in the same pass.
    const t2 = new Date(task.dueAt!.getTime() + 2 * H);
    seed.provider.pushEvent({ externalId: 'ext-conf', title: 'Conflict keeper (moved)', startsAt: t2.toISOString(), endsAt: new Date(t2.getTime() + H).toISOString(), updatedAt: '2026-09-03T00:00:00.000Z' });
    seed.provider.invalidateSyncToken();

    const out = await runCalendarImport({ db: getDb(), connectionId: conn.id, provider: seed.provider });
    expect(out.syncTokenReset).toBe(true);
    expect(out.conflicts).toBe(1);
    // The conflict is detected on the re-imported data and preserved for the
    // user — the task was NOT silently moved:
    const [mapping] = await getDb().select().from(calendarMappings).where(eq(calendarMappings.connectionId, conn.id));
    expect(mapping!.syncState).toBe('CONFLICT');
    const [taskNow] = await getDb().select().from(tasks).where(eq(tasks.id, task.id));
    expect(taskNow!.dueAt!.toISOString()).toBe(task.dueAt!.toISOString());
    // Full-window re-import: exactly two mirrors, one mapping — no duplication.
    expect(await getDb().select().from(calendarEvents).where(eq(calendarEvents.connectionId, conn.id))).toHaveLength(2);
    expect(await getDb().select().from(calendarMappings).where(eq(calendarMappings.connectionId, conn.id))).toHaveLength(1);
  });

  maybe()('M8-i4 T1: manual sync re-seals the refreshed/rotated token set (no plaintext, no pause)', async () => {
    const svc = await import('./calendar-connections');
    const { FixtureCalendarProvider } = await import('@nextdoo/calendar');
    const { registerUser } = await import('./accounts');
    const { upsertVerifiedConnection } = await import('./calendar-connections');
    // The row stores the SAME (expired) token set the provider opens with, so
    // the re-seal comparison has a true baseline.
    const expiredAt = new Date(Date.now() - 1000).toISOString();
    const provider = new FixtureCalendarProvider({
      tokens: { accessToken: 'fx-at', refreshToken: 'fx-rt', expiresAt: expiredAt, scopes: null },
      rotateOnRefresh: true,
    });
    const user = await registerUser({
      email: `calreseal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`,
      passwordHash: 'scrypt$deadbeef$deadbeef',
      name: 'Reseal',
      timeZone: 'UTC',
    });
    await upsertVerifiedConnection(user.id, user.workspaceId, {
      provider: 'google',
      accessToken: 'fx-at',
      refreshToken: 'fx-rt',
      tokenExpiresAt: expiredAt,
      externalAccountId: 'fixture-user@test.local',
      mode: 'READ_WRITE',
      scopes: null,
    });
    const conn = await connectionIdOf(user.id);
    const before = await connectionIdOf(user.id);

    svc.setCalendarProviderFactoryForTests((row) => (row?.id === conn.id ? provider : null));
    try {
      const sync = await svc.syncConnectionNow(user.id, conn.id);
      expect(sync.paused).toBeNull();
    } finally {
      svc.setCalendarProviderFactoryForTests(null);
    }

    const { decryptSecret } = await import('../crypto');
    const after = await connectionIdOf(user.id);
    expect(after.accessTokenEncrypted).not.toBe(before.accessTokenEncrypted);
    // Re-openable through the app's envelope mechanism to the NEW credentials:
    expect(decryptSecret(after.accessTokenEncrypted!, 'calendar_token')).toBe('fixture-access-1');
    expect(decryptSecret(after.refreshTokenEncrypted!, 'calendar_token')).toBe('fixture-refresh-1'); // rotated
    // No plaintext at rest; expiry metadata preserved:
    expect(after.accessTokenEncrypted).toMatch(/^v1\./);
    expect(after.accessTokenEncrypted).not.toContain('fixture-access-1');
    expect(after.refreshTokenEncrypted).not.toContain('fixture-refresh-1');
    expect(after.tokenExpiresAt!.getTime() > Date.now()).toBe(true);
    // A re-seal is not a failure:
    expect(after.status).toBe('ACTIVE');
    expect(after.consecutiveFailures).toBe(0);
  });

  maybe()('M8-i4 T1: manual sync with an unchanged token set performs no token write', async () => {
    const svc = await import('./calendar-connections');
    const { FixtureCalendarProvider } = await import('@nextdoo/calendar');
    const { registerUser } = await import('./accounts');
    const { upsertVerifiedConnection } = await import('./calendar-connections');
    const provider = new FixtureCalendarProvider({
      tokens: { accessToken: 'fx-at', refreshToken: 'fx-rt', expiresAt: null, scopes: null }, // never expires
    });
    const user = await registerUser({
      email: `calreseal2-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`,
      passwordHash: 'scrypt$deadbeef$deadbeef',
      name: 'Reseal2',
      timeZone: 'UTC',
    });
    await upsertVerifiedConnection(user.id, user.workspaceId, {
      provider: 'google',
      accessToken: 'fx-at',
      refreshToken: 'fx-rt',
      tokenExpiresAt: null,
      externalAccountId: 'fixture-user@test.local',
      mode: 'READ_WRITE',
      scopes: null,
    });
    const conn = await connectionIdOf(user.id);
    const before = await connectionIdOf(user.id);

    svc.setCalendarProviderFactoryForTests((row) => (row?.id === conn.id ? provider : null));
    try {
      await svc.syncConnectionNow(user.id, conn.id);
    } finally {
      svc.setCalendarProviderFactoryForTests(null);
    }
    const after = await connectionIdOf(user.id);
    expect(after.accessTokenEncrypted).toBe(before.accessTokenEncrypted); // no write
    expect(after.refreshTokenEncrypted).toBe(before.refreshTokenEncrypted);
    expect(after.status).toBe('ACTIVE');
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

  maybe()('M8-i6 T2: webhook provider-message dedupe is scoped, replay-safe and preserves distinct notifications', async () => {
    const a = await seedConnection({ name: 'm8i6-dedupe-a' });
    const b = await seedConnection({ name: 'm8i6-dedupe-b' });
    const connA = await connectionIdOf(a.userId);
    const connB = await connectionIdOf(b.userId);
    const svc = await import('./calendar-connections');
    svc.setCalendarProviderFactoryForTests((row) => (row?.id === connA.id ? a.provider : b.provider));
    try {
      a.provider.pushEvent({ externalId: 'dedupe-a-1', title: 'Dedupe A1', startsAt: new Date(Date.now() + H).toISOString(), endsAt: new Date(Date.now() + 2 * H).toISOString() });
      b.provider.pushEvent({ externalId: 'dedupe-b-1', title: 'Dedupe B1', startsAt: new Date(Date.now() + H).toISOString(), endsAt: new Date(Date.now() + 2 * H).toISOString() });
      const listA = () => a.provider.calls.filter((c) => c.op === 'list').length;
      const listB = () => b.provider.calls.filter((c) => c.op === 'list').length;

      const first = await svc.handleCalendarWebhook(connA.id, { messageId: 'same-provider-message' });
      expect(first).toMatchObject({ ok: true, duplicate: false });
      expect(first.imported).toBe(1);
      const afterFirst = listA();
      expect(afterFirst).toBe(1);

      // Exact duplicate and repeated duplicates are idempotent no-ops.
      await expect(svc.handleCalendarWebhook(connA.id, { messageId: 'same-provider-message' })).resolves.toMatchObject({ ok: true, imported: 0, duplicate: true });
      await expect(svc.handleCalendarWebhook(connA.id, { messageId: 'same-provider-message' })).resolves.toMatchObject({ ok: true, imported: 0, duplicate: true });
      expect(listA()).toBe(afterFirst);

      // The same provider notification id on a different connection is scoped independently.
      const bFirst = await svc.handleCalendarWebhook(connB.id, { messageId: 'same-provider-message' });
      expect(bFirst).toMatchObject({ ok: true, duplicate: false });
      expect(listB()).toBe(1);

      // A genuinely distinct notification for the same connection still runs.
      a.provider.pushEvent({ externalId: 'dedupe-a-2', title: 'Dedupe A2', startsAt: new Date(Date.now() + 3 * H).toISOString(), endsAt: new Date(Date.now() + 4 * H).toISOString() });
      const distinct = await svc.handleCalendarWebhook(connA.id, { messageId: 'distinct-provider-message' });
      expect(distinct).toMatchObject({ ok: true, duplicate: false });
      expect(listA()).toBe(afterFirst + 1);

      // Tenant isolation: B sees only B's mirror rows after both webhooks.
      const start = new Date(Date.now() - H).toISOString();
      const end = new Date(Date.now() + 24 * H).toISOString();
      expect((await svc.listCalendarEvents(b.userId, start, end)).map((e) => e.title)).toEqual(['Dedupe B1']);
    } finally {
      svc.setCalendarProviderFactoryForTests(null);
    }
  });

  maybe()('M8-i6 T2: provider retries after a processing failure are recoverable', async () => {
    const seed = await seedConnection({ name: 'm8i6-failure' });
    const conn = await connectionIdOf(seed.userId);
    seed.provider.pushEvent({ externalId: 'retry-after-failure', title: 'Retry me', startsAt: new Date(Date.now() + H).toISOString(), endsAt: new Date(Date.now() + 2 * H).toISOString() });
    const svc = await import('./calendar-connections');
    const original = seed.provider.listChanges.bind(seed.provider);
    let fail = true;
    seed.provider.listChanges = (async (args) => {
      if (fail) {
        seed.provider.calls.push({ op: 'list' });
        throw new Error('fixture transient webhook failure');
      }
      return original(args);
    }) as typeof seed.provider.listChanges;
    svc.setCalendarProviderFactoryForTests(() => seed.provider);
    try {
      await expect(svc.handleCalendarWebhook(conn.id, { messageId: 'retryable-message' })).rejects.toThrow(/transient/);
      const { getDb } = await import('../db');
      const { calendarWebhookDeliveries } = await import('@nextdoo/db');
      const [failed] = await getDb().select().from(calendarWebhookDeliveries).where(and(eq(calendarWebhookDeliveries.connectionId, conn.id), eq(calendarWebhookDeliveries.messageId, 'retryable-message')));
      expect(failed!.status).toBe('FAILED');

      fail = false;
      const retry = await svc.handleCalendarWebhook(conn.id, { messageId: 'retryable-message' });
      expect(retry).toMatchObject({ ok: true, imported: 1, duplicate: false });
      const [succeeded] = await getDb().select().from(calendarWebhookDeliveries).where(and(eq(calendarWebhookDeliveries.connectionId, conn.id), eq(calendarWebhookDeliveries.messageId, 'retryable-message')));
      expect(succeeded!.status).toBe('SUCCEEDED');
      await expect(svc.handleCalendarWebhook(conn.id, { messageId: 'retryable-message' })).resolves.toMatchObject({ duplicate: true, imported: 0 });
    } finally {
      svc.setCalendarProviderFactoryForTests(null);
    }
  });

  maybe()('M8-i6 T2: concurrent duplicate delivery claims one import and no-ops the loser', async () => {
    const seed = await seedConnection({ name: 'm8i6-concurrent' });
    const conn = await connectionIdOf(seed.userId);
    seed.provider.pushEvent({ externalId: 'concurrent-event', title: 'Concurrent', startsAt: new Date(Date.now() + H).toISOString(), endsAt: new Date(Date.now() + 2 * H).toISOString() });
    const svc = await import('./calendar-connections');
    const original = seed.provider.listChanges.bind(seed.provider);
    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    seed.provider.listChanges = (async (args) => {
      entered();
      await releasePromise;
      return original(args);
    }) as typeof seed.provider.listChanges;
    svc.setCalendarProviderFactoryForTests(() => seed.provider);
    try {
      const first = svc.handleCalendarWebhook(conn.id, { messageId: 'concurrent-message' });
      await enteredPromise;
      const duplicate = await svc.handleCalendarWebhook(conn.id, { messageId: 'concurrent-message' });
      expect(duplicate).toMatchObject({ ok: true, imported: 0, duplicate: true });
      release();
      await expect(first).resolves.toMatchObject({ ok: true, imported: 1, duplicate: false });
      expect(seed.provider.calls.filter((c) => c.op === 'list')).toHaveLength(1);
    } finally {
      svc.setCalendarProviderFactoryForTests(null);
    }
  });

  maybe()('M8-i6 T2: webhook dedupe rows expire through calendar retention without touching mirrors', async () => {
    const seed = await seedConnection({ name: 'm8i6-retention' });
    const conn = await connectionIdOf(seed.userId);
    seed.provider.pushEvent({ externalId: 'retention-event', title: 'Retention', startsAt: new Date(Date.now() + H).toISOString(), endsAt: new Date(Date.now() + 2 * H).toISOString() });
    const svc = await import('./calendar-connections');
    svc.setCalendarProviderFactoryForTests(() => seed.provider);
    try {
      await svc.handleCalendarWebhook(conn.id, { messageId: 'expires-message', now: new Date('2026-09-19T00:00:00.000Z') });
      const { getDb } = await import('../db');
      const { calendarEvents, calendarWebhookDeliveries, sweepCalendarRetention } = await import('@nextdoo/db');
      expect(await getDb().select().from(calendarWebhookDeliveries).where(eq(calendarWebhookDeliveries.connectionId, conn.id))).toHaveLength(1);
      const mirrorsBefore = await getDb().select().from(calendarEvents).where(eq(calendarEvents.connectionId, conn.id));
      expect(mirrorsBefore).toHaveLength(1);
      const swept = await sweepCalendarRetention(getDb(), new Date('2026-09-20T00:00:01.000Z'));
      expect(swept.webhookDeliveries).toBe(1);
      expect(await getDb().select().from(calendarWebhookDeliveries).where(eq(calendarWebhookDeliveries.connectionId, conn.id))).toHaveLength(0);
      expect(await getDb().select().from(calendarEvents).where(eq(calendarEvents.connectionId, conn.id))).toHaveLength(1);
    } finally {
      svc.setCalendarProviderFactoryForTests(null);
    }
  });

  maybe()('M8-i6 T6b: route bucket is token-scoped so one noisy channel cannot starve another', async () => {
    const a = await seedConnection({ name: 'm8i6-fair-a' });
    const b = await seedConnection({ name: 'm8i6-fair-b' });
    const connA = await connectionIdOf(a.userId);
    const connB = await connectionIdOf(b.userId);
    const svc = await import('./calendar-connections');
    const route = await import('../../app/api/v1/calendar/webhook/route');
    const baseNow = Date.parse('2026-09-19T12:00:00.000Z');
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(baseNow);
    svc.setCalendarProviderFactoryForTests((row) => (row?.id === connA.id ? a.provider : b.provider));
    const req = (token: string, ip = '203.0.113.10') => new Request('http://localhost/api/v1/calendar/webhook', {
      method: 'POST',
      headers: { Origin: 'http://localhost', 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
      body: JSON.stringify({ channel: { token } }),
    });
    try {
      for (let i = 0; i < 300; i += 1) {
        expect((await route.POST(req(connA.id))).status).toBe(200);
      }
      const denied = await route.POST(req(connA.id));
      expect(denied.status).toBe(429);
      expect(denied.headers.get('Retry-After')).toBeTruthy();

      // Same source IP, different connection/token: admitted and processed.
      const bRes = await route.POST(req(connB.id));
      expect(bRes.status).toBe(200);
      expect(await bRes.json()).toMatchObject({ ok: true });

      // The exhausted token is admitted after the window rolls over.
      nowSpy.mockReturnValue(baseNow + 60_001);
      expect((await route.POST(req(connA.id))).status).toBe(200);
    } finally {
      nowSpy.mockRestore();
      svc.setCalendarProviderFactoryForTests(null);
    }
  });

  maybe()('M8-i6 T6b: concurrent deliveries on independent buckets are admitted tenant-scoped', async () => {
    const a = await seedConnection({ name: 'm8i6-concurrent-fair-a' });
    const b = await seedConnection({ name: 'm8i6-concurrent-fair-b' });
    const connA = await connectionIdOf(a.userId);
    const connB = await connectionIdOf(b.userId);
    a.provider.pushEvent({ externalId: 'fair-a-event', title: 'Fair A', startsAt: new Date(Date.now() + H).toISOString(), endsAt: new Date(Date.now() + 2 * H).toISOString() });
    b.provider.pushEvent({ externalId: 'fair-b-event', title: 'Fair B', startsAt: new Date(Date.now() + H).toISOString(), endsAt: new Date(Date.now() + 2 * H).toISOString() });
    const route = await import('../../app/api/v1/calendar/webhook/route');
    const svc = await import('./calendar-connections');
    const baseNow = Date.parse('2026-09-19T12:30:00.000Z');
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(baseNow);
    svc.setCalendarProviderFactoryForTests((row) => (row?.id === connA.id ? a.provider : b.provider));
    const req = (token: string) => new Request('http://localhost/api/v1/calendar/webhook', {
      method: 'POST',
      headers: { Origin: 'http://localhost', 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.42' },
      body: JSON.stringify({ channel: { token } }),
    });
    try {
      const [resA, resB] = await Promise.all([route.POST(req(connA.id)), route.POST(req(connB.id))]);
      expect(resA.status).toBe(200);
      expect(resB.status).toBe(200);
      expect(await resA.json()).toMatchObject({ ok: true });
      expect(await resB.json()).toMatchObject({ ok: true });
      const start = new Date(Date.now() - H).toISOString();
      const end = new Date(Date.now() + 24 * H).toISOString();
      expect((await svc.listCalendarEvents(a.userId, start, end)).map((e) => e.title)).toEqual(['Fair A']);
      expect((await svc.listCalendarEvents(b.userId, start, end)).map((e) => e.title)).toEqual(['Fair B']);
    } finally {
      nowSpy.mockRestore();
      svc.setCalendarProviderFactoryForTests(null);
    }
  });

  maybe()('M8-i6 T6b: missing-token traffic is IP-guarded and does not affect valid token buckets', async () => {
    const seed = await seedConnection({ name: 'm8i6-invalid-guard' });
    const conn = await connectionIdOf(seed.userId);
    const route = await import('../../app/api/v1/calendar/webhook/route');
    const svc = await import('./calendar-connections');
    const ip = '203.0.113.99';
    const baseNow = Date.parse('2026-09-19T13:00:00.000Z');
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(baseNow);
    svc.setCalendarProviderFactoryForTests(() => seed.provider);
    const missing = () => new Request('http://localhost/api/v1/calendar/webhook', {
      method: 'POST',
      headers: { Origin: 'http://localhost', 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
      body: JSON.stringify({ resource: 'ignored' }),
    });
    const valid = () => new Request('http://localhost/api/v1/calendar/webhook', {
      method: 'POST',
      headers: { Origin: 'http://localhost', 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
      body: JSON.stringify({ channel: { token: conn.id } }),
    });
    try {
      for (let i = 0; i < 300; i += 1) {
        const res = await route.POST(missing());
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: false, imported: 0 });
      }
      expect((await route.POST(missing())).status).toBe(429);
      // Valid token traffic has an independent token bucket and still processes.
      expect((await route.POST(valid())).status).toBe(200);
      nowSpy.mockReturnValue(baseNow + 60_001);
      expect((await route.POST(missing())).status).toBe(200);
    } finally {
      nowSpy.mockRestore();
      svc.setCalendarProviderFactoryForTests(null);
    }
  });

  // ------------------------------------------------------------------
  // M7-i2 — import correctness (G1 recurring-instance identity, G2
  // deleted-event mirror cleanup). Same fixture-provider discipline as
  // the M7-i1 suite: deterministic, zero network.
  // ------------------------------------------------------------------

  const seriesInstances = (prefix: string) => [
    { originalStartTime: '2026-09-13T09:00:00.000Z', title: `${prefix} A`, startsAt: '2026-09-13T09:00:00.000Z', endsAt: '2026-09-13T09:30:00.000Z' },
    { originalStartTime: '2026-09-14T09:00:00.000Z', title: `${prefix} B`, startsAt: '2026-09-14T09:00:00.000Z', endsAt: '2026-09-14T09:30:00.000Z' },
  ];

  maybe()('M7-i2 G1: instances of one series import as distinct mirror rows (idempotent, cursor persisted)', async () => {
    const seed = await seedConnection({ name: 'g1import' });
    const conn = await connectionIdOf(seed.userId);
    const { runCalendarImport } = await import('@nextdoo/db');
    const { getDb } = await import('../db');
    const { calendarEvents } = await import('@nextdoo/db');

    seed.provider.pushSeries('series-1', seriesInstances('Standup'));
    const first = await runCalendarImport({ db: getDb(), connectionId: conn.id, provider: seed.provider });
    expect(first.imported).toBe(2);
    let rows = await getDb().select().from(calendarEvents).where(eq(calendarEvents.connectionId, conn.id));
    expect(rows.map((r) => r.externalId).sort()).toEqual(['series-1!2026-09-13T09:00:00.000Z', 'series-1!2026-09-14T09:00:00.000Z']);
    expect(rows.map((r) => r.title).sort()).toEqual(['Standup A', 'Standup B']);
    // The engine persists the provider's checkpoint (the fixture reports
    // 'tok-2-2' for a 2-entry store on both of the next two calls).
    const after = await connectionIdOf(seed.userId);
    expect(after.syncToken).toBe('tok-2-2');
    expect(after.lastSyncedAt).not.toBeNull();

    // Re-import: same two rows — no duplicate, no collapse into one.
    const second = await runCalendarImport({ db: getDb(), connectionId: conn.id, provider: seed.provider });
    expect(second.imported).toBe(2);
    rows = await getDb().select().from(calendarEvents).where(eq(calendarEvents.connectionId, conn.id));
    expect(rows).toHaveLength(2);
    expect((await connectionIdOf(seed.userId)).syncToken).toBe('tok-2-2');
  });

  maybe()('M7-i2 G1: updating one occurrence leaves sibling occurrences untouched', async () => {
    const seed = await seedConnection({ name: 'g1update' });
    const conn = await connectionIdOf(seed.userId);
    const { runCalendarImport } = await import('@nextdoo/db');
    const { getDb } = await import('../db');
    const { calendarEvents } = await import('@nextdoo/db');

    seed.provider.pushSeries('series-1', seriesInstances('Standup'));
    await runCalendarImport({ db: getDb(), connectionId: conn.id, provider: seed.provider });

    // Google reschedules + renames only the first occurrence (same
    // original slot → same per-occurrence key).
    seed.provider.pushEvent({ externalId: 'series-1!2026-09-13T09:00:00.000Z', recurringEventId: 'series-1', title: 'Standup A (moved)', startsAt: '2026-09-13T15:00:00.000Z', endsAt: '2026-09-13T15:30:00.000Z', updatedAt: '2026-09-12T00:00:00.000Z' });
    await runCalendarImport({ db: getDb(), connectionId: conn.id, provider: seed.provider });

    const rows = await getDb().select().from(calendarEvents).where(eq(calendarEvents.connectionId, conn.id));
    const a = rows.find((r) => r.externalId === 'series-1!2026-09-13T09:00:00.000Z');
    const b = rows.find((r) => r.externalId === 'series-1!2026-09-14T09:00:00.000Z');
    expect(a!.title).toBe('Standup A (moved)');
    expect(a!.startsAt.toISOString()).toBe('2026-09-13T15:00:00.000Z');
    // The sibling occurrence is byte-for-byte untouched.
    expect(b!.title).toBe('Standup B');
    expect(b!.startsAt.toISOString()).toBe('2026-09-14T09:00:00.000Z');
  });

  maybe()('M7-i2 G1: cancelling one occurrence removes only its mirror row (idempotently)', async () => {
    const seed = await seedConnection({ name: 'g1cancel' });
    const conn = await connectionIdOf(seed.userId);
    const { runCalendarImport } = await import('@nextdoo/db');
    const { getDb } = await import('../db');
    const { calendarEvents } = await import('@nextdoo/db');

    seed.provider.pushSeries('series-1', seriesInstances('Standup'));
    await runCalendarImport({ db: getDb(), connectionId: conn.id, provider: seed.provider });

    seed.provider.deleteEventExternal('series-1!2026-09-13T09:00:00.000Z');
    const out = await runCalendarImport({ db: getDb(), connectionId: conn.id, provider: seed.provider });
    expect(out.unscheduledTasks).toBe(0); // no mapping involved
    let rows = await getDb().select().from(calendarEvents).where(eq(calendarEvents.connectionId, conn.id));
    expect(rows.map((r) => r.externalId)).toEqual(['series-1!2026-09-14T09:00:00.000Z']); // sibling survives

    // The provider keeps re-reporting the deletion; re-imports are no-ops.
    await runCalendarImport({ db: getDb(), connectionId: conn.id, provider: seed.provider });
    rows = await getDb().select().from(calendarEvents).where(eq(calendarEvents.connectionId, conn.id));
    expect(rows.map((r) => r.externalId)).toEqual(['series-1!2026-09-14T09:00:00.000Z']);
  });

  maybe()('M7-i2 G1: cancelling the whole series removes every instance, not other series', async () => {
    const seed = await seedConnection({ name: 'g1series' });
    const conn = await connectionIdOf(seed.userId);
    const { runCalendarImport } = await import('@nextdoo/db');
    const { getDb } = await import('../db');
    const { calendarEvents } = await import('@nextdoo/db');

    seed.provider.pushSeries('series-1', seriesInstances('Standup'));
    seed.provider.pushSeries('series-2', [seriesInstances('Lunch')[0]!]);
    await runCalendarImport({ db: getDb(), connectionId: conn.id, provider: seed.provider });
    let rows = await getDb().select().from(calendarEvents).where(eq(calendarEvents.connectionId, conn.id));
    expect(rows).toHaveLength(3);

    seed.provider.deleteSeriesExternal('series-1');
    await runCalendarImport({ db: getDb(), connectionId: conn.id, provider: seed.provider });
    rows = await getDb().select().from(calendarEvents).where(eq(calendarEvents.connectionId, conn.id));
    expect(rows.map((r) => r.externalId)).toEqual(['series-2!2026-09-13T09:00:00.000Z']); // only the other series survives
  });

  maybe()('M7-i2 G2: deleting a non-mapped event removes its stale mirror row (idempotently)', async () => {
    const seed = await seedConnection({ name: 'g2plain' });
    const conn = await connectionIdOf(seed.userId);
    const { runCalendarImport } = await import('@nextdoo/db');
    const { getDb } = await import('../db');
    const { calendarEvents } = await import('@nextdoo/db');

    seed.provider.pushEvent({ externalId: 'ext-x', title: 'One-off', startsAt: '2026-09-13T10:00:00.000Z', endsAt: '2026-09-13T11:00:00.000Z' });
    seed.provider.pushSeries('series-9', [seriesInstances('Keep')[0]!]);
    await runCalendarImport({ db: getDb(), connectionId: conn.id, provider: seed.provider });
    let rows = await getDb().select().from(calendarEvents).where(eq(calendarEvents.connectionId, conn.id));
    expect(rows.map((r) => r.externalId).sort()).toEqual(['ext-x', 'series-9!2026-09-13T09:00:00.000Z']);

    seed.provider.deleteEventExternal('ext-x');
    await runCalendarImport({ db: getDb(), connectionId: conn.id, provider: seed.provider });
    rows = await getDb().select().from(calendarEvents).where(eq(calendarEvents.connectionId, conn.id));
    expect(rows.map((r) => r.externalId)).toEqual(['series-9!2026-09-13T09:00:00.000Z']); // stale block gone, sibling event intact

    // Re-import: the re-reported deletion stays a no-op.
    await runCalendarImport({ db: getDb(), connectionId: conn.id, provider: seed.provider });
    rows = await getDb().select().from(calendarEvents).where(eq(calendarEvents.connectionId, conn.id));
    expect(rows.map((r) => r.externalId)).toEqual(['series-9!2026-09-13T09:00:00.000Z']);
  });

  maybe()('M7-i2 G2: deleting a MAPPED event also removes its mirror row (AC-3 semantics intact)', async () => {
    const seed = await seedConnection({ name: 'g2mapped' });
    const conn = await connectionIdOf(seed.userId);
    const task = await seedTask(seed.workspaceId, 'Mapped event', 9 * H);
    seed.provider.pushEvent({ externalId: 'ext-mapped', title: 'Mapped', startsAt: task.dueAt!.toISOString(), endsAt: new Date(task.dueAt!.getTime() + H).toISOString(), updatedAt: '2026-09-05T00:00:00.000Z' });
    await seedMapping(seed, task, 'ext-mapped');

    const { runCalendarImport } = await import('@nextdoo/db');
    const { getDb } = await import('../db');
    const { tasks, notifications, calendarMappings, calendarEvents } = await import('@nextdoo/db');

    await runCalendarImport({ db: getDb(), connectionId: conn.id, provider: seed.provider }); // mirror exists
    expect((await getDb().select().from(calendarEvents).where(eq(calendarEvents.connectionId, conn.id))).map((r) => r.externalId)).toEqual(['ext-mapped']);

    seed.provider.deleteEventExternal('ext-mapped');
    const out = await runCalendarImport({ db: getDb(), connectionId: conn.id, provider: seed.provider });
    expect(out.unscheduledTasks).toBe(1);
    const [after] = await getDb().select().from(tasks).where(eq(tasks.id, task.id));
    expect(after!.dueAt).toBeNull();
    expect(await getDb().select().from(calendarMappings).where(eq(calendarMappings.connectionId, conn.id))).toHaveLength(0);
    const notes = await getDb().select().from(notifications).where(eq(notifications.taskId, task.id));
    expect(notes).toHaveLength(1);
    // The stale availability block is gone too.
    expect(await getDb().select().from(calendarEvents).where(eq(calendarEvents.connectionId, conn.id))).toHaveLength(0);
  });

  maybe()('M7-i2 G1: a task mapped to one occurrence reacts only to that occurrence', async () => {
    const seed = await seedConnection({ name: 'g1mapped' });
    const conn = await connectionIdOf(seed.userId);
    const task = await seedTask(seed.workspaceId, 'Mapped occurrence', 10 * H);
    const keyA = 'series-7!2026-09-13T09:00:00.000Z';
    const keyB = 'series-7!2026-09-14T09:00:00.000Z';
    seed.provider.pushSeries('series-7', seriesInstances('Occurrence'));
    await seedMapping(seed, task, keyA, { externalUpdatedAt: new Date('2026-09-01T00:00:00.000Z') });

    const { runCalendarImport } = await import('@nextdoo/db');
    const { getDb } = await import('../db');
    const { tasks, calendarEvents, calendarMappings } = await import('@nextdoo/db');
    const taskRow = async () => {
      const [row] = await getDb().select().from(tasks).where(eq(tasks.id, task.id));
      return row!;
    };

    // Baseline: the fixture's default updatedAt predates the mapping's
    // externalUpdatedAt → nothing is applied yet.
    await runCalendarImport({ db: getDb(), connectionId: conn.id, provider: seed.provider });
    expect((await taskRow()).dueAt!.toISOString()).toBe(task.dueAt!.toISOString());

    // Google moves the MAPPED occurrence A (same original slot → same key):
    // the task follows A's new time.
    seed.provider.pushEvent({ externalId: keyA, recurringEventId: 'series-7', title: 'Occurrence A (moved)', startsAt: '2026-09-13T16:00:00.000Z', endsAt: '2026-09-13T16:30:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z' });
    const out1 = await runCalendarImport({ db: getDb(), connectionId: conn.id, provider: seed.provider });
    expect(out1.externalApplied).toBe(1);
    expect(out1.conflicts).toBe(0);
    expect((await taskRow()).dueAt!.toISOString()).toBe('2026-09-13T16:00:00.000Z');

    // Google moves the SIBLING occurrence B: the task must NOT follow.
    seed.provider.pushEvent({ externalId: keyB, recurringEventId: 'series-7', title: 'Occurrence B (moved)', startsAt: '2026-09-14T18:00:00.000Z', endsAt: '2026-09-14T18:30:00.000Z', updatedAt: '2026-09-03T00:00:00.000Z' });
    const out2 = await runCalendarImport({ db: getDb(), connectionId: conn.id, provider: seed.provider });
    expect(out2.externalApplied).toBe(0);
    expect(out2.conflicts).toBe(0);
    expect((await taskRow()).dueAt!.toISOString()).toBe('2026-09-13T16:00:00.000Z'); // unchanged

    // Cancelling the mapped occurrence unschedules the task; sibling B's
    // mirror survives; the mapping is released.
    seed.provider.deleteEventExternal(keyA);
    const out3 = await runCalendarImport({ db: getDb(), connectionId: conn.id, provider: seed.provider });
    expect(out3.unscheduledTasks).toBe(1);
    expect((await taskRow()).dueAt).toBeNull();
    const rows = await getDb().select().from(calendarEvents).where(eq(calendarEvents.connectionId, conn.id));
    expect(rows.map((r) => r.externalId)).toEqual([keyB]);
    expect(await getDb().select().from(calendarMappings).where(eq(calendarMappings.connectionId, conn.id))).toHaveLength(0);
  });

  maybe()('M7-i2: series-level mirror cleanup is connection-scoped (tenant isolation)', async () => {
    const a = await seedConnection({ name: 'iso-a' });
    const b = await seedConnection({ name: 'iso-b' });
    const connA = await connectionIdOf(a.userId);
    const connB = await connectionIdOf(b.userId);
    // Both (simulated) providers hold the SAME series id.
    a.provider.pushSeries('shared-series', seriesInstances('Shared'));
    b.provider.pushSeries('shared-series', seriesInstances('Shared'));

    const { runCalendarImport } = await import('@nextdoo/db');
    const { getDb } = await import('../db');
    const { calendarEvents } = await import('@nextdoo/db');
    const rowsOf = (id: string) => getDb().select().from(calendarEvents).where(eq(calendarEvents.connectionId, id));

    await runCalendarImport({ db: getDb(), connectionId: connA.id, provider: a.provider });
    await runCalendarImport({ db: getDb(), connectionId: connB.id, provider: b.provider });
    expect(await rowsOf(connA.id)).toHaveLength(2);
    expect(await rowsOf(connB.id)).toHaveLength(2);

    // The series is deleted on A's provider only.
    a.provider.deleteSeriesExternal('shared-series');
    await runCalendarImport({ db: getDb(), connectionId: connA.id, provider: a.provider });
    expect(await rowsOf(connA.id)).toHaveLength(0);
    expect(await rowsOf(connB.id)).toHaveLength(2); // B's rows untouched by A's import

    // B's provider still has the series → B's import keeps B's rows.
    await runCalendarImport({ db: getDb(), connectionId: connB.id, provider: b.provider });
    expect(await rowsOf(connB.id)).toHaveLength(2);
  });
});
