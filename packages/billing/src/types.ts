/**
 * The provider-agnostic billing domain model (M6-i3, PRD §18).
 *
 * Nextdoo Billing Domain -> Internal Subscription State -> { Stripe adapter, Razorpay adapter }.
 * Everything outside this package speaks ONLY these types: no Stripe/Razorpay concept
 * (checkout session, order, plan id, invoice) may leak into the rest of the application.
 * The internal subscription row is the single source of truth for entitlements; the
 * client can never grant or extend access (PRD §18.1).
 */

export const BILLING_PROVIDERS = ['STRIPE', 'RAZORPAY'] as const;
export type BillingProvider = (typeof BILLING_PROVIDERS)[number];

export const PLANS = ['FREE', 'PRO', 'TEAM', 'ENTERPRISE'] as const;
export type Plan = (typeof PLANS)[number];
/** Plans a customer can purchase; FREE is the seeded default, never a checkout target. */
export type PurchasablePlan = Exclude<Plan, 'FREE'>;

/** PRD §18.2 — the seven subscription states. */
export const SUBSCRIPTION_STATUSES = ['TRIALING', 'ACTIVE', 'PAST_DUE', 'GRACE_PERIOD', 'CANCELED', 'EXPIRED', 'PAUSED'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/**
 * What a provider says a subscription is, translated into internal vocabulary.
 * Produced by adapter normalizers and consumed by the state machine and reconciliation.
 */
export interface ProviderSubscriptionSnapshot {
  provider: BillingProvider;
  providerSubscriptionId: string;
  /** Null when the event references no customer (e.g. an invoice event with only a subscription id). */
  providerCustomerId: string | null;
  /** Resolved through the configured plan/provider mapping; null when the provider references an unmapped price/plan. */
  plan: Plan | null;
  /** The provider's own plan/price identifier, for the provider mapping column and audits. */
  providerPlanRef: string | null;
  status: SubscriptionStatus;
  currentPeriodEnd: Date | null;
  trialEndsAt: Date | null;
  cancelAtPeriodEnd: boolean;
  currency: string | null;
}

/**
 * The normalized internal event (PRD §18.3). A verified provider webhook collapses to
 * exactly one of these; adapters must not invent semantics the PRD leaves implicit.
 */
export type BillingEventType =
  | 'SUBSCRIPTION_CREATED'
  | 'SUBSCRIPTION_ACTIVATED'
  | 'SUBSCRIPTION_UPDATED'
  | 'SUBSCRIPTION_CANCELED'
  | 'SUBSCRIPTION_PERIOD_ENDED'
  | 'SUBSCRIPTION_PAUSED'
  | 'SUBSCRIPTION_RESUMED'
  | 'PAYMENT_SUCCEEDED'
  | 'PAYMENT_FAILED'
  | 'PAYMENT_RECOVERED'
  | 'DUNNING_STARTED'
  | 'DUNNING_EXHAUSTED'
  | 'REFUND_ISSUED';

export interface BillingEvent {
  provider: BillingProvider;
  /** The provider's event id — the deduplication key (PRD §18.3, threat model). */
  providerEventId: string;
  type: BillingEventType;
  /** When the provider says the thing happened (webhook timestamp window is enforced separately). */
  occurredAt: Date;
  providerSubscriptionId: string | null;
  providerCustomerId: string | null;
  /** The provider's view of the subscription at that moment, when the event carries one. */
  snapshot: ProviderSubscriptionSnapshot | null;
  /** Provider metadata only — never secrets, never task content (PRD §11.4). */
  metadata: Record<string, unknown>;
}

/** Customer identity as known to the app, mapped to a provider customer id by the sync service. */
export interface CheckoutRequest {
  userId: string;
  plan: PurchasablePlan;
  customer: { id: string; email: string; name: string | null };
  successUrl: string;
  cancelUrl: string;
}

/**
 * The two checkout integration patterns that actually exist:
 * a hosted redirect page (Stripe Checkout) or an embedded client-side widget
 * (Razorpay Checkout). The domain name is the pattern, not the vendor.
 */
export type CheckoutResult =
  | { method: 'REDIRECT'; redirectUrl: string; providerSessionId: string }
  | { method: 'EMBEDDED_CHECKOUT'; keyId: string; providerSessionId: string; parameters: Record<string, unknown> };

/**
 * The provider interface the app programs against. Implementations are fetch-based
 * REST clients; none of them is imported by anything except the sync service and
 * the reconciliation job, so provider concepts stay inside this package.
 */
export interface PaymentProvider {
  readonly id: BillingProvider;
  /**
   * True only when a COMPLETE test-mode configuration is present (API key,
   * webhook secret, plan mapping). The app must fail loud (PROVIDER_UNAVAILABLE,
   * 503) when this is false — never silently fall back to a stub.
   */
  isConfigured(): boolean;
  /** Creates (or fetches) the provider customer; returns the provider-side id. */
  createCustomer(input: { userId: string; email: string; name: string | null }): Promise<{ providerCustomerId: string }>;
  /** Starts a paid checkout for one period of `plan` (M1: direct purchase, no trials). */
  createCheckout(input: CheckoutRequest): Promise<CheckoutResult>;
  /**
   * Verifies the webhook signature and the timestamp/replay window.
   * Throws an AppError('UNAUTHENTICATED') on ANY failure — the body is never trusted.
   * @returns the provider-stamped event time (used as the event's occurredAt).
   */
  verifyWebhook(rawBody: string, headers: Record<string, string>): Promise<{ occurredAt: Date }>;
  /**
   * Collapses a verified provider event into the normalized internal event.
   * Returns null for events that carry no subscription meaning (ignored, still acked).
   */
  normalizeEvent(payload: unknown): BillingEvent | null;
  /** Current provider-side subscription view, for the nightly reconciliation job. */
  getSubscription(providerSubscriptionId: string): Promise<ProviderSubscriptionSnapshot>;
}
