import { mfaCodeSchema } from '@nextdoo/contracts';
import { authedRoute, parseBody } from '@/server/http';
import { disableMfa } from '@/server/services/mfa';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = authedRoute({ routeName: 'auth.mfa_disable', rateLimitPerMinute: 10 }, async (request, ctx) => {
  const input = await parseBody(request, mfaCodeSchema);
  await disableMfa(ctx.auth.userId, input.code);
  return { status: 'ok', enabled: false };
});
