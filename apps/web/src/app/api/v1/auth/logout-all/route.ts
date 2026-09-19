import { authedRoute } from '@/server/http';
import { revokeAllForUser } from '@/server/services/account-sessions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * PRD §6.1 "revoke all sessions" (user decision, M6-i5): revokes EVERY active
 * session of the caller, INCLUDING the caller's own. The caller is logged out
 * by this call.
 */
export const POST = authedRoute({ routeName: 'auth.logout_all', rateLimitPerMinute: 10, idempotent: true }, async (_request, ctx) => {
  const revoked = await revokeAllForUser(ctx.auth.userId);
  return { revoked };
});
