import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { authTokens, sessions, users } from '@nextdoo/db';
import { totp } from '@nextdoo/core';
import { requireTestDatabase } from '../../../../../tests/database';
import { getDb } from '../db';
import { registerUser } from './accounts';
import { createSession, hashPassword, resolveSession, verifyPassword } from '../auth';
import { confirmMfaEnrolment, disableMfa, startMfaEnrolment } from './mfa';
import { requestPasswordReset, resetPassword } from './auth-tokens';
import { cancelAccountDeletion } from './data-rights';
import { logger } from '../observability';
const fault = vi.hoisted(() => ({ failResetAudit: false }));
vi.mock('./events', async (original) => {
  const actual = await original<typeof import('./events')>();
  return { ...actual, writeAuditLog: async (...args: Parameters<typeof actual.writeAuditLog>) => {
    if (fault.failResetAudit && args[0].action === 'account.password_reset') throw new Error('injected audit write failure');
    return actual.writeAuditLog(...args);
  } };
});
await requireTestDatabase();
afterEach(() => { fault.failResetAudit = false; vi.restoreAllMocks(); });
const fixture = async () => registerUser({ email: `hardening-${randomUUID()}@test.local`, name: null, passwordHash: await hashPassword('old-test-password-123'), timeZone: 'UTC' });
async function resetToken(email: string) {
  let token = '';
  const original = logger.info;
  vi.spyOn(logger, 'info').mockImplementation((message, context) => {
    if (message === 'mail.stub' && typeof context?.url === 'string') token = new URL(context.url).searchParams.get('token')!;
    else original(message, context);
  });
  await requestPasswordReset(email);
  expect(token).not.toBe('');
  vi.restoreAllMocks();
  return token;
}
it('reset credentials expire in at most thirty minutes', async () => {
  const u = await fixture(); await resetToken(u.email);
  const [t] = await getDb().select().from(authTokens).where(eq(authTokens.userId, u.id));
  expect(t!.expiresAt.getTime() - t!.createdAt.getTime()).toBeLessThanOrEqual(30 * 60000 + 1000);
});
it('reset audit failure rolls back password, token consumption and session revocation together', async () => {
  const u = await fixture(), session = await createSession(u.id), token = await resetToken(u.email);
  fault.failResetAudit = true;
  await expect(resetPassword(token, 'new-test-password-123')).rejects.toThrow('injected');
  const [after] = await getDb().select().from(users).where(eq(users.id, u.id));
  expect(await verifyPassword(after!.passwordHash, 'old-test-password-123')).toBe(true);
  expect(await resolveSession(session)).not.toBeNull();
  expect(await getDb().select().from(authTokens).where(and(eq(authTokens.userId, u.id), isNull(authTokens.consumedAt)))).toHaveLength(1);
  fault.failResetAudit = false;
  await resetPassword(token, 'new-test-password-123');
  expect(await resolveSession(session)).toBeNull();
});
it('concurrent token issuance leaves only one outstanding reset credential', async () => {
  const u = await fixture();
  await Promise.all(Array.from({ length: 5 }, () => requestPasswordReset(u.email)));
  expect(await getDb().select().from(authTokens).where(and(eq(authTokens.userId, u.id), isNull(authTokens.consumedAt)))).toHaveLength(1);
});
it('enabling and disabling MFA invalidate all pre-change sessions', async () => {
  const u = await fixture(), old = await createSession(u.id);
  const { secret } = await startMfaEnrolment(u.id);
  await confirmMfaEnrolment(u.id, totp(secret));
  expect(await resolveSession(old)).toBeNull();
  const newer = await createSession(u.id);
  await disableMfa(u.id, totp(secret));
  expect(await resolveSession(newer)).toBeNull();
});
it('only one concurrent enrollment confirmation returns usable recovery codes', async () => {
  const u = await fixture(), { secret } = await startMfaEnrolment(u.id);
  const results = await Promise.allSettled(Array.from({ length: 3 }, () => confirmMfaEnrolment(u.id, totp(secret))));
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
});
it('expired deletion cannot authenticate, issue a session or cancel itself while waiting for purge', async () => {
  const u = await fixture(), token = await createSession(u.id);
  await getDb().update(users).set({ deletionRequestedAt: new Date(Date.now() - 31 * 86400000) }).where(eq(users.id, u.id));
  expect(await resolveSession(token)).toBeNull();
  await expect(createSession(u.id)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  await expect(cancelAccountDeletion(u.id)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  expect((await getDb().select().from(users).where(eq(users.id, u.id)))[0]!.deletionRequestedAt).not.toBeNull();
  expect(await getDb().select().from(sessions).where(eq(sessions.userId, u.id))).toHaveLength(1);
});
