import { and, eq, gt, isNull, lt } from 'drizzle-orm';
import { AppError } from '@nextdoo/contracts';
import { authTokens, users } from '@nextdoo/db';
import { getDb, withTransaction } from '../db';
import { withAccountTransaction, deletionExpired } from '../account-security';
import { features } from '../env';
import { newId } from '../ids';
import { generateToken, hashToken, hashPassword, revokeAllSessions } from '../auth';
import { absoluteUrl, sendMail } from '../mailer';
import { writeAuditLog } from './events';
import { logger } from '../observability';

/**
 * Single-use tokens for email verification and password reset (PRD §6.2).
 *
 * Only the SHA-256 of a token is stored, so a database leak does not hand an
 * attacker working reset links. Tokens are consumed inside the same transaction
 * that performs the action they authorise, which is what makes them single-use
 * under concurrency rather than merely by convention.
 */

export type TokenPurpose = 'EMAIL_VERIFICATION' | 'PASSWORD_RESET';

const TTL_MS: Record<TokenPurpose, number> = {
  EMAIL_VERIFICATION: 24 * 60 * 60 * 1000,
  PASSWORD_RESET: 30 * 60 * 1000, // deliberately short: it grants account access
};

async function issueToken(userId: string, purpose: TokenPurpose): Promise<string> {
  return withAccountTransaction(userId, async (db) => {

  const token = generateToken();

  // Outstanding tokens for the same purpose are invalidated, so requesting a
  // new link reliably kills the old one.
  await db
    .update(authTokens)
    .set({ consumedAt: new Date() })
    .where(and(eq(authTokens.userId, userId), eq(authTokens.purpose, purpose), isNull(authTokens.consumedAt)));

  await db.insert(authTokens).values({
    id: newId(),
    userId,
    purpose,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + TTL_MS[purpose]),
  });

  return token;
  });
}

/**
 * Consumes a token atomically.
 *
 * The UPDATE ... WHERE consumed_at IS NULL means two concurrent requests cannot
 * both succeed: exactly one gets a row back.
 */
async function consumeToken(token: string, purpose: TokenPurpose): Promise<string> {
  const db = getDb();
  const [candidate] = await db.select({ userId: authTokens.userId }).from(authTokens)
    .where(and(eq(authTokens.tokenHash, hashToken(token)), eq(authTokens.purpose, purpose))).limit(1);
  if (candidate) await withAccountTransaction(candidate.userId, async () => {});
  const now = new Date();

  const rows = await db
    .update(authTokens)
    .set({ consumedAt: now })
    .where(
      and(
        eq(authTokens.tokenHash, hashToken(token)),
        eq(authTokens.purpose, purpose),
        isNull(authTokens.consumedAt),
        // `gt` binds through Drizzle's column type; a raw `sql` fragment would
        // hand the driver a Date it cannot serialise.
        gt(authTokens.expiresAt, now),
      ),
    )
    .returning({ userId: authTokens.userId });

  const row = rows[0];
  if (!row) {
    // One message for expired, already-used and never-existed: distinguishing
    // them would confirm which tokens were real.
    throw new AppError('VALIDATION_FAILED', 'This link is invalid or has expired. Please request a new one.');
  }
  return row.userId;
}

// ------------------------------------------------------------------ email verification

export async function requestEmailVerification(userId: string, email: string): Promise<void> {
  const token = await issueToken(userId, 'EMAIL_VERIFICATION');
  await sendMail('verify-email', email, absoluteUrl(`/verify-email?token=${token}`));
}

export async function verifyEmail(token: string): Promise<void> {
  return withTransaction( async (db) => {
  const userId = await consumeToken(token, 'EMAIL_VERIFICATION');


  await db
    .update(users)
    .set({ emailVerifiedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(users.id, userId), isNull(users.emailVerifiedAt)));

  await writeAuditLog({ userId, action: 'account.email_verified', entityType: 'user', entityId: userId });
  });
}

// ------------------------------------------------------------------ password reset

/**
 * Always resolves successfully, whether or not the address exists.
 * Returning 404 for an unknown address turns this endpoint into an account
 * enumeration oracle.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  if (process.env.NODE_ENV === 'production' && !features().email) throw new AppError('PROVIDER_UNAVAILABLE', 'Email delivery is not configured.');
  const db = getDb();
  const rows = await db
    .select({ id: users.id, email: users.email, status: users.status, deletionRequestedAt: users.deletionRequestedAt })
    .from(users)
    .where(and(eq(users.email, email.toLowerCase()), isNull(users.deletedAt)))
    .limit(1);

  const user = rows[0];
  if (!user || user.status !== 'ACTIVE' || deletionExpired(user.deletionRequestedAt)) {
    logger.info('auth.reset_requested_unknown_email');
    return;
  }

  const token = await issueToken(user.id, 'PASSWORD_RESET');
  await sendMail('reset-password', user.email, absoluteUrl(`/reset-password?token=${token}`));
  await writeAuditLog({ userId: user.id, action: 'account.password_reset_requested', entityType: 'user', entityId: user.id });
}

export async function resetPassword(token: string, newPassword: string): Promise<void> {
  let email: string | undefined;
  await withTransaction( async (db) => {
  const userId = await consumeToken(token, 'PASSWORD_RESET');

  const passwordHash = await hashPassword(newPassword);

  const rows = await db
    .update(users)
    .set({ passwordHash, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning({ email: users.email });

  // A reset is the remedy for a compromised account, so every existing session
  // must die with it — otherwise an attacker who is already signed in stays in.
  await revokeAllSessions(userId);

  await writeAuditLog({ userId, action: 'account.password_reset', entityType: 'user', entityId: userId });
  email = rows[0]?.email;
  });
  if (email) {
    try { await sendMail('password-changed', email); }
    catch { logger.warn('auth.password_changed_notice_unavailable'); }
  }
}

/** Housekeeping for the worker: consumed and expired tokens are not evidence. */
export async function purgeExpiredAuthTokens(): Promise<number> {
  const db = getDb();
  const deleted = await db
    .delete(authTokens)
    .where(lt(authTokens.expiresAt, new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)))
    .returning({ id: authTokens.id });
  return deleted.length;
}
