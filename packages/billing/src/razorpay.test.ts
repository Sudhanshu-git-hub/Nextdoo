import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@nextdoo/contracts';
import { RazorpayProvider } from './adapters/razorpay';
import { verifyRazorpaySignature } from './signature';

/**
 * Hermetic Razorpay adapter coverage: signature verification with GENERATED
 * test secrets, replay-window checks on the event's created_at, and adapter
 * behavior against a stubbed fetch. No live configuration is used.
 */

const WEBHOOK_SECRET = 'rzp_whsec_generated_test';
const KEY_ID = 'rzp_test_keyid';
const KEY_SECRET = 'rzp_test_keysecret';
const PLANS = {
  PRO: { id: 'plan_test_pro', amountPaise: 199900 },
  TEAM: { id: 'plan_test_team', amountPaise: 499900 },
  ENTERPRISE: { id: 'plan_test_ent', amountPaise: 999900 },
} as const;
// Derived from the real clock: verifyWebhook checks the replay window against
// Date.now(), so the tests' "now" must be the actual current second.
const NOW_S = Math.floor(Date.now() / 1000);
const NOW_MS = NOW_S * 1000;

function provider(fetchImpl: typeof fetch = vi.fn() as unknown as typeof fetch) {
  return RazorpayProvider.create({ keyId: KEY_ID, keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET, plans: PLANS }, fetchImpl);
}

function sign(payload: string, secret: string = WEBHOOK_SECRET) {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

function eventBody(type: string, entity: Record<string, unknown>, createdAt: number = NOW_S, extra: Record<string, unknown> = {}) {
  const [entityKey] = type.split('.') as [string];
  return JSON.stringify({
    id: `wh_${Math.random().toString(36).slice(2)}`,
    entity: entityKey,
    event: type,
    created_at: createdAt,
    key: KEY_ID,
    payload: { [entityKey]: { entity }, ...extra },
  });
}

function json(response: unknown, status = 200): Response {
  return new Response(JSON.stringify(response), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('Razorpay webhook signature verification (generated secrets)', () => {
  it('accepts a valid fresh signature', () => {
    const payload = '{"id":"wh_1","event":"payment.captured","created_at":1757600000}';
    const verdict = verifyRazorpaySignature(sign(payload), WEBHOOK_SECRET, payload, NOW_S, NOW_MS);
    expect(verdict).toEqual({ valid: true, timestampSeconds: NOW_S, reason: null });
  });

  it('rejects a tampered payload', () => {
    const verdict = verifyRazorpaySignature(sign('{"amount":100}'), WEBHOOK_SECRET, '{"amount":999}', NOW_S, NOW_MS);
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toBe('signature mismatch');
  });

  it('rejects the wrong secret and a missing signature', () => {
    const payload = '{}';
    expect(verifyRazorpaySignature(sign(payload, 'other'), WEBHOOK_SECRET, payload, NOW_S, NOW_MS).valid).toBe(false);
    expect(verifyRazorpaySignature('', WEBHOOK_SECRET, payload, NOW_S, NOW_MS).valid).toBe(false);
  });

  it('rejects a replayed event older than the window and a future-stamped event', () => {
    const payload = '{}';
    const old = NOW_S - 16 * 60;
    expect(verifyRazorpaySignature(sign(payload), WEBHOOK_SECRET, payload, old, NOW_MS).reason).toBe('event older than replay window');
    const future = NOW_S + 10 * 60;
    expect(verifyRazorpaySignature(sign(payload), WEBHOOK_SECRET, payload, future, NOW_MS).reason).toBe('event timestamp in the future');
  });

  it('rejects a valid signature on an event without created_at (no timestamp = no proof of freshness)', () => {
    const payload = '{"id":"wh_1"}';
    const verdict = verifyRazorpaySignature(sign(payload), WEBHOOK_SECRET, payload, null, NOW_MS);
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toBe('missing event timestamp');
  });

  it('the adapter throws UNAUTHENTICATED for every invalid variant', async () => {
    const rzp = provider();
    const payload = eventBody('payment.captured', { id: 'pay_1' });
    const ok = await rzp.verifyWebhook(payload, { 'x-razorpay-signature': sign(payload) });
    expect(ok.occurredAt.getTime()).toBe(NOW_MS);

    await expect(rzp.verifyWebhook(payload, {})).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(rzp.verifyWebhook(payload, { 'x-razorpay-signature': sign(payload, 'wrong') })).rejects.toBeInstanceOf(AppError);
    await expect(rzp.verifyWebhook(payload, { 'x-razorpay-signature': sign(payload) + '00' })).rejects.toBeInstanceOf(AppError);
    const stale = eventBody('payment.captured', { id: 'pay_1' }, NOW_S - 16 * 60);
    await expect(rzp.verifyWebhook(stale, { 'x-razorpay-signature': sign(stale) })).rejects.toBeInstanceOf(AppError);
    await expect(rzp.verifyWebhook('not json', { 'x-razorpay-signature': sign('not json') })).rejects.toBeInstanceOf(AppError);
  });
});

describe('Razorpay adapter (stubbed REST, no network)', () => {
  it('isConfigured() reflects a complete configuration', () => {
    expect(provider().isConfigured()).toBe(true);
    expect(RazorpayProvider.create({ keyId: '', keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET, plans: PLANS }).isConfigured()).toBe(false);
    expect(RazorpayProvider.create({ keyId: KEY_ID, keySecret: KEY_SECRET, webhookSecret: '', plans: PLANS }).isConfigured()).toBe(false);
    expect(
      RazorpayProvider.create({ keyId: KEY_ID, keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET, plans: { PRO: PLANS.PRO, TEAM: PLANS.TEAM, ENTERPRISE: { id: '', amountPaise: 1 } } }).isConfigured(),
    ).toBe(false);
  });

  it('creates a customer and a priced INR order for embedded checkout', async () => {
    const calls: Array<{ path: string; body: Record<string, unknown> | null; auth?: string }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ path: String(url), body, auth: init?.headers ? (init.headers as Record<string, string>).Authorization : undefined });
      if (String(url).endsWith('/customers')) return json({ id: 'cust_test_1' });
      if (String(url).endsWith('/orders')) return json({ id: 'order_test_1', amount: 499900, currency: 'INR' });
      return json({ error: { description: 'not found' } }, 404);
    }) as unknown as typeof fetch;

    const rzp = provider(fetchImpl);
    await expect(rzp.createCustomer({ userId: 'user-1', email: 'a@b.c', name: 'A' })).resolves.toEqual({ providerCustomerId: 'cust_test_1' });
    const expectedAuth = `Basic ${Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64')}`;
    expect(calls[0]!.auth).toBe(expectedAuth);

    const result = await rzp.createCheckout({
      userId: 'user-1',
      plan: 'TEAM',
      customer: { id: 'cust_test_1', email: 'a@b.c', name: 'A' },
      successUrl: 'https://app.example/billing/success',
      cancelUrl: 'https://app.example/billing/cancel',
    });
    expect(result.method).toBe('EMBEDDED_CHECKOUT');
    if (result.method === 'EMBEDDED_CHECKOUT') {
      expect(result.keyId).toBe(KEY_ID);
      expect(result.providerSessionId).toBe('order_test_1');
      expect(result.parameters).toMatchObject({
        order_id: 'order_test_1',
        amount: 499900,
        currency: 'INR',
        plan_id: 'plan_test_team',
        prefill: { email: 'a@b.c', name: 'A' },
        notes: { user_id: 'user-1', plan: 'TEAM' },
      });
    }
    const order = calls.find((c) => c.path.endsWith('/orders'))!;
    expect(order.body).toMatchObject({ amount: 499900, currency: 'INR', notes: { user_id: 'user-1', plan: 'TEAM' } });
  });

  it('maps payment.captured to SUBSCRIPTION_ACTIVATED, resolving the plan from notes then amount', () => {
    const rzp = provider();
    const withNotes = JSON.parse(eventBody('payment.captured', {
      id: 'pay_1', amount: 199900, currency: 'inr', customer_id: 'cust_1', notes: { plan: 'PRO' },
    }));
    const fromNotes = rzp.normalizeEvent(withNotes)!;
    expect(fromNotes.type).toBe('SUBSCRIPTION_ACTIVATED');
    expect(fromNotes.providerCustomerId).toBe('cust_1');
    expect(fromNotes.snapshot).toMatchObject({ plan: 'PRO', status: 'ACTIVE', currency: 'INR' });

    const byAmount = rzp.normalizeEvent(JSON.parse(eventBody('payment.captured', {
      id: 'pay_2', amount: 499900, currency: 'inr', customer_id: 'cust_1',
    })))!;
    expect(byAmount.snapshot?.plan).toBe('TEAM');

    const unmapped = rzp.normalizeEvent(JSON.parse(eventBody('payment.captured', {
      id: 'pay_3', amount: 123456, currency: 'inr', customer_id: 'cust_1',
    })))!;
    expect(unmapped.snapshot?.plan).toBeNull();
  });

  it('maps the subscription lifecycle events to the normalized types', () => {
    const rzp = provider();
    const sub = (status: string) => ({
      id: 'sub_rzp_1', status, plan_id: 'plan_test_pro', customer_id: 'cust_1',
      current_period_end: NOW_S + 30 * 86_400,
    });

    const charged = rzp.normalizeEvent(JSON.parse(eventBody('subscription.charged', sub('active'))))!;
    expect(charged.type).toBe('PAYMENT_SUCCEEDED');
    expect(charged.providerSubscriptionId).toBe('sub_rzp_1');
    expect(charged.snapshot).toMatchObject({ status: 'ACTIVE', plan: 'PRO', providerPlanRef: 'plan_test_pro', providerCustomerId: 'cust_1' });
    expect(charged.snapshot?.currentPeriodEnd!.getTime()).toBe((NOW_S + 30 * 86_400) * 1000);

    expect(rzp.normalizeEvent(JSON.parse(eventBody('subscription.halted', sub('halted'))))!.type).toBe('DUNNING_STARTED');
    expect(rzp.normalizeEvent(JSON.parse(eventBody('subscription.cancelled', sub('cancelled'))))!.type).toBe('SUBSCRIPTION_CANCELED');
    expect(rzp.normalizeEvent(JSON.parse(eventBody('subscription.completed', sub('completed'))))!.type).toBe('SUBSCRIPTION_PERIOD_ENDED');
    expect(rzp.normalizeEvent(JSON.parse(eventBody('subscription.paused', sub('paused'))))!.type).toBe('SUBSCRIPTION_PAUSED');
    expect(rzp.normalizeEvent(JSON.parse(eventBody('subscription.resumed', sub('active'))))!.type).toBe('SUBSCRIPTION_RESUMED');
    expect(rzp.normalizeEvent(JSON.parse(eventBody('subscription.created', sub('created'))))!.type).toBe('SUBSCRIPTION_CREATED');
  });

  it('a halted subscription inside a still-running period maps to GRACE_PERIOD, after to EXPIRED', () => {
    const rzp = provider();
    const during = rzp.normalizeEvent(JSON.parse(eventBody('subscription.halted', {
      id: 'sub_2', status: 'halted', plan_id: 'plan_test_pro', customer_id: 'cust_1', current_period_end: NOW_S + 86_400,
    })))!;
    expect(during.snapshot?.status).toBe('GRACE_PERIOD');

    const after = rzp.normalizeEvent(JSON.parse(eventBody('subscription.halted', {
      id: 'sub_2', status: 'halted', plan_id: 'plan_test_pro', customer_id: 'cust_1', current_period_end: NOW_S - 86_400,
    })))!;
    expect(after.snapshot?.status).toBe('EXPIRED');
  });

  it('maps refunds to REFUND_ISSUED and ignores unrelated events', () => {
    const rzp = provider();
    const refund = rzp.normalizeEvent(JSON.parse(eventBody('refund.completed', { id: 'rfnd_1', customer_id: 'cust_1', currency: 'inr' })))!;
    expect(refund.type).toBe('REFUND_ISSUED');
    expect(refund.providerCustomerId).toBe('cust_1');
    expect(rzp.normalizeEvent({ id: 'wh_x', event: 'order.created', created_at: NOW_S, payload: { order: { entity: {} } } })).toBeNull();
  });

  it('throws VALIDATION_FAILED on a malformed envelope', () => {
    const rzp = provider();
    expect(() => rzp.normalizeEvent({ event: 'payment.captured' })).toThrowError(AppError);
  });

  it('getSubscription reads the provider view for reconciliation', async () => {
    const fetchImpl = (async () =>
      json({ id: 'sub_rzp_1', status: 'active', plan_id: 'plan_test_team', customer_id: 'cust_1', current_period_end: NOW_S + 86_400, currency: 'inr' })) as unknown as typeof fetch;
    const snapshot = await provider(fetchImpl).getSubscription('sub_rzp_1');
    expect(snapshot).toMatchObject({ providerSubscriptionId: 'sub_rzp_1', providerCustomerId: 'cust_1', status: 'ACTIVE', plan: 'TEAM' });
  });

  it('surfaces provider outages as PROVIDER_UNAVAILABLE, never as success', async () => {
    const rzp = provider(() => Promise.reject(new Error('dns failure')));
    await expect(rzp.createCheckout({
      userId: 'u', plan: 'PRO', customer: { id: 'cust_1', email: 'a@b.c', name: null }, successUrl: 's', cancelUrl: 'c',
    })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });
});
