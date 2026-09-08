import { mfaVerifySchema } from '@nextdoo/contracts';
import { authedRoute, parseBody } from '@/server/http';
import { confirmMfaEnrolment } from '@/server/services/mfa';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Recovery codes are returned once here and never again. */
export const POST = authedRoute({ routeName: 'auth.mfa_confirm', rateLimitPerMinute: 10 }, async (request, ctx) => {
  const input = await parseBody(request, mfaVerifySchema);
  return confirmMfaEnrolment(ctx.auth.userId, input.code);
});
