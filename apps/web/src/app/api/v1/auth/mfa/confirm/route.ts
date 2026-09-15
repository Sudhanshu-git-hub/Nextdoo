import { createSession, setSessionCookie } from '@/server/auth';
import { withAccountTransaction } from '@/server/account-security';
import { mfaVerifySchema } from '@nextdoo/contracts';
import { authedRoute, parseBody } from '@/server/http';
import { confirmMfaEnrolment } from '@/server/services/mfa';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Recovery codes are returned once here and never again. */
export const POST = authedRoute({ routeName: 'auth.mfa_confirm', rateLimitPerMinute: 10 }, async (request, ctx) => {
  return withAccountTransaction(ctx.auth.userId, async () => {
  const input = await parseBody(request, mfaVerifySchema);
  const result = await confirmMfaEnrolment(ctx.auth.userId, input.code);
  await setSessionCookie(await createSession(ctx.auth.userId, 'web'));
  return result;
  });
});
