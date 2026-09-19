import { authedRoute } from '@/server/http';
import { getVapidPublicKey } from '@/server/services/push-subscriptions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * M8-i1 (PRD §6.6): the VAPID public key the browser uses to subscribe.
 * Authenticated (session-scoped opt-in flow); answers 503
 * PROVIDER_UNAVAILABLE when the deployment has no VAPID configuration.
 */
export const GET = authedRoute({ routeName: 'push.public_key' }, async (_r, ctx) =>
  getVapidPublicKey({ userId: ctx.auth.userId }),
);
