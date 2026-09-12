import { randomUUID } from 'node:crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';

/**
 * M6-i3 multi-provider billing (PRD §10.7, §18) — E2E through the real HTTP
 * layer (API-only: the endpoints under test have no browser surface).
 *
 * The E2E environment runs WITHOUT Stripe/Razorpay credentials on purpose, so
 * this spec verifies the fail-loud contract of the unconfigured state and the
 * untrusted-ingress contract of the webhook endpoint:
 *
 *  - the subscription view is auth-gated and reports server-normalized state
 *    (the client can never grant itself a plan);
 *  - checkout is a 503 PROVIDER_UNAVAILABLE for BOTH providers when the
 *    provider is unconfigured — never a silent stub, never a fallback to the
 *    other provider, and it changes no entitlement state;
 *  - the webhook ingress rejects deliveries with no/ambiguous provider
 *    signature and fails loud (503) on a forged signature for an
 *    unconfigured provider, without touching entitlements.
 *
 * The full provider lifecycle (signature-verified checkout handoff, signed
 * webhook → entitlement flip through readEffectivePlan, event-id dedup,
 * out-of-order tolerance, version fencing, reconciliation) is covered
 * hermetically by billing-lifecycle.integration.test.ts and the
 * @nextdoo/billing unit suite. Live sandbox checkout/webhook delivery is OUT
 * of scope here and is explicitly NOT claimed by this spec.
 */

const origin = { Origin: 'http://localhost:3100' };
const BASE = 'http://localhost:3100';

async function register(request: APIRequestContext) {
  const email = `billing-e2e-${randomUUID()}@test.local`;
  const r = await request.post('/api/v1/auth/register', {
    headers: { ...origin, 'X-Forwarded-For': '198.51.100.214' },
    data: { email, password: 'billing-test-password-123', timeZone: 'UTC' },
  });
  expect(r.status()).toBe(200);
  const body = await r.json();
  return { email, workspaceId: body.workspaceId as string };
}

async function subscriptionView(request: APIRequestContext) {
  const res = await request.get('/api/v1/billing/subscription');
  expect(res.status()).toBe(200);
  return res.json();
}

test('the subscription view is auth-gated and reports the server-normalized FREE state', async ({ playwright }) => {
  const request = await playwright.request.newContext({ baseURL: BASE });
  try {
    // Unauthenticated: a separate isolated context without the session cookie.
    const anon = await playwright.request.newContext({ baseURL: BASE });
    const denied = await anon.get('/api/v1/billing/subscription');
    expect(denied.status()).toBe(401);
    await anon.dispose();

    await register(request);
    const view = await subscriptionView(request);
    expect(view.plan).toBe('FREE');
    expect(view.effectivePlan).toBe('FREE');
    // A fresh FREE row carries the schema's provider default; nothing binds it.
    expect(['STRIPE', 'RAZORPAY']).toContain(view.provider);
    expect(view.cancelAtPeriodEnd).toBe(false);
    expect(view.currentPeriodEnd).toBeNull();
    expect(view.graceEndsAt).toBeNull();
    expect(view.pendingPlan).toBeNull();
  } finally {
    await request.dispose();
  }
});

test('checkout fails loud with PROVIDER_UNAVAILABLE for both unconfigured providers and changes no state', async ({ playwright }) => {
  const request = await playwright.request.newContext({ baseURL: BASE });
  try {
    await register(request);
    for (const provider of ['STRIPE', 'RAZORPAY'] as const) {
      const res = await request.post('/api/v1/billing/checkout', {
        headers: { ...origin, 'Idempotency-Key': randomUUID() },
        data: { plan: 'PRO', provider },
      });
      expect(res.status()).toBe(503);
      expect((await res.json()).code).toBe('PROVIDER_UNAVAILABLE');
    }

    // A failed checkout never grants entitlements: the view is still FREE.
    const view = await subscriptionView(request);
    expect(view.plan).toBe('FREE');
    expect(view.effectivePlan).toBe('FREE');
    expect(view.currentPeriodEnd).toBeNull();
  } finally {
    await request.dispose();
  }
});

test('the webhook ingress is untrusted until signature-verified and the provider is configured', async ({ playwright }) => {
  // Webhooks arrive from the provider's servers: no session cookie, no
  // browser Origin — exactly what this context carries.
  const providerSide = await playwright.request.newContext({ baseURL: BASE });
  const request = await playwright.request.newContext({ baseURL: BASE });
  try {
    await register(request);
    const body = JSON.stringify({
      id: `evt_${randomUUID()}`,
      type: 'customer.subscription.updated',
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: 'sub_nope', status: 'active' } },
    });

    // No signature header: no recognized provider → 400.
    const unsigned = await providerSide.post('/api/v1/billing/webhooks', { data: body });
    expect(unsigned.status()).toBe(400);
    expect((await unsigned.json()).code).toBe('VALIDATION_FAILED');

    // Both signature headers: ambiguous provider claim → 400.
    const ambiguous = await providerSide.post('/api/v1/billing/webhooks', {
      headers: { 'stripe-signature': 't=1,v1=deadbeef', 'x-razorpay-signature': 'deadbeef' },
      data: body,
    });
    expect(ambiguous.status()).toBe(400);
    expect((await ambiguous.json()).code).toBe('VALIDATION_FAILED');

    // A forged signature for an UNCONFIGURED provider fails loud (503) before
    // any state change — the app never substitutes a stub provider.
    const forged = await providerSide.post('/api/v1/billing/webhooks', {
      headers: { 'stripe-signature': `t=${Math.floor(Date.now() / 1000)},v1=${'ab'.repeat(32)}` },
      data: body,
    });
    expect(forged.status()).toBe(503);
    expect((await forged.json()).code).toBe('PROVIDER_UNAVAILABLE');

    // Nothing the ingress rejected may have changed entitlements.
    const view = await subscriptionView(request);
    expect(view.plan).toBe('FREE');
    expect(view.effectivePlan).toBe('FREE');
  } finally {
    await request.dispose();
    await providerSide.dispose();
  }
});
