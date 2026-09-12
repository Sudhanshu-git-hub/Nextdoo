import { and, eq, gt, isNull } from 'drizzle-orm';
import { AppError, uuid } from '@nextdoo/contracts';
import { sessions, users } from '@nextdoo/db';
import { getDb } from '../db';
import { revokeAllSessions, revokeSession } from '../auth';
import { writeAuditLog } from './events';

/**
 * Account profile and session management (PRD §6.1, §14.3).
 *
 * Every operation here is owner-scoped: a user can read or revoke only their
 * own profile and sessions. Revocation is a database flag checked on EVERY
 * request (see resolveSession), so a revoked session is rejected on its very
 * next request — the PRD's 60-second bound is structural, not a timer.
 *
 * Session views never expose the token hash or the IP hash: the database
 * stores digests, and the list response carries only display fields.
 */

export interface ProfileView {
  id: string;
  email: string;
  name: string | null;
  timeZone: string;
  mfaEnabled: boolean;
  createdAt: Date;
}

export interface SessionView {
  id: string;
  deviceLabel: string | null;
  lastSeenAt: Date;
  createdAt: Date;
  current: boolean;
}

/** IANA time zone validation: rejects anything Intl does not accept. */
export function assertValidTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat('en', { timeZone });
  } catch {
    throw new AppError('VALIDATION_FAILED', 'That is not a recognized time zone (use IANA names like "Asia/Kolkata").', {
      fieldErrors: [{ path: 'timeZone', message: 'Unrecognized time zone.' }],
    });
  }
}

export async function getProfile(userId: string): Promise<ProfileView> {
  const db = getDb();
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      timeZone: users.timeZone,
      mfaEnabledAt: users.mfaEnabledAt,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) throw new AppError('NOT_FOUND', 'Account not found.');
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    timeZone: row.timeZone,
    mfaEnabled: row.mfaEnabledAt !== null,
    createdAt: row.createdAt,
  };
}

export interface ProfilePatch {
  name?: string | null;
  timeZone?: string;
}

export async function updateProfile(userId: string, patch: ProfilePatch): Promise<ProfileView> {
  const db = getDb();
  const changes: Record<string, unknown> = {};

  if (patch.name !== undefined) {
    if (patch.name !== null && (patch.name.length < 1 || patch.name.length > 120)) {
      throw new AppError('VALIDATION_FAILED', 'Display name must be 1–120 characters.', {
        fieldErrors: [{ path: 'name', message: 'Must be 1–120 characters.' }],
      });
    }
    changes.name = patch.name;
  }
  if (patch.timeZone !== undefined) {
    assertValidTimeZone(patch.timeZone);
    changes.timeZone = patch.timeZone;
  }

  await db.update(users).set(changes).where(eq(users.id, userId));
  await writeAuditLog({
    userId,
    action: 'account.profile_updated',
    entityType: 'user',
    entityId: userId,
    metadata: { fields: Object.keys(changes) },
  });
  return getProfile(userId);
}

/** Active sessions of one user, most recently seen first. Never leaves the owner's scope. */
export async function listSessions(userId: string, currentSessionId: string): Promise<SessionView[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: sessions.id,
      deviceLabel: sessions.deviceLabel,
      lastSeenAt: sessions.lastSeenAt,
      createdAt: sessions.createdAt,
    })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date())))
    .orderBy(sessions.lastSeenAt)
    .limit(100);
  return rows.map((row) => ({
    id: row.id,
    deviceLabel: row.deviceLabel,
    lastSeenAt: row.lastSeenAt,
    createdAt: row.createdAt,
    current: row.id === currentSessionId,
  }));
}

/**
 * Revokes ONE session that belongs to this user. Unknown ids and ids owned by
 * anyone else are indistinguishable to the caller (NOT_FOUND, no leak).
 */
export async function revokeOwnedSession(userId: string, sessionId: string): Promise<void> {
  let id: string;
  try {
    id = uuid.parse(sessionId);
  } catch {
    throw new AppError('VALIDATION_FAILED', 'Invalid resource identifier.');
  }
  const db = getDb();
  const [row] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.id, id), eq(sessions.userId, userId), isNull(sessions.revokedAt)))
    .limit(1);
  if (!row) throw new AppError('NOT_FOUND', 'This session does not exist.');

  await revokeSession(row.id, userId);
  await writeAuditLog({
    userId,
    action: 'account.session_revoked',
    entityType: 'session',
    entityId: row.id,
  });
}

/**
 * "Sign out everywhere" (user decision, M6-i5): revokes ALL of the user's
 * active sessions, INCLUDING the caller's. Returns how many were revoked.
 */
export async function revokeAllForUser(userId: string): Promise<number> {
  const count = await revokeAllSessions(userId);
  await writeAuditLog({
    userId,
    action: 'account.sessions_revoked_all',
    entityType: 'user',
    entityId: userId,
    metadata: { count },
  });
  return count;
}
