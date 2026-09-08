import { createHash } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { AppError } from '@nextdoo/contracts';
import { recoveryCodes, users } from '@nextdoo/db';
import {
  generateRecoveryCodes,
  generateTotpSecret,
  normaliseRecoveryCode,
  totpUri,
  verifyTotp,
} from '@nextdoo/core';
import { getDb } from '../db';
import { newId } from '../ids';
import { decryptSecret, encryptSecret } from '../crypto';
import { writeAuditLog } from './events';

/**
 * Optional TOTP MFA (PRD §6.2).
 *
 * Enrolment is two-step: a secret is generated and stored encrypted but
 * inactive, and only becomes active once the user proves they can produce a
 * code from it. Otherwise a mis-scanned QR would lock the account out.
 */

/** Recovery codes are single-use credentials, so only their hash is kept. */
function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(normaliseRecoveryCode(code)).digest('hex');
}

export interface EnrolmentStart {
  secret: string;
  uri: string;
}

export async function startMfaEnrolment(userId: string): Promise<EnrolmentStart> {
  const db = getDb();
  const rows = await db.select({ email: users.email, mfaEnabledAt: users.mfaEnabledAt }).from(users).where(eq(users.id, userId)).limit(1);
  const user = rows[0];
  if (!user) throw new AppError('NOT_FOUND', 'Account not found.');
  if (user.mfaEnabledAt) {
    throw new AppError('VALIDATION_FAILED', 'Two-factor authentication is already enabled. Disable it first to re-enrol.');
  }

  const secret = generateTotpSecret();
  // Stored encrypted and still inactive: mfaEnabledAt stays null until confirmed.
  await db
    .update(users)
    .set({ mfaSecretEncrypted: encryptSecret(secret), updatedAt: new Date() })
    .where(eq(users.id, userId));

  return { secret, uri: totpUri(secret, user.email) };
}

export async function confirmMfaEnrolment(userId: string, token: string): Promise<{ recoveryCodes: string[] }> {
  const db = getDb();
  const rows = await db
    .select({ secret: users.mfaSecretEncrypted, enabledAt: users.mfaEnabledAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const user = rows[0];
  if (!user?.secret) throw new AppError('VALIDATION_FAILED', 'Start enrolment before confirming it.');
  if (user.enabledAt) throw new AppError('VALIDATION_FAILED', 'Two-factor authentication is already enabled.');

  if (!verifyTotp(decryptSecret(user.secret), token).valid) {
    throw new AppError('VALIDATION_FAILED', 'That code is not valid. Check your authenticator app and try again.');
  }

  const codes = generateRecoveryCodes(10);

  await db.transaction(async (tx) => {
    await tx.update(users).set({ mfaEnabledAt: new Date(), updatedAt: new Date() }).where(eq(users.id, userId));
    await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
    await tx.insert(recoveryCodes).values(codes.map((code) => ({ id: newId(), userId, codeHash: hashRecoveryCode(code) })));
  });

  await writeAuditLog({ userId, action: 'account.mfa_enabled', entityType: 'user', entityId: userId });

  // Returned exactly once — they are not recoverable afterwards.
  return { recoveryCodes: codes };
}

export async function disableMfa(userId: string, token: string): Promise<void> {
  const db = getDb();
  const rows = await db
    .select({ secret: users.mfaSecretEncrypted, enabledAt: users.mfaEnabledAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const user = rows[0];
  if (!user?.enabledAt || !user.secret) {
    throw new AppError('VALIDATION_FAILED', 'Two-factor authentication is not enabled.');
  }

  // Disabling lowers account security, so it must be authenticated too.
  const valid = verifyTotp(decryptSecret(user.secret), token).valid || (await consumeRecoveryCode(userId, token));
  if (!valid) throw new AppError('VALIDATION_FAILED', 'That code is not valid.');

  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ mfaSecretEncrypted: null, mfaEnabledAt: null, updatedAt: new Date() })
      .where(eq(users.id, userId));
    await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
  });

  await writeAuditLog({ userId, action: 'account.mfa_disabled', entityType: 'user', entityId: userId });
}

/**
 * Marks a recovery code used, atomically. The WHERE used_at IS NULL clause means
 * two concurrent attempts with the same code cannot both succeed.
 */
export async function consumeRecoveryCode(userId: string, code: string): Promise<boolean> {
  const db = getDb();
  const updated = await db
    .update(recoveryCodes)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(recoveryCodes.userId, userId),
        eq(recoveryCodes.codeHash, hashRecoveryCode(code)),
        isNull(recoveryCodes.usedAt),
      ),
    )
    .returning({ id: recoveryCodes.id });

  if (updated.length > 0) {
    await writeAuditLog({ userId, action: 'account.recovery_code_used', entityType: 'user', entityId: userId });
    return true;
  }
  return false;
}

export interface MfaChallenge {
  required: boolean;
  verify: (token: string) => Promise<boolean>;
}

/** Used by the login flow to decide whether a second factor is needed. */
export async function getMfaChallenge(userId: string): Promise<MfaChallenge> {
  const db = getDb();
  const rows = await db
    .select({ secret: users.mfaSecretEncrypted, enabledAt: users.mfaEnabledAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const user = rows[0];
  if (!user?.enabledAt || !user.secret) {
    return { required: false, verify: async () => true };
  }

  const secret = decryptSecret(user.secret);
  return {
    required: true,
    // A recovery code is accepted anywhere a TOTP code is, which is the point
    // of having them.
    verify: async (token: string) =>
      verifyTotp(secret, token).valid || consumeRecoveryCode(userId, token),
  };
}

export async function getMfaStatus(userId: string): Promise<{ enabled: boolean; recoveryCodesRemaining: number }> {
  const db = getDb();
  const [user] = await db.select({ enabledAt: users.mfaEnabledAt }).from(users).where(eq(users.id, userId)).limit(1);
  const remaining = await db
    .select({ id: recoveryCodes.id })
    .from(recoveryCodes)
    .where(and(eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt)));

  return { enabled: Boolean(user?.enabledAt), recoveryCodesRemaining: remaining.length };
}
