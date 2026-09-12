import { AppError } from '@nextdoo/contracts';
import type { StripePlanMapping } from '../plans';
import { planForStripePrice } from '../plans';
import { buildSnapshot, nested, num, str, stripeStatusToInternal, toDate } from '../normalize';
import { verifyStripeSignature } from '../signature';
import type { BillingEvent, CheckoutRequest, CheckoutResult, PaymentProvider, ProviderSubscriptionSnapshot } from '../types';

/**
 * Stripe adapter (fetch-based REST, no vendor SDK): hosted Checkout for M1
 * direct purchase, signature-verified webhooks, normalized events.
 *
 * Test-mode only in practice: the configuration layer refuses to hand this
 * adapter production credentials (see config.ts), and isConfigured() stays
 * false until a COMPLETE test-mode configuration is present.
 */
export interface StripeProviderConfig {
  secretKey: string;
  webhookSecret: string;
  plans: StripePlanMapping;
}

const API_BASE = 'https://api.stripe.com/v1';

export class StripeProvider implements PaymentProvider {
  readonly id = 'STRIPE' as const;

  private constructor(
    private readonly config: StripeProviderConfig,
    private readonly fetchImpl: typeof fetch,
  ) {}

  static create(config: StripeProviderConfig, fetchImpl: typeof fetch = fetch): StripeProvider {
    return new StripeProvider(config, fetchImpl);
  }

  isConfigured(): boolean {
    const { secretKey, webhookSecret, plans } = this.config;
    return Boolean(secretKey && webhookSecret && plans.PRO && plans.TEAM && plans.ENTERPRISE);
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${API_BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.config.secretKey}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      throw new AppError('PROVIDER_UNAVAILABLE', 'The billing provider could not be reached.', { cause: error });
    }
    if (!response.ok) {
      // Never echo the provider error body: it can carry request internals.
      throw new AppError('PROVIDER_UNAVAILABLE', `The billing provider rejected the request (HTTP ${response.status}).`);
    }
    return (await response.json()) as T;
  }

  async createCustomer(input: { userId: string; email: string; name: string | null }): Promise<{ providerCustomerId: string }> {
    const json = await this.request<{ id: string }>('POST', '/customers', {
      email: input.email,
      ...(input.name ? { name: input.name } : {}),
      metadata: { user_id: input.userId },
    });
    return { providerCustomerId: json.id };
  }

  async createCheckout(input: CheckoutRequest): Promise<CheckoutResult> {
    const price = this.config.plans[input.plan];
    if (!price) throw new AppError('VALIDATION_FAILED', `Plan ${input.plan} has no configured price for this provider.`);
    const json = await this.request<{ id: string; url: string | null }>('POST', '/checkout/sessions', {
      mode: 'subscription',
      line_items: [{ price, quantity: 1 }],
      customer: input.customer.id,
      customer_email: input.customer.email,
      // The app's own user id travels with the session; webhooks resolve the
      // owner through the stored provider customer id, this is a fallback.
      client_reference_id: input.userId,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
    });
    if (!json.url) throw new AppError('PROVIDER_UNAVAILABLE', 'The billing provider returned no checkout URL.');
    return { method: 'REDIRECT', redirectUrl: json.url, providerSessionId: json.id };
  }

  async verifyWebhook(rawBody: string, headers: Record<string, string>): Promise<{ occurredAt: Date }> {
    const header = headers['stripe-signature'];
    if (!header) throw new AppError('UNAUTHENTICATED', 'Webhook signature is missing.');
    const verdict = verifyStripeSignature(header, this.config.webhookSecret, rawBody);
    if (!verdict.valid) {
      throw new AppError('UNAUTHENTICATED', `Webhook signature verification failed: ${verdict.reason ?? 'invalid signature'}.`);
    }
    return { occurredAt: new Date((verdict.timestampSeconds ?? Math.floor(Date.now() / 1000)) * 1000) };
  }

  normalizeEvent(payload: unknown): BillingEvent | null {
    const event = asObject(payload);
    const id = str(event.id);
    const type = str(event.type);
    if (!id || !type) throw new AppError('VALIDATION_FAILED', 'Stripe webhook event is malformed.');
    const occurredAt = new Date((num(event.created) ?? Math.floor(Date.now() / 1000)) * 1000);
    const object = asObject(nested(event, 'data', 'object'));
    const base = { provider: this.id, providerEventId: id, occurredAt };

    switch (type) {
      case 'checkout.session.completed': {
        if (str(object.mode) !== 'subscription') return null;
        const subscriptionId = subId(object.subscription);
        if (typeof object.subscription === 'object' && object.subscription !== null && subscriptionId === null) {
          throw new AppError('VALIDATION_FAILED', 'Stripe checkout session has no subscription.');
        }
        const priceId = priceIdFromLineItems(object.line_items);
        const customerId = str(object.customer);
        return {
          ...base,
          type: 'SUBSCRIPTION_ACTIVATED',
          providerSubscriptionId: subscriptionId,
          providerCustomerId: customerId,
          snapshot: buildSnapshot(this.id, subscriptionId ?? 'pending', {
            providerCustomerId: customerId,
            plan: planForStripePrice(this.config.plans, priceId),
            providerPlanRef: priceId,
            // Paid checkout completes only after capture; the period end and
            // any trial end arrive with the subscription events that follow.
            status: 'ACTIVE',
            cancelAtPeriodEnd: false,
            currency: object.currency !== null && typeof object.currency === 'string' ? object.currency.toUpperCase() : null,
          }),
          metadata: { stripe_type: type, session_id: str(object.id) },
        };
      }
      case 'customer.subscription.created':
        return {
          ...base,
          type: 'SUBSCRIPTION_CREATED',
          providerSubscriptionId: str(object.id),
          providerCustomerId: str(object.customer),
          snapshot: this.mapSubscription(object, occurredAt),
          metadata: { stripe_type: type },
        };
      case 'customer.subscription.updated':
        return {
          ...base,
          type: 'SUBSCRIPTION_UPDATED',
          providerSubscriptionId: str(object.id),
          providerCustomerId: str(object.customer),
          snapshot: this.mapSubscription(object, occurredAt),
          metadata: { stripe_type: type },
        };
      case 'customer.subscription.deleted':
        // Period ended or immediate cancel: the paid period is over.
        return {
          ...base,
          type: 'SUBSCRIPTION_PERIOD_ENDED',
          providerSubscriptionId: str(object.id),
          providerCustomerId: str(object.customer),
          snapshot: this.mapSubscription(object, occurredAt),
          metadata: { stripe_type: type },
        };
      case 'invoice.payment_failed': {
        const subscriptionId = subId(object.subscription);
        const customerId = str(object.customer);
        return {
          ...base,
          type: 'PAYMENT_FAILED',
          providerSubscriptionId: subscriptionId,
          providerCustomerId: customerId,
          snapshot: subscriptionId
            ? buildSnapshot(this.id, subscriptionId, { providerCustomerId: customerId, status: 'PAST_DUE', currentPeriodEnd: toDate(num(object.period_end)) })
            : null,
          metadata: { stripe_type: type, invoice: str(object.id) },
        };
      }
      case 'invoice.paid':
      case 'invoice.payment_succeeded': {
        const subscriptionId = subId(object.subscription);
        const customerId = str(object.customer);
        return {
          ...base,
          type: 'PAYMENT_SUCCEEDED',
          providerSubscriptionId: subscriptionId,
          providerCustomerId: customerId,
          snapshot: subscriptionId
            ? buildSnapshot(this.id, subscriptionId, { providerCustomerId: customerId, status: 'ACTIVE', currentPeriodEnd: toDate(num(object.period_end)) })
            : null,
          metadata: { stripe_type: type, invoice: str(object.id) },
        };
      }
      case 'charge.refunded': {
        // PRD §18.3: refunds are reflected through webhook events; entitlements
        // persist through the paid period, so no status is targeted here.
        return {
          ...base,
          type: 'REFUND_ISSUED',
          providerSubscriptionId: subId(object.subscription),
          providerCustomerId: str(object.customer),
          snapshot: null,
          metadata: {
            stripe_type: type,
            charge: str(object.id),
            currency: object.currency !== null && typeof object.currency === 'string' ? object.currency.toUpperCase() : null,
          },
        };
      }
      default:
        return null;
    }
  }

  async getSubscription(providerSubscriptionId: string): Promise<ProviderSubscriptionSnapshot> {
    const object = await this.request<Record<string, unknown>>('GET', `/subscriptions/${encodeURIComponent(providerSubscriptionId)}`);
    return this.mapSubscription(object, new Date());
  }

  private mapSubscription(object: Record<string, unknown>, now: Date): ProviderSubscriptionSnapshot {
    const id = str(object.id) ?? 'unknown';
    const status = str(object.status) ?? '';
    const cancelAtPeriodEnd = object.cancel_at_period_end === true;
    const currentPeriodEnd = toDate(num(object.current_period_end));
    const priceId = priceIdFromItems(object.items);
    return buildSnapshot(this.id, id, {
      providerCustomerId: str(object.customer),
      plan: planForStripePrice(this.config.plans, priceId),
      providerPlanRef: priceId,
      status: stripeStatusToInternal(status, cancelAtPeriodEnd, currentPeriodEnd, now),
      currentPeriodEnd,
      trialEndsAt: toDate(num(object.trial_end)),
      cancelAtPeriodEnd,
      currency: object.currency !== null && typeof object.currency === 'string' ? object.currency.toUpperCase() : null,
    });
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function subId(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return str((value as Record<string, unknown>).id);
  return null;
}

function priceIdFromLineItems(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return str(nested(value[0], 'price')?.id);
}

function priceIdFromItems(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = (value as Record<string, unknown>).data;
  if (!Array.isArray(data) || data.length === 0) return null;
  return str(nested(data[0], 'price')?.id);
}
