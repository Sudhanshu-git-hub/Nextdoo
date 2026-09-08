import { beforeAll, describe, expect, it } from 'vitest';
import { totp } from '@nextdoo/core';

/**
 * Account security integration tests (PRD §6.2, §12.4).
 *
 * These cover the properties that make the auth surface safe rather than merely
 * functional: tokens are single-use, resets revoke sessions, MFA cannot be
 * bypassed, and deletion is recoverable.
 */

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:55432/nextdoo';

async function probe(): Promise<boolean> {
  try {
    const { default: postgres } = await import('postgres');
    const sql = postgres(DATABASE_URL, { max: 1, connect_timeout: 3 });
    await sql`select 1`;
    await sql.end();
    return true;
  } catch {
    return false;
  }
}

const available = await probe();
const maybe = () => (available ? it : it.skip);

type Ctx = {
  tokens: typeof import('./auth-tokens');
  mfa: typeof import('./mfa');
  rights: typeof import('./data-rights');
  auth: typeof import('../auth');
  db: Awaited<ReturnType<typeof import('../db').getDb>>;
  schema: typeof import('@nextdoo/db');
};

let ctx: Ctx | null = null;

beforeAll(async () => {
  if (!available) return;
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.AUTH_SECRET ??= 'test-only-secret-0123456789abcdefghij';

  const { getDb } = await import('../db');
  ctx = {
    tokens: await import('./auth-tokens'),
    mfa: await import('./mfa'),
    rights: await import('./data-rights'),
    auth: await import('../auth'),
    db: getDb(),
    schema: await import('@nextdoo/db'),
  };
}, 30000);

const PASSWORD = 'integration-password-1';

async function newUser() {
  const { registerUser } = await import('./accounts');
  const { hashPassword } = ctx!.auth;
  return registerUser({
    email: `sec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`,
    passwordHash: await hashPassword(PASSWORD),
    name: 'Security Test',
    timeZone: 'UTC',
  });
}

/**
 * Runs an action and extracts the token from the URL the mailer stub logs.
 * The database only holds a SHA-256, so this is the sole way a test can obtain
 * the raw token a real user would click.
 */
async function captureMailToken(action: () => Promise<void>): Promise<string> {
  const original = console.log;
  let captured: string | null = null;

  console.log = (...args: unknown[]) => {
    const match = /[?&]token=([A-Za-z0-9_-]+)/.exec(args.map(String).join(' '));
    if (match?.[1]) captured = match[1];
    original(...(args as []));
  };

  try {
    await action();
  } finally {
    console.log = original;
  }

  if (!captured) throw new Error('No token was emitted by the mailer');
  return captured;
}

/** Reads the most recent unconsumed token; the mailer stub does not persist URLs. */
async function latestTokenHashCount(userId: string, purpose: string): Promise<number> {
  const { and, eq, isNull } = await import('drizzle-orm');
  const { authTokens } = ctx!.schema;
  const rows = await ctx!.db
    .select({ id: authTokens.id })
    .from(authTokens)
    .where(and(eq(authTokens.userId, userId), eq(authTokens.purpose, purpose), isNull(authTokens.consumedAt)));
  return rows.length;
}

describe('password reset (integration)', () => {
  maybe()('never reveals whether an address has an account', async () => {
    // Both calls must resolve identically; only the absence of a throw is observable.
    await expect(ctx!.tokens.requestPasswordReset('definitely-not-a-user@test.local')).resolves.toBeUndefined();
    const user = await newUser();
    await expect(ctx!.tokens.requestPasswordReset(user.email)).resolves.toBeUndefined();
  });

  maybe()('invalidates a previous reset token when a new one is requested', async () => {
    const user = await newUser();
    await ctx!.tokens.requestPasswordReset(user.email);
    await ctx!.tokens.requestPasswordReset(user.email);

    // Exactly one live token, so an intercepted older link is already dead.
    expect(await latestTokenHashCount(user.id, 'PASSWORD_RESET')).toBe(1);
  });

  maybe()('rejects an unknown or malformed token', async () => {
    await expect(ctx!.tokens.resetPassword('not-a-real-token-value-at-all', 'whatever-password-9')).rejects.toThrow(
      /invalid or has expired/i,
    );
  });

  maybe()('changes the password, revokes every session, and burns the token', async () => {
    const user = await newUser();
    const { eq } = await import('drizzle-orm');
    const { sessions, users } = ctx!.schema;

    // An active session that the reset must terminate.
    await ctx!.auth.createSession(user.id, 'test-device');
    const live = async () => {
      const rows = await ctx!.db.select({ revokedAt: sessions.revokedAt }).from(sessions).where(eq(sessions.userId, user.id));
      return rows.filter((r) => r.revokedAt === null).length;
    };
    expect(await live()).toBe(1);

    const token = await captureMailToken(() => ctx!.tokens.requestPasswordReset(user.email));
    await ctx!.tokens.resetPassword(token, 'a-completely-new-password');

    const [row] = await ctx!.db.select({ hash: users.passwordHash }).from(users).where(eq(users.id, user.id));
    expect(await ctx!.auth.verifyPassword(row!.hash, 'a-completely-new-password')).toBe(true);
    // The old password must no longer work.
    expect(await ctx!.auth.verifyPassword(row!.hash, PASSWORD)).toBe(false);

    // A reset is the remedy for a compromised account, so an attacker who is
    // already signed in must be evicted.
    expect(await live()).toBe(0);

    await expect(ctx!.tokens.resetPassword(token, 'another-password-again')).rejects.toThrow(/invalid or has expired/i);
  });
});

describe('email verification (integration)', () => {
  maybe()('marks the account verified and refuses the token a second time', async () => {
    const user = await newUser();
    const { eq } = await import('drizzle-orm');
    const { users } = ctx!.schema;

    // The raw token only ever exists in the email, so capture it from the
    // mailer call rather than reaching into the table for a hash we cannot reverse.
    const token = await captureMailToken(() => ctx!.tokens.requestEmailVerification(user.id, user.email));

    const [before] = await ctx!.db.select({ v: users.emailVerifiedAt }).from(users).where(eq(users.id, user.id));
    expect(before!.v).toBeNull();

    await ctx!.tokens.verifyEmail(token);

    const [after] = await ctx!.db.select({ v: users.emailVerifiedAt }).from(users).where(eq(users.id, user.id));
    expect(after!.v).not.toBeNull();

    // Single use: a forwarded or logged link cannot be replayed.
    await expect(ctx!.tokens.verifyEmail(token)).rejects.toThrow(/invalid or has expired/i);
  });
});

describe('MFA (integration)', () => {
  maybe()('is inactive until a generated code confirms enrolment', async () => {
    const user = await newUser();

    const { secret } = await ctx!.mfa.startMfaEnrolment(user.id);
    // A mis-scanned QR must not lock the account: still disabled at this point.
    expect((await ctx!.mfa.getMfaStatus(user.id)).enabled).toBe(false);

    const { recoveryCodes } = await ctx!.mfa.confirmMfaEnrolment(user.id, totp(secret));
    expect(recoveryCodes).toHaveLength(10);

    const status = await ctx!.mfa.getMfaStatus(user.id);
    expect(status.enabled).toBe(true);
    expect(status.recoveryCodesRemaining).toBe(10);
  });

  maybe()('refuses to confirm with a wrong code', async () => {
    const user = await newUser();
    await ctx!.mfa.startMfaEnrolment(user.id);
    await expect(ctx!.mfa.confirmMfaEnrolment(user.id, '000000')).rejects.toThrow(/not valid/i);
    expect((await ctx!.mfa.getMfaStatus(user.id)).enabled).toBe(false);
  });

  maybe()('accepts a recovery code exactly once', async () => {
    const user = await newUser();
    const { secret } = await ctx!.mfa.startMfaEnrolment(user.id);
    const { recoveryCodes } = await ctx!.mfa.confirmMfaEnrolment(user.id, totp(secret));
    const code = recoveryCodes[0]!;

    const challenge = await ctx!.mfa.getMfaChallenge(user.id);
    expect(challenge.required).toBe(true);
    expect(await challenge.verify(code)).toBe(true);
    // Spent: a leaked list of codes cannot be replayed.
    expect(await challenge.verify(code)).toBe(false);
    expect((await ctx!.mfa.getMfaStatus(user.id)).recoveryCodesRemaining).toBe(9);
  });

  maybe()('treats a recovery code as valid regardless of its formatting', async () => {
    const user = await newUser();
    const { secret } = await ctx!.mfa.startMfaEnrolment(user.id);
    const { recoveryCodes } = await ctx!.mfa.confirmMfaEnrolment(user.id, totp(secret));

    const challenge = await ctx!.mfa.getMfaChallenge(user.id);
    // Lower-cased and without the separator, as a user might type it.
    expect(await challenge.verify(recoveryCodes[0]!.replace('-', '').toLowerCase())).toBe(true);
  });

  maybe()('reports no challenge for an account without MFA', async () => {
    const user = await newUser();
    const challenge = await ctx!.mfa.getMfaChallenge(user.id);
    expect(challenge.required).toBe(false);
    expect(await challenge.verify('anything')).toBe(true);
  });

  maybe()('clears the secret and recovery codes when disabled', async () => {
    const user = await newUser();
    const { secret } = await ctx!.mfa.startMfaEnrolment(user.id);
    await ctx!.mfa.confirmMfaEnrolment(user.id, totp(secret));

    await ctx!.mfa.disableMfa(user.id, totp(secret));

    const status = await ctx!.mfa.getMfaStatus(user.id);
    expect(status.enabled).toBe(false);
    expect(status.recoveryCodesRemaining).toBe(0);
  });
});

describe('export (integration)', () => {
  maybe()('includes owned data and excludes credentials', async () => {
    const user = await newUser();
    const { createTask } = await import('./tasks');
    await createTask(
      { userId: user.id, workspaceId: user.workspaceId, requestId: 'test' },
      { workspaceId: user.workspaceId, title: 'Exportable task', tagIds: [], priority: 'NONE' } as never,
    );

    const bundle = await ctx!.rights.buildExport(user.id);
    expect(bundle.formatVersion).toBe(1);
    expect(bundle.tasks).toHaveLength(1);
    expect(bundle.workspaces).toHaveLength(1);

    // The archive is a new copy of the user's data; it must not also be a new
    // copy of their credentials.
    const serialised = JSON.stringify(bundle);
    expect(serialised).not.toContain('passwordHash');
    expect(serialised).not.toContain('mfaSecretEncrypted');
  });

  maybe()('does not include another account\'s data', async () => {
    const [mine, theirs] = await Promise.all([newUser(), newUser()]);
    const { createTask } = await import('./tasks');
    await createTask(
      { userId: theirs.id, workspaceId: theirs.workspaceId, requestId: 'test' },
      { workspaceId: theirs.workspaceId, title: 'Not yours', tagIds: [], priority: 'NONE' } as never,
    );

    const bundle = await ctx!.rights.buildExport(mine.id);
    expect(JSON.stringify(bundle)).not.toContain('Not yours');
  });
});

describe('account deletion (integration)', () => {
  maybe()('requires the correct password', async () => {
    const user = await newUser();
    await expect(ctx!.rights.requestAccountDeletion(user.id, 'not-the-password')).rejects.toThrow(/not correct/i);
    expect((await ctx!.rights.getDeletionStatus(user.id)).scheduled).toBe(false);
  });

  maybe()('schedules deletion 30 days out rather than deleting immediately', async () => {
    const user = await newUser();
    const status = await ctx!.rights.requestAccountDeletion(user.id, PASSWORD);

    expect(status.scheduled).toBe(true);
    const days = (Date.parse(status.purgeAfter!) - Date.parse(status.requestedAt!)) / 86_400_000;
    expect(Math.round(days)).toBe(30);
  });

  maybe()('is reversible during the grace period', async () => {
    const user = await newUser();
    await ctx!.rights.requestAccountDeletion(user.id, PASSWORD);
    await ctx!.rights.cancelAccountDeletion(user.id);
    expect((await ctx!.rights.getDeletionStatus(user.id)).scheduled).toBe(false);
  });

  maybe()('leaves accounts alone until their grace period has elapsed', async () => {
    const user = await newUser();
    await ctx!.rights.requestAccountDeletion(user.id, PASSWORD);

    const purged = await ctx!.rights.purgeDueAccounts();
    expect(purged).not.toContain(user.id);
  });

  maybe()('purges once the grace period has passed', async () => {
    const user = await newUser();
    await ctx!.rights.requestAccountDeletion(user.id, PASSWORD);

    // Evaluate as though it were 31 days later, rather than waiting.
    const purged = await ctx!.rights.purgeDueAccounts(new Date(Date.now() + 31 * 86_400_000));
    expect(purged).toContain(user.id);

    const { eq } = await import('drizzle-orm');
    const { users } = ctx!.schema;
    const rows = await ctx!.db.select({ id: users.id }).from(users).where(eq(users.id, user.id));
    expect(rows).toHaveLength(0);
  });

  describe('audit log visibility', () => {
    /**
     * Account-level events are recorded with no workspace (they happen outside
     * a session), so the listing must not filter them out by workspace — this
     * panel exists to show exactly those events.
     */
    maybe()('surfaces workspace-less security events to their owner', async () => {
      const user = await newUser();
      await captureMailToken(() => ctx!.tokens.requestPasswordReset(user.email));

      const entries = await ctx!.rights.listAuditLogs(user.id, user.workspaceId, 50, 'account.');
      const actions = entries.map((e) => e.action);

      expect(actions).toContain('account.registered');
      expect(actions).toContain('account.password_reset_requested');
    });

    maybe()('never returns another user\'s events', async () => {
      const [alice, bob] = await Promise.all([newUser(), newUser()]);
      await captureMailToken(() => ctx!.tokens.requestPasswordReset(bob.email));

      const entries = await ctx!.rights.listAuditLogs(alice.id, alice.workspaceId, 50, 'account.');

      // Alice registered, but Bob's reset request must not appear for her.
      expect(entries.map((e) => e.action)).not.toContain('account.password_reset_requested');
      expect(entries.every((e) => e.targetId === null || e.targetId === alice.id)).toBe(true);
    });

    maybe()('applies the category filter', async () => {
      const user = await newUser();
      const all = await ctx!.rights.listAuditLogs(user.id, user.workspaceId, 50);
      const accountOnly = await ctx!.rights.listAuditLogs(user.id, user.workspaceId, 50, 'account.');

      expect(all.length).toBeGreaterThanOrEqual(accountOnly.length);
      expect(accountOnly.every((e) => e.action.startsWith('account.'))).toBe(true);
    });
  });
});
