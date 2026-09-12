import { z } from 'zod';
import { RazorpayProvider } from './adapters/razorpay';
import { StripeProvider } from './adapters/stripe';
import type { RazorpayPlanMapping, StripePlanMapping } from './plans';

/**
 * Configuration -> provider instances.
 *
 * A provider is "configured" ONLY when the complete test-mode configuration
 * is present (API key, webhook secret, and all three plan mappings). Partial
 * configuration returns null: the app then fails loud with
 * PROVIDER_UNAVAILABLE (503) instead of half-working. Present-but-malformed
 * plan configuration is an operator error and throws at startup.
 */

export type EnvSource = Record<string, string | undefined>;

export interface BillingProviderSet {
  STRIPE: StripeProvider | null;
  RAZORPAY: RazorpayProvider | null;
}

const stripePlansSchema = z.object({
  PRO: z.string().min(1),
  TEAM: z.string().min(1),
  ENTERPRISE: z.string().min(1),
});

const razorpayPlanSchema = z.object({
  id: z.string().min(1),
  amountPaise: z.number().int().positive(),
});

const razorpayPlansSchema = z.object({
  PRO: razorpayPlanSchema,
  TEAM: razorpayPlanSchema,
  ENTERPRISE: razorpayPlanSchema,
});

function parsePlans<T>(raw: string | undefined, schema: z.ZodType<T>, provider: string): T | null {
  if (raw === undefined || raw === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid billing configuration: ${provider} plan mapping is not valid JSON.`);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid billing configuration: ${provider} plan mapping must configure PRO, TEAM and ENTERPRISE.`);
  }
  return result.data;
}

export function buildStripeProvider(env: EnvSource, fetchImpl: typeof fetch = fetch): StripeProvider | null {
  const secretKey = env.STRIPE_SECRET_KEY;
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
  if (!secretKey || !webhookSecret) return null;
  const plans = parsePlans<StripePlanMapping>(env.STRIPE_PLANS, stripePlansSchema, 'Stripe (STRIPE_PLANS)');
  if (!plans) return null;
  return StripeProvider.create({ secretKey, webhookSecret, plans }, fetchImpl);
}

export function buildRazorpayProvider(env: EnvSource, fetchImpl: typeof fetch = fetch): RazorpayProvider | null {
  const keyId = env.RAZORPAY_KEY_ID;
  const keySecret = env.RAZORPAY_KEY_SECRET;
  const webhookSecret = env.RAZORPAY_WEBHOOK_SECRET;
  if (!keyId || !keySecret || !webhookSecret) return null;
  const plans = parsePlans<RazorpayPlanMapping>(env.RAZORPAY_PLANS, razorpayPlansSchema, 'Razorpay (RAZORPAY_PLANS)');
  if (!plans) return null;
  return RazorpayProvider.create({ keyId, keySecret, webhookSecret, plans }, fetchImpl);
}

/**
 * The provider set for a process. Both nulls is a legitimate (and common)
 * state: billing is simply not enabled yet and every billing mutation
 * answers 503 PROVIDER_UNAVAILABLE.
 */
export function buildBillingProviders(env: EnvSource, fetchImpl: typeof fetch = fetch): BillingProviderSet {
  return {
    STRIPE: buildStripeProvider(env, fetchImpl),
    RAZORPAY: buildRazorpayProvider(env, fetchImpl),
  };
}
