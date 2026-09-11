import type { ProviderSubscriptionSnapshot, SubscriptionStatus } from './types';

/**
 * Provider status vocabulary -> internal SubscriptionStatus (PRD §18.2).
 * The mappings are deliberately conservative: any unknown provider state
 * resolves to EXPIRED (no entitlements) rather than guessing access.
 */

/**
 * Stripe `subscription.status`:
 * - `active` + cancel_at_period_end is the PRD's CANCELED row ("user cancels;
 *   access until period end") — the sub stays provider-active until the end.
 * - `canceled` (immediate cancel, proration) means NO remaining access:
 *   EXPIRED, never CANCELED-with-period (which readEffectivePlan would honour).
 * - `unclosed`/`incomplete`/`incomplete_expired` never became a paying
 *   subscription: EXPIRED.
 */
export function stripeStatusToInternal(
  status: string,
  cancelAtPeriodEnd: boolean,
  currentPeriodEnd: Date | null,
  now: Date,
): SubscriptionStatus {
  switch (status) {
    case 'trialing':
      return 'TRIALING';
    case 'active':
      if (!cancelAtPeriodEnd) return 'ACTIVE';
      return currentPeriodEnd && currentPeriodEnd > now ? 'CANCELED' : 'EXPIRED';
    case 'past_due':
      return 'PAST_DUE';
    case 'paused':
      return 'PAUSED';
    case 'canceled':
    case 'unclosed':
    case 'incomplete':
    case 'incomplete_expired':
    default:
      return 'EXPIRED';
  }
}

/**
 * Razorpay `subscription.status`:
 * - `created`/`active`: a recurring subscription set up and charging.
 * - `halted`: payments failing, dunning in progress — the PRD's GRACE_PERIOD,
 *   but only while the paid period still runs; once it is over the dunning
 *   window cannot extend entitlements (conservative: EXPIRED).
 * - `cancelled`: CANCELED only while the paid period still runs, else EXPIRED.
 */
export function razorpayStatusToInternal(status: string, currentPeriodEnd: Date | null, now: Date): SubscriptionStatus {
  switch (status) {
    case 'created':
    case 'active':
      return 'ACTIVE';
    case 'paused':
      return 'PAUSED';
    case 'halted':
      return currentPeriodEnd && currentPeriodEnd > now ? 'GRACE_PERIOD' : 'EXPIRED';
    case 'cancelled':
      return currentPeriodEnd && currentPeriodEnd > now ? 'CANCELED' : 'EXPIRED';
    case 'completed':
    case 'expired':
    default:
      return 'EXPIRED';
  }
}

/**
 * Builds a snapshot with the identity fields filled and per-event values applied.
 * Adapters use this so the normalized shape stays uniform.
 */
export function buildSnapshot(
  provider: ProviderSubscriptionSnapshot['provider'],
  providerSubscriptionId: string,
  fields: Partial<Omit<ProviderSubscriptionSnapshot, 'provider' | 'providerSubscriptionId'>>,
): ProviderSubscriptionSnapshot {
  return {
    provider,
    providerSubscriptionId,
    providerCustomerId: fields.providerCustomerId ?? null,
    plan: fields.plan ?? null,
    providerPlanRef: fields.providerPlanRef ?? null,
    status: fields.status ?? 'EXPIRED',
    currentPeriodEnd: fields.currentPeriodEnd ?? null,
    trialEndsAt: fields.trialEndsAt ?? null,
    cancelAtPeriodEnd: fields.cancelAtPeriodEnd ?? false,
    currency: fields.currency ?? null,
  };
}

/**
 * Safe extractors for untrusted provider payloads: every field is `unknown`
 * until proven otherwise. These are the ONLY way adapter code reads a value.
 */
export function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Drills a fixed path through nested provider objects, null on any miss. */
export function nested(value: unknown, ...path: string[]): Record<string, unknown> | null {
  let cur: unknown = value;
  for (const key of path) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return null;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur !== null && typeof cur === 'object' && !Array.isArray(cur) ? (cur as Record<string, unknown>) : null;
}

export function toDate(value: number | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const ms = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  // Provider epoch fields are unix SECONDS; accept milliseconds defensively.
  return new Date(ms < 10_000_000_000 ? ms * 1000 : ms);
}
