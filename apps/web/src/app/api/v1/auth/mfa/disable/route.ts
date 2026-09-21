import { createSession, setSessionCookie } from '@/server/auth';
import { withAccountTransaction } from '@/server/account-security';
import { mfaCodeSchema } from '@nextdoo/contracts';
import { authedRoute, parseBody } from '@/server/http';
import { disableMfa } from '@/server/services/mfa';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = authedRoute({ routeName: 'auth.mfa_disable', rateLimitPerMinute: 10 }, async (request, ctx) => {
  return withAccountTransaction(ctx.auth.userId, async () => {
  const input = await parseBody(request, mfaCodeSchema);
  await disableMfa(ctx.auth.userId, input.code);
  await setSessionCookie(await createSession(ctx.auth.userId, 'web'));
  return { status: 'ok', enabled: false };
  });
});
