import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { cookies } from 'next/headers';
import { AppError, unauthenticated } from '@nextdoo/contracts';
import { sessions, users, workspaces, workspaceMembers } from '@nextdoo/db';
import { getDb } from './db';
import { deletionExpired, withAccountTransaction } from './account-security';
import { newId } from './ids';
import { logger } from './observability';

/**
 * Session authentication (PRD §6.1, §11.2).
 *
 * Design notes:
 *  - Raw session tokens are never stored. We keep SHA-256 and compare in constant time.
 *  - Cookies are HttpOnly + SameSite=Lax + Secure in production.
 *  - Revocation is a database check on every request, so a revoked session dies
 *    immediately rather than at token expiry.
 */

export const SESSION_COOKIE = 'nextdoo_session';
const SESSION_TTL_DAYS = 30;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Argon2id password hashing.
 * Loaded lazily so that environments without the native binding (e.g. some CI
 * images) can still run non-auth tests; the fallback is scrypt, which is
 * acceptable but weaker, so we log loudly when it is used.
 */
async function argon2() {
  try {
    return await import('@node-rs/argon2');
  } catch {
    return null;
  }
}

export async function hashPassword(password: string): Promise<string> {
  const a2 = await argon2();
  if (a2) {
    return a2.hash(password, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
  }
  logger.warn('argon2 unavailable, using scrypt fallback');
  const { scryptSync } = await import('node:crypto');
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  if (hash.startsWith('scrypt$')) {
    const [, salt, expected] = hash.split('$');
    if (!salt || !expected) return false;
    const { scryptSync } = await import('node:crypto');
    return constantTimeEqual(scryptSync(password, salt, 64).toString('hex'), expected);
  }
  const a2 = await argon2();
  if (!a2) return false;
  try {
    return await a2.verify(hash, password);
  } catch {
    return false;
  }
}

export interface AuthContext {
  userId: string;
  sessionId: string;
  email: string;
  emailVerified: boolean;
  timeZone: string;
  workspaceId: string;
}

/** Creates a session and returns the raw token (shown to the client exactly once). */
export async function createSession(userId: string, deviceLabel?: string): Promise<string> {
  return withAccountTransaction(userId, async (db) => {

  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000);
  await db.insert(sessions).values({
    id: newId(),
    userId,
    tokenHash: hashToken(token),
    deviceLabel: deviceLabel?.slice(0, 200),
    expiresAt,
  });
  return token;
  });
}

export async function setSessionCookie(token: string): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_TTL_DAYS * 86_400,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

/** Resolves the session from a raw token. Returns null rather than throwing. */
export async function resolveSession(token: string | undefined): Promise<AuthContext | null> {
  if (!token) return null;
  const db = getDb();
  const rows = await db
    .select({
      sessionId: sessions.id,
      userId: users.id,
      email: users.email,
      emailVerifiedAt: users.emailVerifiedAt,
      timeZone: users.timeZone,
      userStatus: users.status,
      userDeletedAt: users.deletedAt,
      deletionRequestedAt: users.deletionRequestedAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.tokenHash, hashToken(token)),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, new Date()),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  // A deleted or suspended account must not authenticate (PRD §19.2 #9).
  if (row.userDeletedAt || row.userStatus !== 'ACTIVE' || deletionExpired(row.deletionRequestedAt)) return null;

  const ws = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(and(eq(workspaceMembers.userId, row.userId), eq(workspaceMembers.role, 'OWNER'), eq(workspaces.ownerId, row.userId), isNull(workspaces.deletedAt)))
    .limit(1);

  if (!ws[0]) return null;

  // Best-effort last-seen update; failure must not break the request.
  void db
    .update(sessions)
    .set({ lastSeenAt: new Date() })
    .where(eq(sessions.id, row.sessionId))
    .catch(() => {});

  return {
    userId: row.userId,
    sessionId: row.sessionId,
    email: row.email,
    emailVerified: row.emailVerifiedAt !== null,
    timeZone: row.timeZone,
    workspaceId: ws[0].id,
  };
}

export async function getAuth(): Promise<AuthContext | null> {
  const store = await cookies();
  return resolveSession(store.get(SESSION_COOKIE)?.value);
}

/** Throws UNAUTHENTICATED when there is no valid session. */
export async function requireAuth(): Promise<AuthContext> {
  const auth = await getAuth();
  if (!auth) throw unauthenticated();
  return auth;
}

export async function revokeSession(sessionId: string, userId: string): Promise<void> {
  const db = getDb();
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)));
}

export async function revokeAllSessions(userId: string): Promise<number> {
  const db = getDb();
  const result = await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });
  return result.length;
}

/**
 * Authorization at the resource boundary (PRD §11.3).
 * Every workspace-scoped query must pass through this — never trust a
 * client-supplied workspaceId.
 */
export async function assertWorkspaceAccess(userId: string, workspaceId: string): Promise<void> {
  const db = getDb();
  const rows = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId), eq(workspaceMembers.role, 'OWNER'), eq(workspaces.ownerId, userId), isNull(workspaces.deletedAt)))
    .limit(1);
  if (!rows[0]) {
    throw new AppError('FORBIDDEN', 'You do not have access to this workspace.', {
      resource: { type: 'workspace', id: workspaceId },
    });
  }
}

/** Simple in-process rate limiter used when Redis is not configured. */
const buckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(key: string, limit: number, windowMs: number): { ok: boolean; retryAfter: number } {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfter: 0 };
  }
  bucket.count += 1;
  if (bucket.count > limit) {
    return { ok: false, retryAfter: Math.ceil((bucket.resetAt - now) / 1000) };
  }
  return { ok: true, retryAfter: 0 };
}

export function hashIp(ip: string): string {
  return createHash('sha256').update(`${ip}:${process.env.AUTH_SECRET ?? ''}`).digest('hex').slice(0, 64);
}

export { sql };
