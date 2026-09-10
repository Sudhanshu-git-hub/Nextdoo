import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

/**
 * Daily capacity planning (PRD §5.2, §8.3) — server-side acceptance.
 *
 * Workload is summed over the FULL collection (not loaded pages), capacity is
 * only claimed when fully known (no active provider connections, or all of
 * them synced through the day), and tenant isolation holds: one user's
 * connections/workload never leak into another's day.
 */

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:55432/nextdoo';
const DATE = '2026-09-10';
const DAY_START = new Date(Date.UTC(2026, 8, 10)); // workspace timezone is UTC
const NEXT_DAY_START = new Date(Date.UTC(2026, 8, 11));
const TOKEN = 'cap-test-provider-token';

async function probe(): Promise<true> {
  const { requireTestDatabase } = await import('../../../../../tests/database');
  return requireTestDatabase();
}

const available = await probe();
const maybe = () => (available ? it : it.skip);

interface User { id: string; workspaceId: string }

let freshUser: (name: string) => Promise<User>;

beforeAll(async () => {
  if (!available) return;
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.AUTH_SECRET ??= 'test-only-secret-0123456789abcdefghij';
  const { registerUser } = await import('./accounts');
  freshUser = (name) =>
    registerUser({
      email: `capacity-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`,
      passwordHash: 'scrypt$deadbeef$deadbeef',
      name,
      timeZone: 'UTC',
    }).then((u) => ({ id: u.id, workspaceId: u.workspaceId }));
}, 30000);

async function seedTask(workspaceId: string, estimateMinutes: number, dueAt: Date, status: 'ACTIVE' | 'COMPLETED' | 'ARCHIVED' = 'ACTIVE', deletedAt: Date | null = null) {
  const { getDb } = await import('../db');
  const { tasks } = await import('@nextdoo/db');
  const [row] = await getDb()
    .insert(tasks)
    .values({
      id: crypto.randomUUID(),
      workspaceId,
      title: `Capacity seed ${crypto.randomUUID().slice(0, 8)}`,
      status,
      priority: 'NONE',
      estimateMinutes,
      dueAt,
      timeZone: 'UTC',
      deletedAt,
    })
    .returning();
  return row!;
}

async function seedEvent(connectionId: string, workspaceId: string, startsAt: Date, endsAt: Date, isAllDay = false, busy = true, externalId?: string) {
  const { getDb } = await import('../db');
  const { calendarEvents } = await import('@nextdoo/db');
  await getDb().insert(calendarEvents).values({
    id: crypto.randomUUID(),
    connectionId,
    workspaceId,
    externalId: externalId ?? `ext-${crypto.randomUUID().slice(0, 8)}`,
    startsAt,
    endsAt,
    isAllDay,
    busy,
  });
}

describe('daily capacity (integration)', () => {
  maybe()('reports the configured workday as capacity with an empty day', async () => {
    const user = await freshUser('empty');
    const { getDayCapacity } = await import('./capacity');
    const r = await getDayCapacity(user.id, user.workspaceId, DATE);
    expect(r).toMatchObject({
      date: DATE,
      timeZone: 'UTC',
      workdayMinutes: 480,
      workloadMinutes: 0,
      busyMinutes: 0,
      capacityMinutes: 480,
      overByMinutes: 0,
      status: 'OK',
      providerConnected: false,
      providerSyncedThrough: null,
    });
  });

  maybe()('sums workload over the full collection, excluding other days and non-active tasks', async () => {
    const user = await freshUser('workload');
    const { getDayCapacity } = await import('./capacity');

    await seedTask(user.workspaceId, 60, new Date(Date.UTC(2026, 8, 10, 9, 0)));
    await seedTask(user.workspaceId, 90, new Date(Date.UTC(2026, 8, 10, 12, 0)));
    await seedTask(user.workspaceId, 120, new Date(Date.UTC(2026, 8, 10, 15, 0)));
    await seedTask(user.workspaceId, 999, new Date(Date.UTC(2026, 8, 9, 9, 0))); // previous day
    await seedTask(user.workspaceId, 999, new Date(Date.UTC(2026, 8, 11, 9, 0))); // next day
    await seedTask(user.workspaceId, 999, new Date(Date.UTC(2026, 8, 10, 10, 0)), 'COMPLETED');
    await seedTask(user.workspaceId, 999, new Date(Date.UTC(2026, 8, 10, 10, 0)), 'ACTIVE', new Date()); // soft-deleted

    const r = await getDayCapacity(user.id, user.workspaceId, DATE);
    expect(r.workloadMinutes).toBe(270);
    expect(r.status).toBe('OK');
  });

  maybe()('counts tasks due exactly at the day start, not at the next day start', async () => {
    const user = await freshUser('boundary');
    const { getDayCapacity } = await import('./capacity');
    await seedTask(user.workspaceId, 30, DAY_START); // exactly 00:00 → in
    await seedTask(user.workspaceId, 45, NEXT_DAY_START); // exactly next 00:00 → out
    const r = await getDayCapacity(user.id, user.workspaceId, DATE);
    expect(r.workloadMinutes).toBe(30);
  });

  // Regression: the day window must be a full LOCAL day. In positive-offset
  // zones (UTC+14) local midnight lands on the PREVIOUS UTC date, so
  // "next local midnight" is NOT "start + 1 UTC day". The old UTC-day math
  // collapsed the window to zero and reported workload 0 for a busy day.
  maybe()('keeps the workload window a full local day in a positive-offset zone (UTC+14 date rollover)', async () => {
    const user = await freshUser('kiritimati');
    const { getDayCapacity } = await import('./capacity');
    const { updateWorkspaceSettings } = await import('./workspaces');
    await updateWorkspaceSettings(
      { userId: user.id, workspaceId: user.workspaceId, requestId: 'test' },
      user.workspaceId,
      { version: 1, timeZone: 'Pacific/Kiritimati' },
    );
    // Local 2026-09-11 in Kiritimati spans UTC [2026-09-10 10:00, 2026-09-11 10:00).
    await seedTask(user.workspaceId, 120, new Date(Date.UTC(2026, 8, 10, 22, 0))); // local 09-11 12:00 → in
    await seedTask(user.workspaceId, 999, new Date(Date.UTC(2026, 8, 9, 11, 0)));  // local 09-10 01:00 → prev day
    await seedTask(user.workspaceId, 999, new Date(Date.UTC(2026, 8, 11, 10, 0))); // local 09-12 00:00 → next day
    const r = await getDayCapacity(user.id, user.workspaceId, '2026-09-11');
    expect(r.workloadMinutes).toBe(120);
    expect(r.status).toBe('OK');
    // The previous local day is a distinct, non-empty window.
    const prev = await getDayCapacity(user.id, user.workspaceId, '2026-09-10');
    expect(prev.workloadMinutes).toBe(999);
  });

  maybe()('flags overload against the workday with the exact overshoot', async () => {
    const user = await freshUser('overload');
    const { getDayCapacity } = await import('./capacity');
    await seedTask(user.workspaceId, 490, new Date(Date.UTC(2026, 8, 10, 10, 0)));
    const r = await getDayCapacity(user.id, user.workspaceId, DATE);
    expect(r.status).toBe('OVERLOADED');
    expect(r.capacityMinutes).toBe(480);
    expect(r.overByMinutes).toBe(10);
  });

  maybe()('refuses to claim capacity while a connection has not synced through the day', async () => {
    const user = await freshUser('unknown');
    const { upsertVerifiedConnection } = await import('./calendar-connections');
    const { getDayCapacity } = await import('./capacity');
    await seedTask(user.workspaceId, 490, new Date(Date.UTC(2026, 8, 10, 10, 0)));
    await upsertVerifiedConnection(user.id, user.workspaceId, { provider: 'google', accessToken: TOKEN });

    const r = await getDayCapacity(user.id, user.workspaceId, DATE);
    expect(r).toMatchObject({
      status: 'CAPACITY_UNKNOWN',
      capacityMinutes: null,
      busyMinutes: null,
      overByMinutes: null,
      workloadMinutes: 490,
      providerConnected: true,
      providerSyncedThrough: null,
    });
  });

  maybe()('computes capacity from provider busy time once every connection has synced', async () => {
    const user = await freshUser('synced');
    const { getDb } = await import('../db');
    const { calendarConnections } = await import('@nextdoo/db');
    const { upsertVerifiedConnection } = await import('./calendar-connections');
    const { getDayCapacity } = await import('./capacity');

    const conn = await upsertVerifiedConnection(user.id, user.workspaceId, { provider: 'google', accessToken: TOKEN });
    // Synced through the end of the planned day:
    await getDb().update(calendarConnections).set({ lastSyncedAt: new Date(Date.UTC(2026, 8, 11, 0, 0, 0)) }).where(eq(calendarConnections.id, conn.id));

    await seedTask(user.workspaceId, 400, new Date(Date.UTC(2026, 8, 10, 10, 0)));
    await seedEvent(conn.id, user.workspaceId, new Date(Date.UTC(2026, 8, 10, 10, 0)), new Date(Date.UTC(2026, 8, 10, 12, 0))); // 120 busy
    await seedEvent(conn.id, user.workspaceId, new Date(Date.UTC(2026, 8, 10, 11, 30)), new Date(Date.UTC(2026, 8, 10, 12, 30))); // overlaps → union 150
    await seedEvent(conn.id, user.workspaceId, new Date(Date.UTC(2026, 8, 9, 0, 0)), new Date(Date.UTC(2026, 8, 10, 1, 0))); // ends before window → clipped to 0
    await seedEvent(conn.id, user.workspaceId, new Date(Date.UTC(2026, 8, 10, 0, 0)), new Date(Date.UTC(2026, 8, 10, 23, 59)), false, false); // free-busy → ignored
    await seedEvent(conn.id, user.workspaceId, new Date(Date.UTC(2026, 8, 11, 0, 0)), new Date(Date.UTC(2026, 8, 11, 6, 0)), true); // all-day, next day → outside

    const r = await getDayCapacity(user.id, user.workspaceId, DATE);
    expect(r.status).toBe('OVERLOADED');
    expect(r.busyMinutes).toBe(150);
    expect(r.capacityMinutes).toBe(330);
    expect(r.workloadMinutes).toBe(400);
    expect(r.overByMinutes).toBe(70);
    expect(r.providerSyncedThrough).toBe(new Date(Date.UTC(2026, 8, 11, 0, 0, 0)).toISOString());
  });

  maybe()('tracks capacity when the workday setting changes', async () => {
    const user = await freshUser('workday');
    const { getDayCapacity } = await import('./capacity');
    const { loadWorkspaceSettings, updateWorkspaceSettings } = await import('./workspaces');

    await seedTask(user.workspaceId, 300, new Date(Date.UTC(2026, 8, 10, 10, 0)));
    expect((await getDayCapacity(user.id, user.workspaceId, DATE)).status).toBe('OK');

    const before = await loadWorkspaceSettings(user.workspaceId, user.workspaceId);
    const after = await updateWorkspaceSettings({ userId: user.id, workspaceId: user.workspaceId, requestId: 'test' }, user.workspaceId, {
      version: before.version,
      workdayStartMinute: 540,
      workdayEndMinute: 720, // 9:00-12:00 → 180
    });
    expect(after.workdayEndMinute).toBe(720);
    const r = await getDayCapacity(user.id, user.workspaceId, DATE);
    expect(r.workdayMinutes).toBe(180);
    expect(r.status).toBe('OVERLOADED');
    expect(r.overByMinutes).toBe(120);
  });

  maybe()('rejects invalid date keys without touching the database', async () => {
    const user = await freshUser('baddate');
    const { getDayCapacity } = await import('./capacity');
    await expect(getDayCapacity(user.id, user.workspaceId, 'not-a-date')).rejects.toThrow(/YYYY-MM-DD/);
    await expect(getDayCapacity(user.id, user.workspaceId, '2026-02-30')).rejects.toThrow(/real calendar date/);
  });

  maybe()('is tenant isolated: foreign workspaces are never another user day', async () => {
    const a = await freshUser('iso-a');
    const b = await freshUser('iso-b');
    const { upsertVerifiedConnection } = await import('./calendar-connections');
    const { getDayCapacity } = await import('./capacity');

    await seedTask(a.workspaceId, 400, new Date(Date.UTC(2026, 8, 10, 10, 0)));
    await upsertVerifiedConnection(a.id, a.workspaceId, { provider: 'google', accessToken: TOKEN });

    // A's day is unknown (connected, unsynced) with A's workload…
    const aDay = await getDayCapacity(a.id, a.workspaceId, DATE);
    expect(aDay).toMatchObject({ status: 'CAPACITY_UNKNOWN', workloadMinutes: 400 });

    // …but B's own day is clean: no leaked workload, no leaked connection.
    const bDay = await getDayCapacity(b.id, b.workspaceId, DATE);
    expect(bDay).toMatchObject({ status: 'OK', workloadMinutes: 0, providerConnected: false, capacityMinutes: 480 });
  });
});
