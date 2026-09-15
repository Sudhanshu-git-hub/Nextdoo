import { runLoginAttempt } from '@/server/login-throttle';
import { withAccountTransaction } from '@/server/account-security';
import { AppError, loginSchema } from '@nextdoo/contracts';
import { createSession, setSessionCookie, verifyPassword } from '@/server/auth';
import { publicRoute, parseBody } from '@/server/http';
import { findUserByEmail } from '@/server/services/accounts';
import { getMfaChallenge } from '@/server/services/mfa';
import { cancelAccountDeletion } from '@/server/services/data-rights';
import { writeAuditLog } from '@/server/services/events';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = publicRoute({ routeName: 'auth.login', rateLimitPerMinute: 10 }, async (request, ctx) => {
  const input = await parseBody(request, loginSchema);
  return runLoginAttempt(input.email, ctx.ip, async () => {
  const candidate = await findUserByEmail(input.email);
  if (!candidate) throw new AppError('UNAUTHENTICATED', 'Email or password is incorrect.');
  return withAccountTransaction(candidate.id, async () => {
  const user = await findUserByEmail(input.email);

  // Uniform failure: never reveal whether the address exists.
  const invalid = new AppError('UNAUTHENTICATED', 'Email or password is incorrect.');
  if (!user || user.deletedAt || user.status !== 'ACTIVE') throw invalid;
  if (!(await verifyPassword(user.passwordHash, input.password))) throw invalid;

  const challenge = await getMfaChallenge(user.id);
  if (challenge.required) {
    if (!input.totp) {
      // Password was correct but a second factor is outstanding. No session is
      // issued, and the response says nothing beyond "a code is needed".
      throw new AppError('MFA_REQUIRED', 'Enter the code from your authenticator app.');
    }
    if (!(await challenge.verify(input.totp))) {
      await writeAuditLog({ userId: user.id, action: 'account.mfa_failed', entityType: 'user', entityId: user.id });
      throw new AppError('UNAUTHENTICATED', 'That code is not valid.');
    }
  }

  // Signing in during the grace window is an unambiguous signal the account is
  // still wanted, so a pending deletion is cancelled.
  if (user.deletionRequestedAt) await cancelAccountDeletion(user.id);

  const token = await createSession(user.id, 'web');
  await setSessionCookie(token);

  await writeAuditLog({ userId: user.id, action: 'account.signed_in', entityType: 'user', entityId: user.id });

  return {
    id: user.id,
    email: user.email,
    workspaceId: user.workspaceId,
    deletionCancelled: Boolean(user.deletionRequestedAt),
  };
  });
  });
});
