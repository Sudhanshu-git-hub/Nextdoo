import { z } from 'zod';
import { pushSubscriptionSchema } from '@nextdoo/contracts';
import { authedRoute, parseBody } from '@/server/http';
import {
  listPushSubscriptions,
  registerPushSubscription,
  removePushSubscription,
} from '@/server/services/push-subscriptions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const removeSchema = z.object({ endpoint: z.string().min(1).max(2048) }).strict();

/** The caller's own push registrations (user-scoped; nothing cross-tenant). */
export const GET = authedRoute({ routeName: 'push.subscriptions_list' }, async (_r, ctx) => {
  const data = await listPushSubscriptions({ userId: ctx.auth.userId });
  return { data };
});

/**
 * Registers a Web Push subscription for the caller. Idempotent: re-registering
 * the same endpoint is a no-op (unique (user, endpoint)). The feature is gated
 * on a complete VAPID configuration (503 PROVIDER_UNAVAILABLE otherwise).
 */
export const POST = authedRoute({ routeName: 'push.subscribe', idempotent: true, rateLimitPerMinute: 60 }, async (request, ctx) => {
  return registerPushSubscription({ userId: ctx.auth.userId }, await parseBody(request, pushSubscriptionSchema));
});

/** Removes one of the caller's own registrations by endpoint. Idempotent. */
export const DELETE = authedRoute({ routeName: 'push.unsubscribe', rateLimitPerMinute: 60 }, async (request, ctx) => {
  const input = await parseBody(request, removeSchema);
  return removePushSubscription({ userId: ctx.auth.userId }, input);
});
