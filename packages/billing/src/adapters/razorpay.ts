import { AppError } from '@nextdoo/contracts';
import type { RazorpayPlanMapping } from '../plans';
import { planForRazorpayAmount, planForRazorpayPlan, razorpayPlanForName } from '../plans';
import { buildSnapshot, nested, num, razorpayStatusToInternal, str, toDate } from '../normalize';
import { verifyRazorpaySignature } from '../signature';
import type { BillingEvent, CheckoutRequest, CheckoutResult, PaymentProvider, ProviderSubscriptionSnapshot, PurchasablePlan } from '../types';

/**
 * Razorpay adapter (fetch-based REST, no vendor SDK).
 *
 * Razorpay's checkout is an embedded client-side widget, not a hosted page:
 * the server creates a priced ORDER and the app launches Checkout.js with the
 * returned parameters (EMBEDDED_CHECKOUT). The recurring plan is bound via
 * plan_id; the first captured payment activates the subscription and the
 * `subscription.*` webhooks drive the lifecycle.
 *
 * Test-mode only in practice (see config.ts); isConfigured() stays false
 * until a COMPLETE test-mode configuration is present.
 */
export interface RazorpayProviderConfig {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  plans: RazorpayPlanMapping;
}

const API_BASE = 'https://api.razorpay.com/v1';
const PLAN_NAMES = ['PRO', 'TEAM', 'ENTERPRISE'] as const;

export class RazorpayProvider implements PaymentProvider {
  readonly id = 'RAZORPAY' as const;

  private constructor(
    private readonly config: RazorpayProviderConfig,
    private readonly fetchImpl: typeof fetch,
  ) {}

  static create(config: RazorpayProviderConfig, fetchImpl: typeof fetch = fetch): RazorpayProvider {
    return new RazorpayProvider(config, fetchImpl);
  }

  isConfigured(): boolean {
    const { keyId, keySecret, webhookSecret, plans } = this.config;
    return Boolean(keyId && keySecret && webhookSecret && plans.PRO?.id && plans.TEAM?.id && plans.ENTERPRISE?.id);
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<T> {
    const token = Buffer.from(`${this.config.keyId}:${this.config.keySecret}`).toString('base64');
    let response: Response;
    try {
      response = await this.fetchImpl(`${API_BASE}${path}`, {
        method,
        headers: {
          Authorization: `Basic ${token}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      throw new AppError('PROVIDER_UNAVAILABLE', 'The billing provider could not be reached.', { cause: error });
    }
    if (!response.ok) {
      throw new AppError('PROVIDER_UNAVAILABLE', `The billing provider rejected the request (HTTP ${response.status}).`);
    }
    return (await response.json()) as T;
  }

  async createCustomer(input: { userId: string; email: string; name: string | null }): Promise<{ providerCustomerId: string }> {
    const json = await this.request<{ id: string }>('POST', '/customers', {
      name: input.name ?? 'Nextdoo User',
      email: input.email,
      fail_existing: false,
    });
    return { providerCustomerId: json.id };
  }

  async createCheckout(input: CheckoutRequest): Promise<CheckoutResult> {
    const ref = this.config.plans[input.plan];
    if (!ref?.id) throw new AppError('VALIDATION_FAILED', `Plan ${input.plan} has no configured plan for this provider.`);
    // The order prices the FIRST period; subsequent periods charge the plan.
    const order = await this.request<{ id: string; amount: number; currency: string }>('POST', '/orders', {
      amount: ref.amountPaise,
      currency: 'INR',
      receipt: `nextdoo_${input.userId}`,
      notes: { user_id: input.userId, plan: input.plan },
    });
    return {
      method: 'EMBEDDED_CHECKOUT',
      keyId: this.config.keyId,
      providerSessionId: order.id,
      parameters: {
        order_id: order.id,
        amount: order.amount,
        currency: order.currency ?? 'INR',
        name: 'Nextdoo',
        plan_id: ref.id,
        prefill: { email: input.customer.email, name: input.customer.name ?? '' },
        notes: { user_id: input.userId, plan: input.plan },
        callback_url: input.successUrl,
      },
    };
  }

  async verifyWebhook(rawBody: string, headers: Record<string, string>): Promise<{ occurredAt: Date }> {
    const signature = headers['x-razorpay-signature'];
    if (!signature) throw new AppError('UNAUTHENTICATED', 'Webhook signature is missing.');
    let createdAt: number | null = null;
    try {
      createdAt = num(asObject(JSON.parse(rawBody)).created_at);
    } catch {
      createdAt = null;
    }
    const verdict = verifyRazorpaySignature(signature, this.config.webhookSecret, rawBody, createdAt);
    if (!verdict.valid) {
      throw new AppError('UNAUTHENTICATED', `Webhook signature verification failed: ${verdict.reason ?? 'invalid signature'}.`);
    }
    return { occurredAt: new Date((verdict.timestampSeconds ?? Math.floor(Date.now() / 1000)) * 1000) };
  }

  normalizeEvent(payload: unknown): BillingEvent | null {
    const event = asObject(payload);
    const id = str(event.id);
    const type = str(event.event);
    if (!id || !type) throw new AppError('VALIDATION_FAILED', 'Razorpay webhook event is malformed.');
    const occurredAt = new Date((num(event.created_at) ?? Math.floor(Date.now() / 1000)) * 1000);
    const payloadObj = asObject(event.payload);
    const base = { provider: this.id, providerEventId: id, occurredAt };
    const subEntity = () => asObject(nested(payloadObj, 'subscription', 'entity'));

    switch (type) {
      case 'payment.captured': {
        const entity = asObject(nested(payloadObj, 'payment', 'entity'));
        const subscriptionId = str(entity.subscription_id);
        const customerId = str(entity.customer_id);
        const plan = this.resolvePaymentPlan(entity);
        // The first captured payment activates; renewals stay ACTIVE (the
        // subscription.charged event carries the new period end).
        return {
          ...base,
          type: 'SUBSCRIPTION_ACTIVATED',
          providerSubscriptionId: subscriptionId,
          providerCustomerId: customerId,
          snapshot: buildSnapshot(this.id, subscriptionId ?? 'pending', {
            providerCustomerId: customerId,
            plan,
            providerPlanRef: plan ? razorpayPlanForName(this.config.plans, plan)?.id ?? null : null,
            status: 'ACTIVE',
            cancelAtPeriodEnd: false,
            currency: upper(entity.currency),
          }),
          metadata: { razorpay_type: type, payment: str(entity.id) },
        };
      }
      case 'payment.failed': {
        const entity = asObject(nested(payloadObj, 'payment', 'entity'));
        const subscriptionId = str(entity.subscription_id);
        const customerId = str(entity.customer_id);
        return {
          ...base,
          type: 'PAYMENT_FAILED',
          providerSubscriptionId: subscriptionId,
          providerCustomerId: customerId,
          snapshot: buildSnapshot(this.id, subscriptionId ?? 'pending', {
            providerCustomerId: customerId,
            status: 'PAST_DUE',
          }),
          metadata: { razorpay_type: type, payment: str(entity.id) },
        };
      }
      case 'refund.created':
      case 'refund.processed':
      case 'refund.completed':
      case 'refund.failed': {
        const entity = asObject(nested(payloadObj, 'refund', 'entity'));
        return {
          ...base,
          type: 'REFUND_ISSUED',
          providerSubscriptionId: null,
          providerCustomerId: str(entity.customer_id),
          snapshot: null,
          metadata: { razorpay_type: type, refund: str(entity.id), currency: upper(entity.currency) },
        };
      }
      case 'subscription.created':
        return { ...base, type: 'SUBSCRIPTION_CREATED', providerSubscriptionId: str(subEntity().id), providerCustomerId: str(subEntity().customer_id), snapshot: this.mapSubscription(subEntity(), occurredAt), metadata: { razorpay_type: type } };
      case 'subscription.charged':
        return { ...base, type: 'PAYMENT_SUCCEEDED', providerSubscriptionId: str(subEntity().id), providerCustomerId: str(subEntity().customer_id), snapshot: this.mapSubscription(subEntity(), occurredAt), metadata: { razorpay_type: type } };
      case 'subscription.halted':
        return { ...base, type: 'DUNNING_STARTED', providerSubscriptionId: str(subEntity().id), providerCustomerId: str(subEntity().customer_id), snapshot: this.mapSubscription(subEntity(), occurredAt), metadata: { razorpay_type: type } };
      case 'subscription.cancelled':
        return { ...base, type: 'SUBSCRIPTION_CANCELED', providerSubscriptionId: str(subEntity().id), providerCustomerId: str(subEntity().customer_id), snapshot: this.mapSubscription(subEntity(), occurredAt), metadata: { razorpay_type: type } };
      case 'subscription.completed':
        return { ...base, type: 'SUBSCRIPTION_PERIOD_ENDED', providerSubscriptionId: str(subEntity().id), providerCustomerId: str(subEntity().customer_id), snapshot: this.mapSubscription(subEntity(), occurredAt), metadata: { razorpay_type: type } };
      case 'subscription.paused':
        return { ...base, type: 'SUBSCRIPTION_PAUSED', providerSubscriptionId: str(subEntity().id), providerCustomerId: str(subEntity().customer_id), snapshot: this.mapSubscription(subEntity(), occurredAt), metadata: { razorpay_type: type } };
      case 'subscription.resumed':
        return { ...base, type: 'SUBSCRIPTION_RESUMED', providerSubscriptionId: str(subEntity().id), providerCustomerId: str(subEntity().customer_id), snapshot: this.mapSubscription(subEntity(), occurredAt), metadata: { razorpay_type: type } };
      default:
        return null;
    }
  }

  async getSubscription(providerSubscriptionId: string): Promise<ProviderSubscriptionSnapshot> {
    const entity = await this.request<Record<string, unknown>>('GET', `/subscriptions/${encodeURIComponent(providerSubscriptionId)}`);
    return this.mapSubscription(entity, new Date());
  }

  private mapSubscription(entity: Record<string, unknown>, now: Date): ProviderSubscriptionSnapshot {
    const id = str(entity.id) ?? 'unknown';
    const planId = str(entity.plan_id);
    const currentPeriodEnd = toDate(num(entity.current_period_end));
    const status = razorpayStatusToInternal(str(entity.status) ?? '', currentPeriodEnd, now);
    return buildSnapshot(this.id, id, {
      providerCustomerId: str(entity.customer_id),
      plan: planForRazorpayPlan(this.config.plans, planId),
      providerPlanRef: planId,
      status,
      currentPeriodEnd,
      // CANCELED here means "cancelled while the paid period still runs" —
      // access is preserved through the period end (PRD §18.3), which the
      // internal model records as cancel_at_period_end.
      cancelAtPeriodEnd: status === 'CANCELED',
      currency: upper(entity.currency),
    });
  }

  /** Notes written by the app at order time; amount match as the second source. */
  private resolvePaymentPlan(entity: Record<string, unknown>): PurchasablePlan | null {
    const notes = asObject(entity.notes);
    const noted = str(notes.plan);
    if (noted && (PLAN_NAMES as readonly string[]).includes(noted)) return noted as PurchasablePlan;
    return planForRazorpayAmount(this.config.plans, num(entity.amount));
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function upper(value: unknown): string | null {
  const s = str(value);
  return s ? s.toUpperCase() : null;
}
