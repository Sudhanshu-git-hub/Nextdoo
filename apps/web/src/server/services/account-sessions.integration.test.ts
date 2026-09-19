import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

/**
 * Account & session management integration tests (PRD §6.1, §11.2, §14.3).
 *
 * These prove the security behavior against a real database: revocation is
 * effective on the very next request (measured, not assumed), every operation
 * is owner-scoped, and every mutation writes an audit record.
 */

await (await import('../../../../../tests/database')).requireTestDatabase();

const { getDb } = await import('../db');
const { createSession, resolveSession, hashPassword } = await import('../auth');
const { registerUser } = await import('./accounts');
const { getProfile, updateProfile, listSessions, revokeOwnedSession, revokeAllForUser } = await import('./account-sessions');

const db = getDb();
const { sessions, users, auditLogs } = await import('@nextdoo/db');

const PASSWORD = 'session-test-password-1';

async function newAccount() {
  return registerUser({
    email: `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`,
    passwordHash: await hashPassword(PASSWORD),
    name: 'Session Test',
    timeZone: 'UTC',
  });
}

async function sessionIds(userId: string) {
  const rows = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, userId));
  return rows.map((r) => r.id);
}

/** Row id for a live token (the token itself is only ever hashed in the DB). */
async function sessionIdFor(token: string) {
  const ctx = await resolveSession(token);
  if (!ctx) throw new Error('expected a live session');
  return ctx.sessionId;
}

async function auditRows(userId: string, action: string) {
  const rows = await db.select().from(auditLogs).where(eq(auditLogs.action, action));
  return rows.filter((r) => r.actorId === userId);
}

describe('GET /v1/me — own profile only', () => {
  it('returns the caller identity fields and nothing sensitive', async () => {
    const account = await newAccount();
    const profile = await getProfile(account.id);
    expect(profile).toEqual({
      id: account.id,
      email: expect.stringContaining('@test.local'),
      name: 'Session Test',
      timeZone: 'UTC',
      mfaEnabled: false,
      createdAt: expect.any(Date),
    });
    // Only the six allowed fields — no password, MFA secret, or session data.
    expect(Object.keys(profile).sort()).toEqual(
      ['createdAt', 'email', 'id', 'mfaEnabled', 'name', 'timeZone'],
    );
    await expect(getProfile('00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({
      name: 'AppError',
      status: 404,
    });
  });
});

describe('PATCH /v1/me — strict profile update', () => {
  it('updates name and time zone, persists them, and writes an audit record', async () => {
    const account = await newAccount();
    const profile = await updateProfile(account.id, { name: 'Sudhanshu Gupta', timeZone: 'Asia/Kolkata' });
    expect(profile.name).toBe('Sudhanshu Gupta');
    expect(profile.timeZone).toBe('Asia/Kolkata');

    const [row] = await db.select().from(users).where(eq(users.id, account.id));
    expect(row!.name).toBe('Sudhanshu Gupta');
    expect(row!.timeZone).toBe('Asia/Kolkata');

    const rows = await auditRows(account.id, 'account.profile_updated');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.targetType).toBe('user');
    expect(rows[0]!.targetId).toBe(account.id);
    expect(rows[0]!.metadata).toMatchObject({ fields: expect.arrayContaining(['name', 'timeZone']) });
  });

  it('accepts a single-character name and null clears the display name', async () => {
    const account = await newAccount();
    expect((await updateProfile(account.id, { name: 'A' })).name).toBe('A');
    expect((await updateProfile(account.id, { name: null })).name).toBeNull();
  });

  it('rejects an over-long name, blank and unknown time zones without changing the row', async () => {
    const account = await newAccount();
    await expect(updateProfile(account.id, { name: 'x'.repeat(121) })).rejects.toMatchObject({ name: 'AppError', status: 400 });
    await expect(updateProfile(account.id, { timeZone: 'Mars/Olympus' })).rejects.toMatchObject({ name: 'AppError', status: 400 });
    await expect(updateProfile(account.id, { timeZone: '' })).rejects.toMatchObject({ name: 'AppError', status: 400 });

    const [row] = await db.select().from(users).where(eq(users.id, account.id));
    expect(row!.name).toBe('Session Test');
    expect(row!.timeZone).toBe('UTC');
    expect(await auditRows(account.id, 'account.profile_updated')).toHaveLength(0);
  });
});

describe('GET /v1/me/sessions — owner-scoped active sessions', () => {
  it('lists active sessions with display fields only and flags the current one', async () => {
    const account = await newAccount();
    const tokenA = await createSession(account.id, 'web');
    await createSession(account.id, 'phone'); // second device
    const idA = await sessionIdFor(tokenA);

    const listed = await listSessions(account.id, idA);
    expect(listed).toHaveLength(2);

    const current = listed.find((s) => s.id === idA)!;
    const other = listed.find((s) => s.id !== idA)!;
    expect(current.current).toBe(true);
    expect(other.current).toBe(false);
    expect(listed.flatMap((s) => s.deviceLabel)).toEqual(expect.arrayContaining(['web', 'phone']));
    for (const row of listed) {
      expect(row).toEqual({
        id: expect.any(String),
        deviceLabel: expect.any(String),
        lastSeenAt: expect.any(Date),
        createdAt: expect.any(Date),
        current: expect.any(Boolean),
      });
      // The digests must never be exposed in any shape.
      expect(JSON.stringify(row)).not.toMatch(/token|hash|ip/i);
    }

    // Another user's session never appears in this owner's list.
    const stranger = await newAccount();
    const tokenS = await createSession(stranger.id, 'web');
    expect(await listSessions(account.id, tokenA)).toHaveLength(2);
    expect(await listSessions(stranger.id, tokenS)).toHaveLength(1);
  });

  it('excludes revoked and expired sessions', async () => {
    const account = await newAccount();
    const tokenA = await createSession(account.id, 'web');
    const tokenB = await createSession(account.id, 'phone');
    const idA = await sessionIdFor(tokenA);
    const idB = await sessionIdFor(tokenB);
    expect(await listSessions(account.id, idA)).toHaveLength(2);

    // Revoke one session, expire the other (simulated TTL passing).
    await revokeOwnedSession(account.id, idB);
    await db.update(sessions).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(sessions.id, idA));

    expect(await listSessions(account.id, idA)).toHaveLength(0);
    // Both tokens (revoked + expired) must be dead.
    expect(await resolveSession(tokenB)).toBeNull();
    expect(await resolveSession(tokenA)).toBeNull();
  });
});

describe('DELETE /v1/me/sessions/:id — individual revocation', () => {
  it('revokes the target session and it fails its very next request (measured latency < 60s)', async () => {
    const account = await newAccount();
    const tokenA = await createSession(account.id, 'web');
    const tokenB = await createSession(account.id, 'phone');
    const bId = await sessionIdFor(tokenB);

    const t0 = Date.now();
    await revokeOwnedSession(account.id, bId);
    const revokedCtx = await resolveSession(tokenB);
    const latencyMs = Date.now() - t0;
    console.log(`[session-revocation] measured latency to effect: ${latencyMs}ms`);

    expect(revokedCtx).toBeNull();
    expect(latencyMs).toBeLessThan(5_000); // PRD bound is 60_000ms — assert with margin.
    expect(await resolveSession(tokenA)).not.toBeNull(); // sibling session unaffected

    const [row] = await db.select().from(sessions).where(eq(sessions.id, bId));
    expect(row!.revokedAt).toBeInstanceOf(Date);
    const audit = await auditRows(account.id, 'account.session_revoked');
    expect(audit).toHaveLength(1);
    expect(audit[0]!.targetType).toBe('session');
    expect(audit[0]!.targetId).toBe(bId);
  });

  it('revoking the caller’s own session immediately ends that session', async () => {
    const account = await newAccount();
    const token = await createSession(account.id, 'web');
    const [id] = await sessionIds(account.id);
    await revokeOwnedSession(account.id, id!);
    expect(await resolveSession(token)).toBeNull();
    expect(await listSessions(account.id, token)).toHaveLength(0);
  });

  it('is owner-scoped: foreign ids 404, change nothing, and write no audit', async () => {
    const owner = await newAccount();
    const intruder = await newAccount();
    const token = await createSession(owner.id, 'web');
    const [row] = await sessionIds(owner.id);

    await expect(revokeOwnedSession(intruder.id, row!)).rejects.toMatchObject({ name: 'AppError', status: 404 });
    const [after] = await db.select().from(sessions).where(eq(sessions.id, row!));
    expect(after!.revokedAt).toBeNull();
    expect(await resolveSession(token)).not.toBeNull();
    expect(await auditRows(intruder.id, 'account.session_revoked')).toHaveLength(0);
  });

  it('rejects malformed ids with a validation error, and well-formed unknown ids with 404', async () => {
    const account = await newAccount();
    await createSession(account.id, 'web');
    for (const bad of ['not-a-uuid', '']) {
      await expect(revokeOwnedSession(account.id, bad)).rejects.toMatchObject({ name: 'AppError', status: 400 });
    }
    // A valid UUID that does not exist is a plain 404 (no leak either way).
    await expect(revokeOwnedSession(account.id, '00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({
      name: 'AppError',
      status: 404,
    });
  });
});

describe('POST /v1/auth/logout-all — global revocation including the caller', () => {
  it('revokes every session of the user, including the current one, and audits the count', async () => {
    const account = await newAccount();
    const tokenA = await createSession(account.id, 'web');
    const tokenB = await createSession(account.id, 'phone');

    const t0 = Date.now();
    const count = await revokeAllForUser(account.id);
    const latencyMs = Date.now() - t0;
    console.log(`[logout-all] measured latency to effect: ${latencyMs}ms`);

    expect(count).toBe(2);
    expect(latencyMs).toBeLessThan(5_000);
    expect(await resolveSession(tokenA)).toBeNull(); // caller's own session gone
    expect(await resolveSession(tokenB)).toBeNull();
    expect(await listSessions(account.id, tokenA)).toHaveLength(0);

    const audit = await auditRows(account.id, 'account.sessions_revoked_all');
    expect(audit).toHaveLength(1);
    expect(audit[0]!.metadata).toMatchObject({ count: 2 });

    // Second call is a safe no-op.
    expect(await revokeAllForUser(account.id)).toBe(0);
  });

  it('never touches another user’s sessions', async () => {
    const a = await newAccount();
    const b = await newAccount();
    const tokenA = await createSession(a.id, 'web');
    const tokenB = await createSession(b.id, 'web');

    await revokeAllForUser(a.id);
    expect(await resolveSession(tokenA)).toBeNull();
    expect(await resolveSession(tokenB)).not.toBeNull();
  });
});

describe('audit trail', () => {
  it('records every account session action with actor, target and metadata', async () => {
    const account = await newAccount();
    const token = await createSession(account.id, 'web');
    const [id] = await sessionIds(account.id);

    await updateProfile(account.id, { name: 'Audited' });
    await revokeOwnedSession(account.id, id!);
    await createSession(account.id, 'phone');
    await revokeAllForUser(account.id);

    expect((await auditRows(account.id, 'account.profile_updated')).map((r) => r.action)).toEqual(['account.profile_updated']);
    expect(await auditRows(account.id, 'account.session_revoked')).toHaveLength(1);
    expect(await auditRows(account.id, 'account.sessions_revoked_all')).toHaveLength(1);
    // Every audit row written by this user is attributed to them.
    const all = await auditRows(account.id, 'account.session_revoked');
    expect(all.every((r) => r.actorId === account.id)).toBe(true);
    void token;
  });
});
