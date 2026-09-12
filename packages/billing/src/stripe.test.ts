import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@nextdoo/contracts';
import { StripeProvider } from './adapters/stripe';
import { verifyStripeSignature } from './signature';

/**
 * Hermetic Stripe adapter coverage: signature verification with GENERATED
 * test secrets (no live configuration), and adapter behavior against a stubbed
 * fetch. Live checkout/webhook delivery is explicitly OUT of scope here.
 */

const SECRET = 'whsec_generated_test_secret';
const SK = 'sk_test_generated';
const PLANS = { PRO: 'price_test_pro', TEAM: 'price_test_team', ENTERPRISE: 'price_test_ent' } as const;
// Derived from the real clock: verifyWebhook checks the replay window against
// Date.now(), so the tests' "now" must be the actual current second. All other
// offsets are relative to NOW_S, so the suite stays deterministic.
const NOW_S = Math.floor(Date.now() / 1000);
const NOW_MS = NOW_S * 1000;

function provider(fetchImpl: typeof fetch = vi.fn() as unknown as typeof fetch) {
  return StripeProvider.create({ secretKey: SK, webhookSecret: SECRET, plans: PLANS }, fetchImpl);
}

function signedHeader(payload: string, secret: string = SECRET, t: number = NOW_S) {
  const v1 = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

function json(response: unknown, status = 200): Response {
  return new Response(JSON.stringify(response), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('Stripe webhook signature verification (generated secrets)', () => {
  it('accepts a valid in-window signature', () => {
    const payload = '{"id":"evt_1","type":"ping"}';
    const verdict = verifyStripeSignature(signedHeader(payload), SECRET, payload, NOW_MS);
    expect(verdict).toEqual({ valid: true, timestampSeconds: NOW_S, reason: null });
  });

  it('rejects a tampered payload (same signature, different body)', () => {
    const payload = '{"id":"evt_1","amount":100}';
    const header = signedHeader('{"id":"evt_1","amount":999}');
    const verdict = verifyStripeSignature(header, SECRET, payload, NOW_MS);
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toBe('no signature matched');
  });

  it('rejects a signature from the wrong secret', () => {
    const payload = '{"id":"evt_1"}';
    const header = signedHeader(payload, 'whsec_other_secret');
    expect(verifyStripeSignature(header, SECRET, payload, NOW_MS).valid).toBe(false);
  });

  it('rejects a replayed event outside the 5-minute window', () => {
    const payload = '{"id":"evt_1"}';
    const old = NOW_S - 6 * 60; // 6 minutes old
    const verdict = verifyStripeSignature(signedHeader(payload, SECRET, old), SECRET, payload, NOW_MS);
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toBe('timestamp outside replay window');
  });

  it('accepts within the tolerance boundary (clock skew both ways)', () => {
    const payload = '{"id":"evt_1"}';
    const past = NOW_S - 290; // 4:50 old — inside 5:00 window
    expect(verifyStripeSignature(signedHeader(payload, SECRET, past), SECRET, payload, NOW_MS).valid).toBe(true);
    const future = NOW_S + 290;
    expect(verifyStripeSignature(signedHeader(payload, SECRET, future), SECRET, payload, NOW_MS).valid).toBe(true);
  });

  it('accepts when any of several signature pairs validates (rotated secrets)', () => {
    const payload = '{"id":"evt_1"}';
    const rotated = 'whsec_rotated_secret';
    const header = `${signedHeader(payload, rotated)},${signedHeader(payload)}`;
    const verdict = verifyStripeSignature(header, rotated, payload, NOW_MS);
    expect(verdict.valid).toBe(true);
  });

  it('rejects malformed or empty headers', () => {
    const payload = '{}';
    expect(verifyStripeSignature('', SECRET, payload, NOW_MS).valid).toBe(false);
    expect(verifyStripeSignature('garbage', SECRET, payload, NOW_MS).valid).toBe(false);
    expect(verifyStripeSignature('t=123', SECRET, payload, NOW_MS).valid).toBe(false);
    expect(verifyStripeSignature('v1=abcd', SECRET, payload, NOW_MS).valid).toBe(false);
  });

  it('the adapter throws UNAUTHENTICATED on every invalid variant and passes the event time through', async () => {
    const stripe = provider();
    const payload = JSON.stringify({ id: 'evt_1', type: 'ping', created: NOW_S, data: { object: {} } });
    const ok = await stripe.verifyWebhook(payload, { 'stripe-signature': signedHeader(payload) });
    expect(ok.occurredAt.getTime()).toBe(NOW_MS);

    const bad: Record<string, string> = {};
    await expect(stripe.verifyWebhook(payload, bad)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(stripe.verifyWebhook(payload, { 'stripe-signature': signedHeader(payload, 'wrong') })).rejects.toBeInstanceOf(AppError);
    await expect(stripe.verifyWebhook(payload, { 'stripe-signature': signedHeader(payload, SECRET, NOW_S - 3600) })).rejects.toBeInstanceOf(AppError);
    await expect(stripe.verifyWebhook(payload.replace('evt_1', 'evt_2'), { 'stripe-signature': signedHeader(payload) })).rejects.toBeInstanceOf(AppError);
  });
});

describe('Stripe adapter (stubbed REST, no network)', () => {
  it('isConfigured() reflects a complete configuration', () => {
    expect(provider().isConfigured()).toBe(true);
    expect(
      StripeProvider.create({ secretKey: SK, webhookSecret: '', plans: PLANS }).isConfigured(),
    ).toBe(false);
    expect(
      StripeProvider.create({ secretKey: '', webhookSecret: SECRET, plans: PLANS }).isConfigured(),
    ).toBe(false);
  });

  it('creates the customer before a hosted checkout session', async () => {
    const calls: Array<{ method: string; path: string; body: Record<string, unknown> | null }> = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ method: init?.method ?? 'GET', path: String(_url), body });
      if (String(_url).endsWith('/customers')) return json({ id: 'cus_test_1' });
      if (String(_url).endsWith('/checkout/sessions')) return json({ id: 'cs_test_1', url: 'https://checkout.stripe.com/pay/cs_test_1' });
      return json({ error: { message: 'not found' } }, 404);
    }) as unknown as typeof fetch;

    const stripe = provider(fetchImpl);
    const result = await stripe.createCheckout({
      userId: 'user-1',
      plan: 'TEAM',
      customer: { id: 'cus_test_1', email: 'a@b.c', name: 'A' },
      successUrl: 'https://app.example/billing/success',
      cancelUrl: 'https://app.example/billing/cancel',
    });

    expect(result).toMatchObject({ method: 'REDIRECT', redirectUrl: 'https://checkout.stripe.com/pay/cs_test_1', providerSessionId: 'cs_test_1' });
    const session = calls.find((c) => c.path.endsWith('/checkout/sessions'))!;
    expect(session.body).toMatchObject({
      mode: 'subscription',
      line_items: [{ price: 'price_test_team', quantity: 1 }],
      customer: 'cus_test_1',
      customer_email: 'a@b.c',
      client_reference_id: 'user-1',
      success_url: 'https://app.example/billing/success',
      cancel_url: 'https://app.example/billing/cancel',
    });
  });

  it('maps checkout.session.completed to SUBSCRIPTION_ACTIVATED with the configured plan', () => {
    const stripe = provider();
    const payload = {
      id: 'evt_2',
      type: 'checkout.session.completed',
      created: NOW_S,
      data: {
        object: {
          id: 'cs_test_1',
          mode: 'subscription',
          customer: 'cus_test_1',
          subscription: 'sub_test_1',
          currency: 'usd',
          line_items: [{ price: { id: 'price_test_pro' } }],
        },
      },
    };
    const event = stripe.normalizeEvent(payload)!;
    expect(event).toMatchObject({
      provider: 'STRIPE',
      providerEventId: 'evt_2',
      type: 'SUBSCRIPTION_ACTIVATED',
      providerSubscriptionId: 'sub_test_1',
      providerCustomerId: 'cus_test_1',
    });
    expect(event.snapshot).toMatchObject({ plan: 'PRO', status: 'ACTIVE', providerPlanRef: 'price_test_pro', currency: 'USD' });
  });

  it('maps a cancel_at_period_end subscription to CANCELED with access until period end', () => {
    const stripe = provider();
    const payload = {
      id: 'evt_3',
      type: 'customer.subscription.updated',
      created: NOW_S,
      data: {
        object: {
          id: 'sub_test_1',
          object: 'subscription',
          status: 'active',
          cancel_at_period_end: true,
          current_period_end: NOW_S + 30 * 86_400,
          customer: 'cus_test_1',
          currency: 'usd',
          items: { data: [{ price: { id: 'price_test_pro' } }] },
        },
      },
    };
    const event = stripe.normalizeEvent(payload)!;
    expect(event.type).toBe('SUBSCRIPTION_UPDATED');
    expect(event.snapshot).toMatchObject({ status: 'CANCELED', cancelAtPeriodEnd: true, plan: 'PRO' });
    expect(event.snapshot?.currentPeriodEnd!.getTime()).toBe((NOW_S + 30 * 86_400) * 1000);
  });

  it('maps an immediately-canceled subscription to EXPIRED (no lingering access)', () => {
    const stripe = provider();
    const event = stripe.normalizeEvent({
      id: 'evt_4',
      type: 'customer.subscription.deleted',
      created: NOW_S,
      data: { object: { id: 'sub_test_1', status: 'canceled', cancel_at_period_end: false, current_period_end: NOW_S + 30 * 86_400, customer: 'cus_test_1', items: { data: [{ price: { id: 'price_test_pro' } }] } } },
    })!;
    expect(event.type).toBe('SUBSCRIPTION_PERIOD_ENDED');
    expect(event.snapshot?.status).toBe('EXPIRED');
  });

  it('maps failed and paid invoices to PAYMENT_FAILED / PAYMENT_SUCCEEDED', () => {
    const stripe = provider();
    const failed = stripe.normalizeEvent({
      id: 'evt_5',
      type: 'invoice.payment_failed',
      created: NOW_S,
      data: { object: { id: 'in_1', subscription: 'sub_test_1', customer: 'cus_test_1', period_end: NOW_S + 30 * 86_400 } },
    })!;
    expect(failed.type).toBe('PAYMENT_FAILED');
    expect(failed.snapshot?.status).toBe('PAST_DUE');

    const paid = stripe.normalizeEvent({
      id: 'evt_6',
      type: 'invoice.paid',
      created: NOW_S,
      data: { object: { id: 'in_2', subscription: { id: 'sub_test_1' }, customer: 'cus_test_1', period_end: NOW_S + 60 * 86_400 } },
    })!;
    expect(paid.type).toBe('PAYMENT_SUCCEEDED');
    expect(paid.snapshot).toMatchObject({ status: 'ACTIVE' });
  });

  it('maps charge.refunded to REFUND_ISSUED and ignores unrelated events', () => {
    const stripe = provider();
    const refund = stripe.normalizeEvent({
      id: 'evt_7',
      type: 'charge.refunded',
      created: NOW_S,
      data: { object: { id: 'ch_1', subscription: 'sub_test_1', customer: 'cus_test_1', currency: 'usd' } },
    })!;
    expect(refund.type).toBe('REFUND_ISSUED');
    expect(stripe.normalizeEvent({ id: 'evt_8', type: 'account.updated', created: NOW_S, data: { object: {} } })).toBeNull();
  });

  it('flags an unmapped price as plan null instead of guessing', () => {
    const stripe = provider();
    const event = stripe.normalizeEvent({
      id: 'evt_9',
      type: 'customer.subscription.updated',
      created: NOW_S,
      data: { object: { id: 'sub_2', status: 'active', customer: 'cus_2', current_period_end: NOW_S + 86_400, items: { data: [{ price: { id: 'price_unknown' } }] } } },
    })!;
    expect(event.snapshot?.plan).toBeNull();
    expect(event.snapshot?.providerPlanRef).toBe('price_unknown');
  });

  it('throws VALIDATION_FAILED on a malformed envelope', () => {
    const stripe = provider();
    expect(() => stripe.normalizeEvent({ id: 'evt_10' })).toThrowError(AppError);
  });

  it('getSubscription reads the provider view for reconciliation', async () => {
    const fetchImpl = (async () =>
      json({ id: 'sub_test_1', status: 'past_due', cancel_at_period_end: false, current_period_end: NOW_S + 86_400, customer: 'cus_test_1', trial_end: null, currency: 'usd', items: { data: [{ price: { id: 'price_test_pro' } }] } })) as unknown as typeof fetch;
    const snapshot = await provider(fetchImpl).getSubscription('sub_test_1');
    expect(snapshot).toMatchObject({ providerSubscriptionId: 'sub_test_1', providerCustomerId: 'cus_test_1', status: 'PAST_DUE', plan: 'PRO' });
  });

  it('surfaces provider outages as PROVIDER_UNAVAILABLE, never as success', async () => {
    const stripe = provider(() => Promise.reject(new Error('dns failure')));
    await expect(stripe.createCheckout({
      userId: 'u', plan: 'PRO', customer: { id: 'cus_1', email: 'a@b.c', name: null }, successUrl: 's', cancelUrl: 'c',
    })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    const stripe404 = provider((async () => json({ error: { message: 'No such price' } }, 404)) as unknown as typeof fetch);
    await expect(stripe404.createCustomer({ userId: 'u', email: 'a@b.c', name: null })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });
});
