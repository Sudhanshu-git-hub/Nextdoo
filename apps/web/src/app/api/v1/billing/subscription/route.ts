import { authedRoute } from '@/server/http';
import { getDb } from '@/server/db';
import { getBillingSubscriptionState } from '@nextdoo/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * PRD §10.7 / §18: the server-authoritative subscription view.
 *
 * `plan` is what the subscription row says; `effectivePlan` is what the
 * entitlement engine actually enforces (readEffectivePlan) — they can differ
 * during grace, pending downgrades and paid-period tails. The client displays
 * this; it can never grant or extend access from it (PRD §18.1).
 */
export const GET = authedRoute({ routeName: 'billing.subscription', rateLimitPerMinute: 120 }, async (_request, ctx) => {
  return getBillingSubscriptionState(getDb(), ctx.auth.userId);
});
