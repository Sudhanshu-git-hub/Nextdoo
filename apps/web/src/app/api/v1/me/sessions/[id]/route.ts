import { authedRoute } from '@/server/http';
import { revokeOwnedSession } from '@/server/services/account-sessions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * PRD §6.1/§14.3 — individual, owner-only session revocation. Revoking the
 * caller's own session is allowed and immediately ends that client.
 * 204 on success; unknown or foreign ids are a uniform 404 (no leak).
 */
export const DELETE = authedRoute({ routeName: 'me.session.revoke', rateLimitPerMinute: 60, idempotent: true }, async (request, ctx) => {
  const id = new URL(request.url).pathname.split('/').pop() ?? '';
  await revokeOwnedSession(ctx.auth.userId, id);
  return null;
});
