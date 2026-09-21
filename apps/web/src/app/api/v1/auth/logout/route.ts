import { clearSessionCookie, revokeSession } from '@/server/auth';
import { authedRoute } from '@/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = authedRoute({ routeName: 'auth.logout' }, async (_request, ctx) => {
  await revokeSession(ctx.auth.sessionId, ctx.auth.userId);
  await clearSessionCookie();
  return { ok: true };
});
