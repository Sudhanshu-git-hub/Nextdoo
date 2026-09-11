import type { PurchasablePlan } from './types';

/**
 * The plan/provider mapping (M6-i3 product decision, approved):
 * - Stripe prices are USD; Razorpay plans are INR.
 * - Both map onto the same internal plans: PRO, TEAM, ENTERPRISE.
 * The mapping is configuration, not code — prices/plan ids live in the
 * provider's test-mode dashboard and are referenced here by id only.
 */

export interface StripePlanMapping {
  PRO: string;
  TEAM: string;
  ENTERPRISE: string;
}

export interface RazorpayPlanRef {
  /** Recurring plan id (plan_…). */
  id: string;
  /** First-period amount in paise; the Razorpay order for checkout must price the same. */
  amountPaise: number;
}

export interface RazorpayPlanMapping {
  PRO: RazorpayPlanRef;
  TEAM: RazorpayPlanRef;
  ENTERPRISE: RazorpayPlanRef;
}

/** The configured currency per provider (approved decision A). */
export const PROVIDER_CURRENCY: Record<'STRIPE' | 'RAZORPAY', 'USD' | 'INR'> = {
  STRIPE: 'USD',
  RAZORPAY: 'INR',
};

export function planForStripePrice(mapping: StripePlanMapping, priceId: string | null | undefined): PurchasablePlan | null {
  if (!priceId) return null;
  const entry = Object.entries(mapping).find(([, id]) => id === priceId);
  return entry ? (entry[0] as PurchasablePlan) : null;
}

export function planForRazorpayPlan(mapping: RazorpayPlanMapping, planId: string | null | undefined): PurchasablePlan | null {
  if (!planId) return null;
  const entry = Object.entries(mapping).find(([, ref]) => ref.id === planId);
  return entry ? (entry[0] as PurchasablePlan) : null;
}

/** Razorpay fallback: resolve the plan from the charged amount when an event carries no plan id. */
export function planForRazorpayAmount(mapping: RazorpayPlanMapping, amountPaise: number | null | undefined): PurchasablePlan | null {
  if (amountPaise == null) return null;
  const entry = Object.entries(mapping).find(([, ref]) => ref.amountPaise === amountPaise);
  return entry ? (entry[0] as PurchasablePlan) : null;
}

/** The configured reference (id + amount) for an internal plan name. */
export function razorpayPlanForName(mapping: RazorpayPlanMapping, plan: PurchasablePlan): RazorpayPlanRef | null {
  return mapping[plan] ?? null;
}
