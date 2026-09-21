import { createHash } from 'node:crypto';
import { AppError } from '@nextdoo/contracts';
import { publicRoute } from '@/server/http';
import { getDb } from '@/server/db';
import { requireProvider } from '@/server/billing';
import { handleBillingEvent } from '@nextdoo/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * PRD §10.7 / §18.3 / threat model: the webhook ingress for BOTH providers.
 *
 * Provider selection is by the signature header's presence — the app does not
 * trust any client-chosen claim about which vendor sent the body:
 *   `Stripe-Signature`        -> STRIPE
 *   `x-razorpay-signature`    -> RAZORPAY
 *
 * Pipeline (all server-side, per provider):
 *   1. signature verification + timestamp/replay window (reject 401);
 *   2. normalization to the internal BillingEvent (unrelated events acked);
 *   3. per-provider event-id deduplication (duplicates acked, not re-applied);
 *   4. tenant resolution through THIS provider's stored mapping only;
 *   5. version-fenced state-machine application + audit (PRD §18.3).
 *
 * Always 200 once accepted so the provider does not retry forever; failures
 * are expressed by the problem+json code, and the raw event is retained in
 * billing_events (or audited as skipped/unresolved) for reconciliation.
 */
export const POST = publicRoute({ routeName: 'billing.webhook', rateLimitPerMinute: 600 }, async (request, ctx) => {
  const rawBody = await request.text();
  if (!rawBody) throw new AppError('VALIDATION_FAILED', 'Webhook body is required.');

  const stripeSignature = request.headers.get('stripe-signature');
  const razorpaySignature = request.headers.get('x-razorpay-signature');
  if (stripeSignature === null && razorpaySignature === null) {
    throw new AppError('VALIDATION_FAILED', 'No recognized provider webhook signature.');
  }
  if (stripeSignature !== null && razorpaySignature !== null) {
    throw new AppError('VALIDATION_FAILED', 'Ambiguous provider webhook signature.');
  }

  const provider = requireProvider(stripeSignature !== null ? 'STRIPE' : 'RAZORPAY');
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  // Step 1 — untrusted until proven: signature + replay window.
  const { occurredAt } = await provider.verifyWebhook(rawBody, headers);

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw new AppError('VALIDATION_FAILED', 'Webhook body must be valid JSON.');
  }

  // Step 2 — normalize; events without subscription meaning are acked+ignored.
  const event = provider.normalizeEvent(payload);
  if (!event) return { received: true, ignored: true };

  // Steps 3–5 — dedup, tenant resolution, version-fenced application, audit.
  const result = await handleBillingEvent(getDb(), {
    event,
    payload,
    occurredAt,
    requestId: ctx.requestId,
    ipHash: createIpHash(ctx.ip),
  });

  return {
    received: true,
    ignored: false,
    duplicate: result.duplicate,
    applied: result.applied,
    unresolved: result.unresolved,
  };
});

function createIpHash(ip: string): string {
  return createHash('sha256').update(ip).digest('hex').slice(0, 64);
}
