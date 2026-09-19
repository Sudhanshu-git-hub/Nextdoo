import { createHmac, randomUUID } from 'node:crypto';
import { and, count, eq, isNull } from 'drizzle-orm';
import { limitsFor } from '@nextdoo/contracts';
import {
  RazorpayProvider,
  StripeProvider,
  type PaymentProvider,
  type PurchasablePlan,
} from '@nextdoo/billing';
import {
  applyBillingDeadlines,
  auditLogs,
  billingEvents,
  type BillingEventOutcome,
  type CheckoutInput,
  getBillingSubscriptionState,
  handleBillingEvent,
  reconcileBilling,
  startCheckout,
  projects,
  subscriptions,
  tasks,
} from '@nextdoo/db';
import { describe, expect, it } from 'vitest';
import { requireTestDatabase } from '../../../../../tests/database';
import { getDb } from '../db';
import { getPlan, registerUser } from './accounts';
import { createTask, type TaskActor } from './tasks';
import { createProject } from './projects';
import { enforceProjectLimit, enforceTaskLimit, getEntitlementSnapshot } from './entitlements';

/**
 * M6-i3 multi-provider billing lifecycle — DB-backed regression for BOTH
 * Stripe and Razorpay through the real sync service (PRD §18.3):
 *
 *  1. checkout authorization (fail-loud 503 unconfigured, customer handoff, audit);
 *  2. successful activation (webhook -> plan/ACTIVE -> entitlements via readEffectivePlan);
 *  3. webhook signature validation (forged / tampered / replayed / missing rejected);
 *  4. duplicate webhook idempotency (same event id, same or different payload);
 *  5. upgrade / downgrade (immediate vs next-period, data preserved over-limit);
 *  6. cancellation & grace (access until period end, then expired);
 *  7. failed payments (7-day grace, recovery, dunning, exhaustion);
 *  8. subscription state transitions (version-fenced, illegal transitions skipped);
 *  9. entitlement changes (plan limits re-evaluated after every transition);
 * 10. tenant isolation (foreign, unknown and cross-provider customers);
 * 11. reconciliation & recovery (drift detected, audited, alert-only;
 *     stale out-of-order events skipped, then the provider state converges);
 * 12. provider disagreement / out-of-order webhooks (stale event horizon).
 *
 * Everything is hermetic: signatures are generated with random test secrets,
 * provider REST is a stubbed fetch. Live checkout/webhook delivery is OUT of
 * scope here and is explicitly NOT claimed — see docs/M6_BILLING_CORE_MILESTONE.md.
 */

await requireTestDatabase();

const DAY = 86_400_000;
const nowS = () => Math.floor(Date.now() / 1000);
type ProviderName = 'STRIPE' | 'RAZORPAY';

type Delivery = BillingEventOutcome | { ignored: true };

interface Harness {
  label: string;
  providerName: ProviderName;
  provider: PaymentProvider;
  /** Same plan mapping, no webhook secret: the fail-loud configuration. */
  unconfigured: PaymentProvider;
  /** Provider plan references (price ids / plan ids) for assertions. */
  planRef: Record<PurchasablePlan, string>;
  fetchCalls: string[];
  /** Override what GET /subscriptions returns (reconciliation stubbing). */
  mockSub: (override: Record<string, unknown> | null) => void;
  deliver: (body: string, t?: number) => Promise<Delivery>;
  deliverRaw: (body: string, headers: Record<string, string>) => Promise<Delivery>;
  sign: (body: string, t: number) => Record<string, string>;
  runCheckout: (input: CheckoutInput) => Promise<unknown>;
  activateBody: (customer: string, subId: string, plan: PurchasablePlan, periodEndS: number, t?: number) => string;
  planChangeBody: (subId: string, customer: string, plan: PurchasablePlan, periodEndS: number, t?: number) => string;
  cancelBody: (subId: string, customer: string, plan: PurchasablePlan, periodEndS: number, t?: number) => string;
  periodEndBody: (subId: string, customer: string, plan: PurchasablePlan, periodEndS: number, t?: number) => string;
  paymentFailedBody: (subId: string, customer: string, t?: number) => string;
  paymentSucceededBody: (subId: string, customer: string, plan: PurchasablePlan, periodEndS: number, t?: number) => string;
  dunningBody: ((subId: string, customer: string, plan: PurchasablePlan, periodEndS: number, t?: number) => string) | null;
  refundBody: (subId: string, customer: string, t?: number) => string;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function makeStripeHarness(): Harness {
  const webhookSecret = `whsec_it_${randomUUID().replaceAll('-', '')}`;
  const prices: Record<PurchasablePlan, string> = {
    PRO: `price_it_pro_${randomUUID().slice(0, 8)}`,
    TEAM: `price_it_team_${randomUUID().slice(0, 8)}`,
    ENTERPRISE: `price_it_ent_${randomUUID().slice(0, 8)}`,
  };
  const secretKey = `sk_test_it_${randomUUID().replaceAll('-', '')}`;
  // Customer ids must be unique ACROSS runs (the DB persists between runs and
  // webhook resolution falls back to (provider, customer) lookups).
  const run = randomUUID().slice(0, 8);
  let customerSeq = 0;
  let subOverride: Record<string, unknown> | null = null;
  const fetchCalls: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    fetchCalls.push(u);
    const method = init?.method ?? 'GET';
    if (method === 'POST' && u.endsWith('/customers')) return jsonResponse({ id: `cus_it_${run}_${++customerSeq}` });
    if (method === 'POST' && u.endsWith('/checkout/sessions')) {
      return jsonResponse({ id: `cs_${randomUUID()}`, url: 'https://checkout.stripe.test/pay/cs_test' });
    }
    if (u.includes('/subscriptions/')) {
      return jsonResponse(subOverride ?? {
        id: 'sub_unknown', status: 'active', cancel_at_period_end: false, customer: 'cus_unknown',
        current_period_end: nowS() + 30 * 86_400, currency: 'usd', items: { data: [{ price: { id: prices.PRO } }] },
      });
    }
    return jsonResponse({ error: { message: 'unexpected url' } }, 404);
  }) as unknown as typeof fetch;

  const provider = StripeProvider.create({ secretKey, webhookSecret, plans: prices }, fetchImpl);
  const unconfigured = StripeProvider.create({ secretKey, webhookSecret: '', plans: prices }, fetchImpl);

  const sign = (body: string, t: number) => {
    const v1 = createHmac('sha256', webhookSecret).update(`${t}.${body}`).digest('hex');
    return { 'stripe-signature': `t=${t},v1=${v1}` };
  };
  const deliverRaw = async (body: string, headers: Record<string, string>): Promise<Delivery> => {
    const { occurredAt } = await provider.verifyWebhook(body, headers);
    const payload: unknown = JSON.parse(body);
    const event = provider.normalizeEvent(payload);
    if (!event) return { ignored: true };
    return handleBillingEvent(getDb(), { event, payload, occurredAt });
  };
  const deliver = (body: string, t?: number) => deliverRaw(body, sign(body, t ?? nowS()));
  const envelope = (type: string, object: Record<string, unknown>, id: string, t: number) =>
    JSON.stringify({ id, type, created: t, data: { object } });
  const subObject = (subId: string, customer: string, plan: PurchasablePlan, periodEndS: number, extra: Record<string, unknown> = {}) => ({
    id: subId,
    status: 'active',
    cancel_at_period_end: false,
    current_period_end: periodEndS,
    customer,
    currency: 'usd',
    items: { data: [{ price: { id: prices[plan] } }] },
    ...extra,
  });

  return {
    label: 'Stripe',
    providerName: 'STRIPE',
    provider,
    unconfigured,
    planRef: prices,
    fetchCalls,
    mockSub: (o) => { subOverride = o; },
    deliver,
    deliverRaw,
    sign,
    runCheckout: (input) => startCheckout(getDb(), provider, input),
    activateBody: (customer, subId, plan, periodEndS, t = nowS()) =>
      envelope('checkout.session.completed', {
        id: `cs_${randomUUID()}`,
        mode: 'subscription',
        customer,
        subscription: subId,
        currency: 'usd',
        line_items: [{ price: { id: prices[plan] } }],
      }, `evt_${randomUUID()}`, t),
    planChangeBody: (subId, customer, plan, periodEndS, t = nowS()) =>
      envelope('customer.subscription.updated', subObject(subId, customer, plan, periodEndS), `evt_${randomUUID()}`, t),
    cancelBody: (subId, customer, plan, periodEndS, t = nowS()) =>
      envelope('customer.subscription.updated', subObject(subId, customer, plan, periodEndS, { cancel_at_period_end: true }), `evt_${randomUUID()}`, t),
    periodEndBody: (subId, customer, plan, periodEndS, t = nowS()) =>
      envelope('customer.subscription.deleted', subObject(subId, customer, plan, periodEndS, { status: 'canceled' }), `evt_${randomUUID()}`, t),
    paymentFailedBody: (subId, customer, t = nowS()) =>
      envelope('invoice.payment_failed', { id: `in_${randomUUID()}`, subscription: subId, customer, period_end: t + 30 * 86_400 }, `evt_${randomUUID()}`, t),
    paymentSucceededBody: (subId, customer, plan, periodEndS, t = nowS()) =>
      envelope('invoice.paid', { id: `in_${randomUUID()}`, subscription: subId, customer, period_end: periodEndS }, `evt_${randomUUID()}`, t),
    dunningBody: null,
    refundBody: (subId, customer, t = nowS()) =>
      envelope('charge.refunded', { id: `ch_${randomUUID()}`, subscription: subId, customer, currency: 'usd' }, `evt_${randomUUID()}`, t),
  };
}

function makeRazorpayHarness(): Harness {
  const webhookSecret = `rzp_whsec_it_${randomUUID().replaceAll('-', '')}`;
  const keyId = `rzp_test_it_${randomUUID().slice(0, 8)}`;
  const keySecret = `rzp_key_it_${randomUUID().replaceAll('-', '')}`;
  const plans: Record<PurchasablePlan, { id: string; amountPaise: number }> = {
    PRO: { id: `plan_it_pro_${randomUUID().slice(0, 8)}`, amountPaise: 199900 },
    TEAM: { id: `plan_it_team_${randomUUID().slice(0, 8)}`, amountPaise: 499900 },
    ENTERPRISE: { id: `plan_it_ent_${randomUUID().slice(0, 8)}`, amountPaise: 999900 },
  };
  const planRef: Record<PurchasablePlan, string> = { PRO: plans.PRO.id, TEAM: plans.TEAM.id, ENTERPRISE: plans.ENTERPRISE.id };
  const run = randomUUID().slice(0, 8);
  let customerSeq = 0;
  let subOverride: Record<string, unknown> | null = null;
  const fetchCalls: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    fetchCalls.push(u);
    const method = init?.method ?? 'GET';
    if (method === 'POST' && u.endsWith('/customers')) return jsonResponse({ id: `cust_it_${run}_${++customerSeq}` });
    if (method === 'POST' && u.endsWith('/orders')) {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      return jsonResponse({ id: `order_${randomUUID()}`, amount: body.amount ?? 0, currency: 'INR' });
    }
    if (u.includes('/subscriptions/')) {
      return jsonResponse(subOverride ?? {
        id: 'sub_unknown', status: 'active', plan_id: plans.PRO.id, customer_id: 'cust_unknown',
        current_period_end: nowS() + 30 * 86_400, currency: 'inr',
      });
    }
    return jsonResponse({ error: { description: 'unexpected url' } }, 404);
  }) as unknown as typeof fetch;

  const provider = RazorpayProvider.create({ keyId, keySecret, webhookSecret, plans }, fetchImpl);
  const unconfigured = RazorpayProvider.create({ keyId, keySecret, webhookSecret: '', plans }, fetchImpl);

  const sign = (body: string, _t: number) => ({ 'x-razorpay-signature': createHmac('sha256', webhookSecret).update(body).digest('hex') });
  const deliverRaw = async (body: string, headers: Record<string, string>): Promise<Delivery> => {
    const { occurredAt } = await provider.verifyWebhook(body, headers);
    const payload: unknown = JSON.parse(body);
    const event = provider.normalizeEvent(payload);
    if (!event) return { ignored: true };
    return handleBillingEvent(getDb(), { event, payload, occurredAt });
  };
  const deliver = (body: string, t?: number) => deliverRaw(body, sign(body, t ?? nowS()));
  const envelope = (type: string, entity: Record<string, unknown>, t: number) => {
    const [entityKey] = type.split('.') as [string];
    return JSON.stringify({ id: `wh_${randomUUID()}`, entity: entityKey, event: type, created_at: t, key: keyId, payload: { [entityKey]: { entity } } });
  };
  const subEntity = (subId: string, customer: string, plan: PurchasablePlan, periodEndS: number, status = 'active') => ({
    id: subId,
    status,
    plan_id: plans[plan].id,
    customer_id: customer,
    current_period_end: periodEndS,
  });

  return {
    label: 'Razorpay',
    providerName: 'RAZORPAY',
    provider,
    unconfigured,
    planRef,
    fetchCalls,
    mockSub: (o) => { subOverride = o; },
    deliver,
    deliverRaw,
    sign,
    runCheckout: (input) => startCheckout(getDb(), provider, input),
    activateBody: (customer, subId, plan, periodEndS, t = nowS()) =>
      envelope('payment.captured', { id: `pay_${randomUUID()}`, amount: plans[plan].amountPaise, currency: 'inr', customer_id: customer, subscription_id: subId, notes: { plan } }, t),
    planChangeBody: (subId, customer, plan, periodEndS, t = nowS()) =>
      envelope('subscription.charged', subEntity(subId, customer, plan, periodEndS, 'active'), t),
    cancelBody: (subId, customer, plan, periodEndS, t = nowS()) =>
      envelope('subscription.cancelled', subEntity(subId, customer, plan, periodEndS, 'cancelled'), t),
    periodEndBody: (subId, customer, plan, periodEndS, t = nowS()) =>
      envelope('subscription.completed', subEntity(subId, customer, plan, periodEndS, 'completed'), t),
    paymentFailedBody: (subId, customer, t = nowS()) =>
      envelope('payment.failed', { id: `pay_${randomUUID()}`, customer_id: customer, subscription_id: subId, amount: plans.PRO.amountPaise, currency: 'inr' }, t),
    paymentSucceededBody: (subId, customer, plan, periodEndS, t = nowS()) =>
      envelope('subscription.charged', subEntity(subId, customer, plan, periodEndS, 'active'), t),
    dunningBody: (subId, customer, plan, periodEndS, t = nowS()) =>
      envelope('subscription.halted', subEntity(subId, customer, plan, periodEndS, 'halted'), t),
    refundBody: (subId, customer, t = nowS()) =>
      envelope('refund.completed', { id: `rfnd_${randomUUID()}`, customer_id: customer, currency: 'inr', payment_id: subId }, t),
  };
}

// ---------------------------------------------------------------- fixtures

interface Fixture {
  userId: string;
  workspaceId: string;
  actor: TaskActor;
  customer: string;
  subscription: string;
  periodEndS: number;
}

async function freshUser(): Promise<{ userId: string; workspaceId: string }> {
  const user = await registerUser({ email: `billing-${randomUUID()}@test.local`, passwordHash: 'test', name: null, timeZone: 'UTC' });
  return { userId: user.id, workspaceId: user.workspaceId };
}

async function checkoutFixture(h: Harness, plan: PurchasablePlan = 'PRO'): Promise<Fixture> {
  const { userId, workspaceId } = await freshUser();
  const actor: TaskActor = { userId, workspaceId };
  const input: CheckoutInput = {
    userId,
    workspaceId,
    plan,
    successUrl: 'http://localhost:3000/billing/success',
    cancelUrl: 'http://localhost:3000/billing/cancel',
    requestId: `req_${randomUUID()}`,
  };
  await h.runCheckout(input);
  const sub = await subRow(userId);
  return {
    userId,
    workspaceId,
    actor,
    customer: sub?.providerCustomerId ?? '',
    subscription: `sub_${randomUUID()}`,
    periodEndS: nowS() + 30 * 86_400,
  };
}

async function subRow(userId: string) {
  const [row] = await getDb().select().from(subscriptions).where(eq(subscriptions.userId, userId)).limit(1);
  return row;
}

async function auditCount(userId: string | null, action: string): Promise<number> {
  const [row] = await getDb().select({ n: count() }).from(auditLogs).where(
    userId === null
      ? and(isNull(auditLogs.actorId), eq(auditLogs.action, action))
      : and(eq(auditLogs.actorId, userId), eq(auditLogs.action, action)),
  );
  return row?.n ?? 0;
}

async function eventCount(provider: ProviderName, userId: string): Promise<number> {
  const [row] = await getDb().select({ n: count() }).from(billingEvents).where(
    and(eq(billingEvents.provider, provider), eq(billingEvents.userId, userId)),
  );
  return row?.n ?? 0;
}

async function backdatePeriodEnd(userId: string, days: number): Promise<void> {
  await getDb().update(subscriptions).set({ currentPeriodEnd: new Date(Date.now() + days * DAY) }).where(eq(subscriptions.userId, userId));
}

async function backdateGrace(userId: string, days: number): Promise<void> {
  await getDb().update(subscriptions).set({ graceEndsAt: new Date(Date.now() + days * DAY) }).where(eq(subscriptions.userId, userId));
}

async function insertActiveTasks(workspaceId: string, n: number): Promise<void> {
  const ids = Array.from({ length: n }, () => randomUUID());
  await getDb().insert(tasks).values(ids.map((id, i) => ({ id, workspaceId, title: `Billing test task ${i + 1}` })));
}

/** Flips one hex digit: same length, valid hex, guaranteed mismatch. */
function corruptSignature(value: string): string {
  const v1 = value.indexOf('v1=');
  const idx = v1 >= 0 ? v1 + 3 : 0;
  const c = value[idx] ?? '0';
  const flipped = c === '0' ? '1' : '0';
  return value.slice(0, idx) + flipped + value.slice(idx + 1);
}

/** Activation + the follow-up subscription event that carries the period end. */
async function activate(h: Harness, f: Fixture, plan: PurchasablePlan = 'PRO') {
  const first = await h.deliver(h.activateBody(f.customer, f.subscription, plan, f.periodEndS));
  const followUp = await h.deliver(h.planChangeBody(f.subscription, f.customer, plan, f.periodEndS));
  return { first, followUp };
}

// ---------------------------------------------------------------- harnesses

const stripe = makeStripeHarness();
const razorpay = makeRazorpayHarness();

for (const h of [stripe, razorpay]) {
  describe(`multi-provider billing lifecycle (${h.label})`, () => {
    it('checkout: unconfigured provider fails loud with PROVIDER_UNAVAILABLE and touches no state', async () => {
      const { userId, workspaceId } = await freshUser();
      await expect(
        startCheckout(getDb(), h.unconfigured, {
          userId, workspaceId, plan: 'PRO',
          successUrl: 'http://localhost:3000/billing/success', cancelUrl: 'http://localhost:3000/billing/cancel',
        }),
      ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
      expect(h.unconfigured.isConfigured()).toBe(false);
      const sub = await subRow(userId);
      expect(sub?.providerCustomerId).toBeNull();
      expect(await auditCount(userId, 'billing.checkout_started')).toBe(0);
    });

    it('checkout: configured provider creates the customer, returns a handoff, writes audit; the customer is reused', async () => {
      const { userId, workspaceId } = await freshUser();
      h.fetchCalls.length = 0;
      const base: CheckoutInput = {
        userId, workspaceId, plan: 'PRO',
        successUrl: 'http://localhost:3000/billing/success', cancelUrl: 'http://localhost:3000/billing/cancel',
      };
      const result = (await h.runCheckout(base)) as { method: string; providerSessionId: string };
      expect(['REDIRECT', 'EMBEDDED_CHECKOUT']).toContain(result.method);
      expect(result.providerSessionId).toBeTruthy();

      const afterFirst = await subRow(userId);
      expect(afterFirst?.providerCustomerId).toBeTruthy();
      expect(afterFirst?.provider).toBe(h.providerName);

      // Second checkout: no new provider customer is created.
      await h.runCheckout(base);
      const customerCalls = h.fetchCalls.filter((u) => u.endsWith('/customers')).length;
      expect(customerCalls).toBe(1);
      expect(await auditCount(userId, 'billing.checkout_started')).toBe(2);
    });

    it('activation webhook flips entitlements through readEffectivePlan with no client involvement', async () => {
      const f = await checkoutFixture(h, 'PRO');
      // The same user is at the Free active-task cap boundary…
      await insertActiveTasks(f.workspaceId, 200);
      await expect(createTask(f.actor, { workspaceId: f.workspaceId, title: 'Task 201', dueAt: new Date(Date.now() + DAY).toISOString(), priority: 'MEDIUM', tagIds: [] })).rejects.toMatchObject({ code: 'ENTITLEMENT_LIMIT_REACHED' });

      // …and one signature-verified webhook later the cap is gone.
      const { first } = await activate(h, f);
      expect(first).toMatchObject({ applied: true, status: 'ACTIVE', plan: 'PRO', unresolved: false, duplicate: false });

      const sub = await subRow(f.userId);
      expect(sub?.status).toBe('ACTIVE');
      expect(sub?.plan).toBe('PRO');
      expect(sub?.providerSubscriptionId).toBe(f.subscription);
      expect(sub?.providerPlanRef).toBe(h.planRef.PRO);
      expect(sub?.currentPeriodEnd?.getTime()).toBe(f.periodEndS * 1000);

      expect(await getPlan(f.userId)).toBe('PRO');
      expect(limitsFor(await getPlan(f.userId)).activeTasks).toBeNull();
      await expect(createTask(f.actor, { workspaceId: f.workspaceId, title: 'Task 201', dueAt: new Date(Date.now() + DAY).toISOString(), priority: 'MEDIUM', tagIds: [] })).resolves.toBeTruthy();
      const snapshot = await getEntitlementSnapshot(f.userId, f.workspaceId);
      expect(snapshot.plan).toBe('PRO');

      // The webhook is persisted and linked to its owner; the change is audited.
      expect(await eventCount(h.providerName, f.userId)).toBe(2);
      expect(await auditCount(f.userId, 'billing.subscription_changed')).toBeGreaterThanOrEqual(1);

      // Server-authoritative view: what the row says vs what is enforced.
      const view = await getBillingSubscriptionState(getDb(), f.userId);
      expect(view).toMatchObject({ plan: 'PRO', effectivePlan: 'PRO', status: 'ACTIVE', cancelAtPeriodEnd: false });
      expect(view.provider).toBe(h.providerName);
    });

    it('rejects forged, tampered, replayed and unsigned webhooks before any state or ledger change', async () => {
      const f = await checkoutFixture(h, 'PRO');
      const before = await subRow(f.userId);
      const body = h.paymentFailedBody(f.subscription, f.customer);

      // Forged signature (valid format, corrupted hash).
      const forged = h.sign(body, nowS());
      const [sigKey, sigValue] = Object.entries(forged)[0]!;
      await expect(h.deliverRaw(body, { [sigKey]: corruptSignature(sigValue) })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

      // Tampered body (signature computed over different bytes).
      const tampered = body.replaceAll('payment_failed', 'payment_failed_tampered').replaceAll('payment.failed', 'payment.failed_tampered');
      expect(tampered).not.toBe(body);
      await expect(h.deliverRaw(tampered, h.sign(body, nowS()))).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

      // Replayed event (valid signature, outside the timestamp window).
      const oldT = nowS() - 3600;
      const oldBody = h.paymentFailedBody(f.subscription, f.customer, oldT);
      await expect(h.deliverRaw(oldBody, h.sign(oldBody, oldT))).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

      // Missing signature.
      await expect(h.deliverRaw(body, {})).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

      const after = await subRow(f.userId);
      expect(after?.version).toBe(before?.version);
      expect(await eventCount(h.providerName, f.userId)).toBe(0);
    });

    it('deduplicates a repeated webhook: same event id is applied exactly once', async () => {
      const f = await checkoutFixture(h, 'PRO');
      const body = h.activateBody(f.customer, f.subscription, 'PRO', f.periodEndS);
      const first = (await h.deliver(body)) as BillingEventOutcome;
      expect(first.applied).toBe(true);
      const versionAfterFirst = (await subRow(f.userId))?.version;

      const second = (await h.deliver(body)) as BillingEventOutcome;
      expect(second).toMatchObject({ duplicate: true, applied: false });
      expect((await subRow(f.userId))?.version).toBe(versionAfterFirst);
      expect(await eventCount(h.providerName, f.userId)).toBe(1);
      expect(await auditCount(f.userId, 'billing.subscription_changed')).toBe(1);
    });

    it('a second event reusing the same provider event id is still deduplicated (id, not payload, is the key)', async () => {
      const f = await checkoutFixture(h, 'PRO');
      const firstBody = h.activateBody(f.customer, f.subscription, 'PRO', f.periodEndS);
      const firstId = firstBody.match(/"id":"([^"]+)"/)?.[1];
      expect(firstId).toBeTruthy();
      await h.deliver(firstBody);

      // Different payload, same event id: build the upgrade body and graft the id.
      const upgradeBody = h.planChangeBody(f.subscription, f.customer, 'TEAM', f.periodEndS);
      const reuseId = upgradeBody.replace(/"id":"[^"]+"/, `"id":"${firstId}"`);
      expect(reuseId).not.toBe(upgradeBody);
      const result = (await h.deliver(reuseId)) as BillingEventOutcome;
      expect(result).toMatchObject({ duplicate: true, applied: false });
      expect((await subRow(f.userId))?.plan).toBe('PRO'); // upgrade never applied
    });

    it('upgrade applies immediately; downgrade defers to the next period and preserves over-limit data', async () => {
      const f = await checkoutFixture(h, 'PRO');
      await activate(h, f);
      expect(await getPlan(f.userId)).toBe('PRO');

      // Upgrade PRO -> TEAM: immediate, limits widen at once.
      await h.deliver(h.planChangeBody(f.subscription, f.customer, 'TEAM', f.periodEndS));
      expect((await subRow(f.userId))?.plan).toBe('TEAM');
      expect(await getPlan(f.userId)).toBe('TEAM');
      expect((await getEntitlementSnapshot(f.userId, f.workspaceId)).limits).toEqual(limitsFor('TEAM'));

      // Create a 4th project while on TEAM (unlimited projects)…
      for (let i = 1; i <= 4; i++) await createProject(f.actor, { name: `Project ${i}` });
      const projectCount = async () => {
        const [row] = await getDb().select({ n: count() }).from(projects).where(eq(projects.workspaceId, f.workspaceId));
        return row?.n ?? 0;
      };
      expect(await projectCount()).toBe(4);

      // …downgrade TEAM -> PRO: current period keeps TEAM, next period is PRO.
      await h.deliver(h.planChangeBody(f.subscription, f.customer, 'PRO', f.periodEndS));
      const during = await subRow(f.userId);
      expect(during?.plan).toBe('TEAM');
      expect(during?.pendingPlan).toBe('PRO');
      expect(await getPlan(f.userId)).toBe('TEAM');
      // Limits still follow TEAM during the current period.
      expect((await getEntitlementSnapshot(f.userId, f.workspaceId)).limits).toEqual(limitsFor('TEAM'));

      // The period rolls: the pending downgrade applies and data is preserved.
      await backdatePeriodEnd(f.userId, -1);
      const sweep = await applyBillingDeadlines(getDb());
      expect(sweep.downgradesApplied).toBeGreaterThanOrEqual(1);
      const after = await subRow(f.userId);
      expect(after?.plan).toBe('PRO');
      expect(after?.pendingPlan).toBeNull();
      expect(await getPlan(f.userId)).toBe('PRO');
      expect(await projectCount()).toBe(4); // data preserved (read-only semantics)

      // Limits re-evaluate to the effective plan; enforcers agree with it.
      const proView = await getEntitlementSnapshot(f.userId, f.workspaceId);
      expect(proView.plan).toBe('PRO');
      expect(proView.limits).toEqual(limitsFor('PRO'));
      expect(proView.usage.projects).toBe(4);
      await expect(enforceProjectLimit(f.userId, f.workspaceId)).resolves.toBeUndefined();
      await expect(enforceTaskLimit(f.userId, f.workspaceId)).resolves.toBeUndefined();
    });

    it('cancellation keeps access through the paid period, then expires at the period end', async () => {
      const f = await checkoutFixture(h, 'PRO');
      await activate(h, f);

      await h.deliver(h.cancelBody(f.subscription, f.customer, 'PRO', f.periodEndS));
      const canceled = await subRow(f.userId);
      expect(canceled?.status).toBe('CANCELED');
      expect(canceled?.cancelAtPeriodEnd).toBe(true);
      // Access preserved through the paid period (readEffectivePlan: CANCELED + future period end).
      expect(await getPlan(f.userId)).toBe('PRO');

      // Before the period end, the sweep must NOT expire it.
      await applyBillingDeadlines(getDb());
      expect((await subRow(f.userId))?.status).toBe('CANCELED');

      // The period ends: EXPIRED, entitlements drop to FREE.
      await backdatePeriodEnd(f.userId, -1);
      const sweep = await applyBillingDeadlines(getDb());
      expect(sweep.expired).toBeGreaterThanOrEqual(1);
      expect((await subRow(f.userId))?.status).toBe('EXPIRED');
      expect(await getPlan(f.userId)).toBe('FREE');
      expect(await auditCount(f.userId, 'billing.deadline_swept')).toBeGreaterThanOrEqual(1);
    });

    it('failed payment grants a 7-day grace with full access; recovery restores ACTIVE; exhaustion expires', async () => {
      const f = await checkoutFixture(h, 'PRO');
      await activate(h, f);

      // Payment failure: PAST_DUE, grace clock = now + 7 days, access retained.
      const failed = (await h.deliver(h.paymentFailedBody(f.subscription, f.customer))) as BillingEventOutcome;
      expect(failed.status).toBe('PAST_DUE');
      const pastDue = await subRow(f.userId);
      expect(pastDue?.graceEndsAt).toBeInstanceOf(Date);
      expect(pastDue?.graceEndsAt!.getTime()).toBeGreaterThan(Date.now() + 6 * DAY);
      expect(pastDue?.graceEndsAt!.getTime()).toBeLessThanOrEqual(Date.now() + 8 * DAY);
      expect(await getPlan(f.userId)).toBe('PRO'); // 7-day full access

      // Recovery: ACTIVE again, grace clock cleared.
      await h.deliver(h.paymentSucceededBody(f.subscription, f.customer, 'PRO', f.periodEndS));
      const recovered = await subRow(f.userId);
      expect(recovered?.status).toBe('ACTIVE');
      expect(recovered?.graceEndsAt).toBeNull();

      // Second failure, then the provider reports dunning (Razorpay halted;
      // Stripe's dunning is implicit in PAST_DUE, so this step is Razorpay-only).
      await h.deliver(h.paymentFailedBody(f.subscription, f.customer));
      if (h.dunningBody) {
        const halted = (await h.deliver(h.dunningBody(f.subscription, f.customer, 'PRO', f.periodEndS))) as BillingEventOutcome;
        expect(halted.status).toBe('GRACE_PERIOD');
        const grace = await subRow(f.userId);
        expect(grace?.graceEndsAt?.getTime()).toBeGreaterThan(Date.now() + 6 * DAY);
      }

      // Dunning exhausted: the grace window elapses, entitlements drop.
      await backdateGrace(f.userId, -1);
      await applyBillingDeadlines(getDb());
      expect((await subRow(f.userId))?.status).toBe('EXPIRED');
      expect(await getPlan(f.userId)).toBe('FREE');
    });

    it('version-fences every transition and skips illegal transitions with audit (no corruption)', async () => {
      const f = await checkoutFixture(h, 'PRO');
      const v0 = (await subRow(f.userId))?.version;
      await activate(h, f);
      const v1 = (await subRow(f.userId))?.version;
      expect(v1).toBe(v0! + 2); // activation + follow-up period event

      await h.deliver(h.planChangeBody(f.subscription, f.customer, 'TEAM', f.periodEndS));
      expect((await subRow(f.userId))?.version).toBe(v1! + 1);

      // Illegal: an ACTIVE subscription's period "ends" — that is a renewal,
      // not an expiry. The state machine must refuse and audit the refusal.
      const before = await subRow(f.userId);
      const skipped = (await h.deliver(h.periodEndBody(f.subscription, f.customer, 'TEAM', f.periodEndS))) as BillingEventOutcome;
      expect(skipped).toMatchObject({ applied: false, skipReason: expect.stringMatching(/illegal transition/) });
      expect(await auditCount(f.userId, 'billing.event_skipped')).toBe(1);
      const after = await subRow(f.userId);
      expect(after?.status).toBe(before?.status);
      expect(after?.version).toBe(before?.version);

      // From CANCELED the same event IS legal (paid period ends).
      await h.deliver(h.cancelBody(f.subscription, f.customer, 'TEAM', f.periodEndS));
      const ended = (await h.deliver(h.periodEndBody(f.subscription, f.customer, 'TEAM', f.periodEndS))) as BillingEventOutcome;
      expect(ended).toMatchObject({ applied: true, status: 'EXPIRED' });
    });

    it('skips stale out-of-order events, reconciliation reports the drift, fresh re-delivery converges it', async () => {
      const f = await checkoutFixture(h, 'PRO');
      await activate(h, f);

      // A payment-failed event that HAPPENED before the last applied event
      // arrives late: applying it would revoke a payment that succeeded. The
      // offset stays INSIDE the provider's signature replay window (Stripe:
      // fresh header timestamp over an old event `created`; Razorpay: no
      // header timestamp, so `created_at` must be <= 15 min old) — the DB
      // event horizon, not the signature layer, is what skips it.
      const staleT = h.providerName === 'STRIPE' ? nowS() - 2 * 3600 : nowS() - 5 * 60;
      const stale = (await h.deliver(h.paymentFailedBody(f.subscription, f.customer, staleT))) as BillingEventOutcome;
      expect(stale).toMatchObject({ applied: false, skipReason: 'stale_event' });
      expect(await getPlan(f.userId)).toBe('PRO');
      expect(await auditCount(f.userId, 'billing.event_skipped')).toBe(1);

      // Reconciliation against the provider's current view (dunning) alerts
      // on the drift — alert only, never a silent self-rewrite (PRD §18.3).
      const providerView = h.providerName === 'STRIPE'
        ? { id: f.subscription, status: 'past_due', cancel_at_period_end: false, current_period_end: f.periodEndS, customer: f.customer, currency: 'usd', items: { data: [{ price: { id: h.planRef.PRO } }] } }
        : { id: f.subscription, status: 'halted', plan_id: h.planRef.PRO, customer_id: f.customer, current_period_end: f.periodEndS };
      h.mockSub(providerView);
      const drift = await reconcileBilling(getDb(), h.provider, undefined, f.userId);
      expect(drift.checked).toBe(1);
      expect(drift.drifted).toHaveLength(1);
      expect(drift.drifted[0]?.diffs.map((d) => d.field)).toEqual(['status']);
      expect(await auditCount(f.userId, 'billing.reconciliation_drift')).toBe(1);

      // Recovery: the provider's current state is re-delivered as FRESH
      // events and converges; the next reconciliation is clean.
      await h.deliver(h.paymentFailedBody(f.subscription, f.customer));
      if (h.dunningBody) await h.deliver(h.dunningBody(f.subscription, f.customer, 'PRO', f.periodEndS));
      expect((await subRow(f.userId))?.status).toBe(h.providerName === 'STRIPE' ? 'PAST_DUE' : 'GRACE_PERIOD');
      const clean = await reconcileBilling(getDb(), h.provider, undefined, f.userId);
      expect(clean.drifted).toHaveLength(0);
      h.mockSub(null);
    });

    it('tenant isolation: foreign, unknown and cross-provider customers never touch this user', async () => {
      const f = await checkoutFixture(h, 'PRO');
      await activate(h, f);
      const otherProvider: ProviderName = h.providerName === 'STRIPE' ? 'RAZORPAY' : 'STRIPE';

      // A second user whose subscription row belongs to the OTHER provider.
      const other = await freshUser();
      const foreignCustomer = `cust_foreign_${randomUUID().slice(0, 8)}`;
      await getDb().update(subscriptions).set({ provider: otherProvider, providerCustomerId: foreignCustomer }).where(eq(subscriptions.userId, other.userId));
      const otherBefore = await subRow(other.userId);

      // A cross-provider id: the customer is real, but on the other
      // provider — resolution is scoped to THIS provider's mapping.
      const cross = (await h.deliver(h.activateBody(foreignCustomer, `sub_${randomUUID()}`, 'PRO', f.periodEndS))) as BillingEventOutcome;
      expect(cross).toMatchObject({ unresolved: true, applied: false });
      expect((await subRow(other.userId))?.version).toBe(otherBefore?.version);

      // A customer that does not exist in ANY provider's mapping.
      const orphanCount = async () => {
        const [row] = await getDb().select({ n: count() }).from(billingEvents).where(and(eq(billingEvents.provider, h.providerName), isNull(billingEvents.userId)));
        return row?.n ?? 0;
      };
      const orphansBefore = await orphanCount();
      const unknown = (await h.deliver(h.activateBody('cust_unknown', `sub_${randomUUID()}`, 'PRO', f.periodEndS))) as BillingEventOutcome;
      expect(unknown).toMatchObject({ unresolved: true, applied: false });
      expect(await auditCount(null, 'billing.event_unresolved')).toBeGreaterThanOrEqual(1);
      // The unresolved event is persisted (audit/tax evidence) but ownerless.
      expect(await orphanCount()).toBeGreaterThanOrEqual(orphansBefore + 1);

      // This user's own event still resolves to exactly this user.
      const own = (await h.deliver(h.paymentSucceededBody(f.subscription, f.customer, 'PRO', f.periodEndS))) as BillingEventOutcome;
      expect(own).toMatchObject({ applied: false, unresolved: false }); // ACTIVE->ACTIVE, period refreshed
      expect((await subRow(other.userId))?.version).toBe(otherBefore?.version);
    });

    it('refunds are audited without changing status or plan (PRD §18.3)', async () => {
      const f = await checkoutFixture(h, 'PRO');
      await activate(h, f);
      const before = await subRow(f.userId);

      const refund = (await h.deliver(h.refundBody(f.subscription, f.customer))) as BillingEventOutcome;
      expect(refund).toMatchObject({ applied: false, unresolved: false, duplicate: false });
      expect(await auditCount(f.userId, 'billing.subscription_event')).toBe(1);
      const after = await subRow(f.userId);
      expect(after?.status).toBe(before?.status);
      expect(after?.plan).toBe(before?.plan);
      expect(await getPlan(f.userId)).toBe('PRO');
    });

    it('reconciliation: clean state produces no drift; unconfigured providers check nothing', async () => {
      const f = await checkoutFixture(h, 'PRO');
      await activate(h, f);
      h.mockSub(null); // default stub matches the local state (active, PRO, same period end)
      const clean = await reconcileBilling(getDb(), h.provider, undefined, f.userId);
      expect(clean.checked).toBe(1);
      expect(clean.drifted).toHaveLength(0);
      expect(await reconcileBilling(getDb(), h.unconfigured, undefined, f.userId)).toEqual({
        provider: h.providerName, checked: 0, drifted: [], unreachable: 0,
      });
    });
  });
}

// ------------------------------------------------------- cross-provider + sweep

it('cross-provider: a user with a Stripe customer cannot silently switch to Razorpay checkout', async () => {
  const { userId, workspaceId } = await freshUser();
  const input: CheckoutInput = {
    userId, workspaceId, plan: 'PRO',
    successUrl: 'http://localhost:3000/billing/success', cancelUrl: 'http://localhost:3000/billing/cancel',
  };
  await startCheckout(getDb(), stripe.provider, input);
  const row = await subRow(userId);
  expect(row?.provider).toBe('STRIPE');
  expect(row?.providerCustomerId).toBeTruthy();

  await expect(startCheckout(getDb(), razorpay.provider, input)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  // A Razorpay event cannot resolve the Stripe row (provider-scoped lookup).
  const body = razorpay.activateBody(row!.providerCustomerId!, `sub_${randomUUID()}`, 'PRO', nowS() + 30 * 86_400);
  const result = (await razorpay.deliver(body)) as BillingEventOutcome;
  expect(result).toMatchObject({ unresolved: true });
  expect((await subRow(userId))?.provider).toBe('STRIPE');
});

it('deadline sweep: trial end, dunning exhaustion, paid-period end and pending downgrade are applied once, idempotently', async () => {
  const mk = async (setup: (userId: string) => Promise<void>) => {
    const { userId } = await freshUser();
    await setup(userId);
    return userId;
  };
  const past = new Date(Date.now() - DAY);
  const future = new Date(Date.now() + 30 * DAY);

  const trialUser = await mk(async (u) => { await getDb().update(subscriptions).set({ plan: 'PRO', status: 'TRIALING', trialEndsAt: past }).where(eq(subscriptions.userId, u)); });
  const graceUser = await mk(async (u) => { await getDb().update(subscriptions).set({ plan: 'PRO', status: 'GRACE_PERIOD', graceEndsAt: past }).where(eq(subscriptions.userId, u)); });
  const canceledUser = await mk(async (u) => { await getDb().update(subscriptions).set({ plan: 'PRO', status: 'CANCELED', currentPeriodEnd: past }).where(eq(subscriptions.userId, u)); });
  const downgradeUser = await mk(async (u) => { await getDb().update(subscriptions).set({ plan: 'TEAM', pendingPlan: 'PRO', currentPeriodEnd: past }).where(eq(subscriptions.userId, u)); });
  // A canceled user whose paid period still runs must NOT be expired.
  const safeUser = await mk(async (u) => { await getDb().update(subscriptions).set({ plan: 'PRO', status: 'CANCELED', currentPeriodEnd: future }).where(eq(subscriptions.userId, u)); });

  const sweep = await applyBillingDeadlines(getDb());
  expect(sweep.expired).toBeGreaterThanOrEqual(3);
  expect(sweep.downgradesApplied).toBeGreaterThanOrEqual(1);

  expect((await subRow(trialUser))?.status).toBe('EXPIRED');
  expect((await subRow(graceUser))?.status).toBe('EXPIRED');
  expect((await subRow(canceledUser))?.status).toBe('EXPIRED');
  const downgrade = await subRow(downgradeUser);
  expect(downgrade?.plan).toBe('PRO');
  expect(downgrade?.pendingPlan).toBeNull();
  expect((await subRow(safeUser))?.status).toBe('CANCELED');

  // Audit evidence for each transition.
  expect(await auditCount(trialUser, 'billing.deadline_swept')).toBe(1);
  expect(await auditCount(downgradeUser, 'billing.deadline_swept')).toBe(1);

  // Idempotent: a second sweep changes nothing new.
  const again = await applyBillingDeadlines(getDb());
  expect(again.expired).toBe(0);
  expect(again.downgradesApplied).toBe(0);
});

it('enforcement re-evaluates when a subscription expires to FREE: over-limit data is preserved, new creates are blocked', async () => {
  const f = await checkoutFixture(razorpay, 'PRO');
  await activate(razorpay, f);

  // While PRO (uncapped) fill the workspace past the FREE boundaries
  // (FREE: 3 projects, 200 active tasks).
  for (let i = 1; i <= 3; i++) await createProject(f.actor, { name: `Boundary project ${i}` });
  await createProject(f.actor, { name: 'Boundary project 4' });
  await insertActiveTasks(f.workspaceId, 200);
  await createTask(f.actor, { workspaceId: f.workspaceId, title: 'Task 201', dueAt: new Date(Date.now() + DAY).toISOString(), priority: 'MEDIUM', tagIds: [] });

  // Cancel at period end and let the paid period run out: plan drops to FREE.
  await razorpay.deliver(razorpay.cancelBody(f.subscription, f.customer, 'PRO', f.periodEndS));
  await backdatePeriodEnd(f.userId, -1);
  await applyBillingDeadlines(getDb());
  expect(await getPlan(f.userId)).toBe('FREE');

  // Over-limit data is preserved (read-only semantics, PRD §18.3).
  const [projectRow] = await getDb().select({ n: count() }).from(projects).where(eq(projects.workspaceId, f.workspaceId));
  expect(projectRow?.n).toBe(4);
  const [taskRow] = await getDb().select({ n: count() }).from(tasks).where(eq(tasks.workspaceId, f.workspaceId));
  expect(taskRow?.n).toBe(201);

  // And the FREE caps bite for NEW creates; enforcers agree with the plan.
  await expect(createProject(f.actor, { name: 'Boundary project 5' })).rejects.toMatchObject({ code: 'ENTITLEMENT_LIMIT_REACHED' });
  await expect(createTask(f.actor, { workspaceId: f.workspaceId, title: 'Task 202', dueAt: new Date(Date.now() + DAY).toISOString(), priority: 'MEDIUM', tagIds: [] })).rejects.toMatchObject({ code: 'ENTITLEMENT_LIMIT_REACHED' });
  await expect(enforceProjectLimit(f.userId, f.workspaceId)).rejects.toMatchObject({ code: 'ENTITLEMENT_LIMIT_REACHED' });
  await expect(enforceTaskLimit(f.userId, f.workspaceId)).rejects.toMatchObject({ code: 'ENTITLEMENT_LIMIT_REACHED' });
});
