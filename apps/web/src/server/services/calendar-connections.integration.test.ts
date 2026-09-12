import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

/**
 * Calendar connections — provider-aware capacity input (PRD §13.2, §14.3,
 * §18.1 entitlements, SD-04).
 *
 * Covers: the plan limit on ACTIVE connections, the one-connection-per-provider
 * rule, token sealing (never plaintext, never in views), tenant isolation,
 * soft disconnect, and the entitlement-change hook (suspend / reactivate,
 * never delete). Each test uses a fresh user; rows are inserted directly only
 * where a verified provider exchange would not yet exist (future providers).
 */

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:55432/nextdoo';
const TOKEN = 'ya29.a0AfH6SE_example-provider-token-value';

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
      email: `calconn-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`,
      passwordHash: 'scrypt$deadbeef$deadbeef',
      name,
      timeZone: 'UTC',
    }).then((u) => ({ id: u.id, workspaceId: u.workspaceId }));
}, 30000);

/** Seed a connection row directly — simulates a verified exchange for a future provider. */
async function seedConnection(userId: string, workspaceId: string, provider: string, status: 'ACTIVE' | 'SUSPENDED' | 'DISCONNECTED' = 'ACTIVE') {
  const { getDb } = await import('../db');
  const { calendarConnections } = await import('@nextdoo/db');
  const [row] = await getDb()
    .insert(calendarConnections)
    .values({
      id: crypto.randomUUID(),
      userId,
      workspaceId,
      provider,
      status,
      mode: 'READ_ONLY',
      accessTokenEncrypted: 'v1.seeded.seeded.seeded',
    })
    .returning();
  return row!;
}

describe('calendar connections (integration)', () => {
  maybe()('lists only the user own connections and never exposes token fields', async () => {
    const { listConnections, upsertVerifiedConnection } = await import('./calendar-connections');
    const a = await freshUser('list-a');
    const b = await freshUser('list-b');
    expect(await listConnections(a.id)).toEqual([]);

    const view = await upsertVerifiedConnection(a.id, a.workspaceId, { provider: 'google', accessToken: TOKEN });
    expect(view.status).toBe('ACTIVE');
    expect(view.provider).toBe('google');

    const listed = await listConnections(a.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.id).toBe(view.id);
    expect(JSON.stringify(listed)).not.toContain(TOKEN);
    expect(listed[0]).not.toHaveProperty('accessToken');
    // Tenant isolation: B sees nothing of A's.
    expect(await listConnections(b.id)).toEqual([]);
  });

  maybe()('seals tokens at rest and round-trips them', async () => {
    const { listConnections, upsertVerifiedConnection } = await import('./calendar-connections');
    const { getDb } = await import('../db');
    const { calendarConnections } = await import('@nextdoo/db');
    const { decryptSecret } = await import('../crypto');
    const user = await freshUser('seal');

    await upsertVerifiedConnection(user.id, user.workspaceId, { provider: 'google', accessToken: TOKEN });
    const listed = await listConnections(user.id);
    const [row] = await getDb().select().from(calendarConnections).where(eq(calendarConnections.id, listed[0]!.id));
    expect(row).toBeDefined();
    expect(row!.accessTokenEncrypted).toBeTruthy();
    expect(row!.accessTokenEncrypted).not.toContain(TOKEN);
    expect(row!.accessTokenEncrypted!.startsWith('v1.')).toBe(true);
    expect(decryptSecret(row!.accessTokenEncrypted!, 'calendar_token')).toBe(TOKEN);
  });

  maybe()('rejects unsupported providers and missing tokens', async () => {
    const { upsertVerifiedConnection, listConnections } = await import('./calendar-connections');
    const user = await freshUser('reject');
    await expect(upsertVerifiedConnection(user.id, user.workspaceId, { provider: 'outlook', accessToken: TOKEN })).rejects.toThrow(/Unsupported calendar provider/);
    await expect(upsertVerifiedConnection(user.id, user.workspaceId, { provider: 'google', accessToken: '   ' })).rejects.toThrow(/verified access token/);
    expect(await listConnections(user.id)).toEqual([]);
  });

  maybe()('enforces the plan limit on a genuinely new provider', async () => {
    const { upsertVerifiedConnection } = await import('./calendar-connections');
    const user = await freshUser('limit'); // FREE → 1 connection
    // Rows a future verified exchange would have created:
    await seedConnection(user.id, user.workspaceId, 'outlook');
    await seedConnection(user.id, user.workspaceId, 'caldav');
    await expect(upsertVerifiedConnection(user.id, user.workspaceId, { provider: 'google', accessToken: TOKEN })).rejects.toThrow(
      /plan allows 1 calendar connection/,
    );
  });

  maybe()('re-exchanging the same provider replaces credentials without consuming a slot', async () => {
    const { upsertVerifiedConnection, listConnections } = await import('./calendar-connections');
    const user = await freshUser('reconnect'); // FREE → 1 connection
    // Another provider already holds the free slot:
    await seedConnection(user.id, user.workspaceId, 'outlook');
    // A fresh google connection must be refused…
    await expect(upsertVerifiedConnection(user.id, user.workspaceId, { provider: 'google', accessToken: TOKEN })).rejects.toThrow(/plan allows 1/);
    // …but once google exists (e.g. from a past higher plan), re-exchange is free:
    const existing = await seedConnection(user.id, user.workspaceId, 'google', 'SUSPENDED');
    const before = await upsertVerifiedConnection(user.id, user.workspaceId, { provider: 'google', accessToken: TOKEN, externalAccountId: 'acct-1' });
    expect(before.id).toBe(existing.id);
    expect(before.status).toBe('ACTIVE');
    const after = await upsertVerifiedConnection(user.id, user.workspaceId, { provider: 'google', accessToken: 'new-token-value', externalAccountId: 'acct-2' });
    expect(after.id).toBe(before.id);
    expect(after.status).toBe('ACTIVE');

    const listed = await listConnections(user.id);
    expect(listed.filter((c) => c.provider === 'google')).toHaveLength(1);
  });

  maybe()('disconnect is a soft, tenant-scoped state change', async () => {
    const { listConnections, disconnectConnection, upsertVerifiedConnection } = await import('./calendar-connections');
    const { getDb } = await import('../db');
    const { calendarConnections } = await import('@nextdoo/db');
    const a = await freshUser('disc-a');
    const b = await freshUser('disc-b');

    await upsertVerifiedConnection(b.id, b.workspaceId, { provider: 'google', accessToken: TOKEN });
    const google = (await listConnections(b.id)).find((c) => c.provider === 'google')!;

    // A cannot disconnect B's connection (404; no cross-tenant state read).
    await expect(disconnectConnection(a.id, google.id)).rejects.toThrow();
    expect((await listConnections(b.id)).find((c) => c.id === google.id)!.status).toBe('ACTIVE');

    const result = await disconnectConnection(b.id, google.id);
    expect(result.status).toBe('DISCONNECTED');
    expect(result).not.toHaveProperty('accessTokenEncrypted');

    const [row] = await getDb().select().from(calendarConnections).where(eq(calendarConnections.id, google.id));
    expect(row!.status).toBe('DISCONNECTED');
    expect(row!.disconnectedAt).toBeInstanceOf(Date);
    expect(row!.accessTokenEncrypted).toBeTruthy(); // retained, never deleted

    // Re-connecting a disconnected provider must fit the plan again.
    const reconnected = await upsertVerifiedConnection(b.id, b.workspaceId, { provider: 'google', accessToken: 'fresh-token' });
    expect(reconnected.id).toBe(google.id);
    expect(reconnected.status).toBe('ACTIVE');
  });

  maybe()('suspends over-limit connections on downgrade and reactivates on upgrade — never deletes', async () => {
    const user = await freshUser('planchange');
    const { applyCalendarPlanChange, listConnections } = await import('./calendar-connections');

    // PRO (limit 3): three ACTIVE connections (rows a verified exchange creates).
    await applyCalendarPlanChange(user.id, 'PRO');
    await seedConnection(user.id, user.workspaceId, 'google');
    await seedConnection(user.id, user.workspaceId, 'outlook');
    await seedConnection(user.id, user.workspaceId, 'caldav');
    expect((await listConnections(user.id)).filter((c) => c.status === 'ACTIVE')).toHaveLength(3);

    // Downgrade to FREE (limit 1): the two NEWEST are suspended, the oldest kept.
    const down = await applyCalendarPlanChange(user.id, 'FREE');
    expect(down).toEqual({ suspended: 2, reactivated: 0 });
    let listed = await listConnections(user.id);
    expect(listed).toHaveLength(3); // rows retained
    expect(listed.filter((c) => c.status === 'ACTIVE').map((c) => c.provider)).toEqual(['google']);
    expect(listed.filter((c) => c.status === 'SUSPENDED').map((c) => c.provider).sort()).toEqual(['caldav', 'outlook']);

    // Upgrade back: suspended rows are re-activated up to the limit.
    const up = await applyCalendarPlanChange(user.id, 'PRO');
    expect(up).toEqual({ suspended: 0, reactivated: 2 });
    listed = await listConnections(user.id);
    expect(listed.filter((c) => c.status === 'ACTIVE')).toHaveLength(3);

    // No-op when already within the limit.
    expect(await applyCalendarPlanChange(user.id, 'PRO')).toEqual({ suspended: 0, reactivated: 0 });
  });

  maybe()('reports connection state for the capacity rule per user and workspace', async () => {
    const { capacityConnectionState, upsertVerifiedConnection } = await import('./calendar-connections');
    const { getDb } = await import('../db');
    const { calendarConnections } = await import('@nextdoo/db');
    const a = await freshUser('state-a');
    const b = await freshUser('state-b');

    expect(await capacityConnectionState(a.id, a.workspaceId)).toEqual({ connected: false, syncedThrough: null });

    await upsertVerifiedConnection(b.id, b.workspaceId, { provider: 'google', accessToken: TOKEN });
    // ACTIVE but never synced → no horizon.
    expect(await capacityConnectionState(b.id, b.workspaceId)).toEqual({ connected: true, syncedThrough: null });

    const horizon = new Date(Date.UTC(2026, 8, 11, 0, 0, 0));
    const [row] = await getDb().select().from(calendarConnections).where(eq(calendarConnections.userId, b.id));
    await getDb().update(calendarConnections).set({ lastSyncedAt: horizon }).where(eq(calendarConnections.id, row!.id));
    expect(await capacityConnectionState(b.id, b.workspaceId)).toEqual({ connected: true, syncedThrough: horizon });

    // B's connections never count for A's workspace.
    expect(await capacityConnectionState(a.id, b.workspaceId)).toEqual({ connected: false, syncedThrough: null });
  });
});
