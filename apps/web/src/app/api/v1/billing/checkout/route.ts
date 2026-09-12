import { createHash } from 'node:crypto';
import { z } from 'zod';
import { authedRoute, parseBody } from '@/server/http';
import { getDb } from '@/server/db';
import { getEnv } from '@/server/env';
import { requireProvider } from '@/server/billing';
import { startCheckout } from '@nextdoo/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const checkoutSchema = z.object({
  plan: z.enum(['PRO', 'TEAM', 'ENTERPRISE']),
  provider: z.enum(['STRIPE', 'RAZORPAY']),
});

/**
 * PRD §10.7: start checkout for a paid subscription (M1: direct purchase —
 * approved decision B; trials stay modeled but are not offered).
 *
 * Idempotent (PRD §10.7: every mutation requires an Idempotency-Key). The
 * response is a checkout HANDOFF only — entitlements change exclusively via
 * signature-verified provider webhooks; the client never trusts the checkout
 * round-trip as proof of payment.
 *
 * Unconfigured provider: 503 PROVIDER_UNAVAILABLE (fail loud, no stub).
 */
export const POST = authedRoute(
  { routeName: 'billing.checkout', idempotent: true, rateLimitPerMinute: 12 },
  async (request, ctx) => {
    const { plan, provider: providerName } = await parseBody(request, checkoutSchema);
    const provider = requireProvider(providerName);
    const env = getEnv();
    return startCheckout(getDb(), provider, {
      userId: ctx.auth.userId,
      workspaceId: ctx.auth.workspaceId,
      plan,
      successUrl: `${env.APP_URL}/billing/success`,
      cancelUrl: `${env.APP_URL}/billing/cancel`,
      requestId: ctx.requestId,
      ipHash: createIpHash(ctx.ip),
    });
  },
);

function createIpHash(ip: string): string {
  return createHash('sha256').update(ip).digest('hex').slice(0, 64);
}
