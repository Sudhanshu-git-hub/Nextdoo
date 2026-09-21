import { AppError } from '@nextdoo/contracts';
import { buildBillingProviders, type BillingProvider, type BillingProviderSet, type PaymentProvider } from '@nextdoo/billing';
import { getEnv, type Env } from './env';

/**
 * Provider construction for the web process (M6-i3).
 *
 * The app only ever obtains providers through this module; adapters are built
 * once (HMR-safe, like the DB pool) from the validated environment. Nothing
 * outside the billing routes touches a provider object, so Stripe/Razorpay
 * concepts cannot leak into the rest of the application.
 */

const globalForBilling = globalThis as unknown as { __nextdooBilling?: BillingProviderSet };

export function getBillingProviders(): BillingProviderSet {
  if (!globalForBilling.__nextdooBilling) {
    globalForBilling.__nextdooBilling = buildBillingProviders(envSource(getEnv()));
  }
  return globalForBilling.__nextdooBilling;
}

function envSource(env: Env): Record<string, string | undefined> {
  return {
    STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: env.STRIPE_WEBHOOK_SECRET,
    STRIPE_PLANS: env.STRIPE_PLANS,
    RAZORPAY_KEY_ID: env.RAZORPAY_KEY_ID,
    RAZORPAY_KEY_SECRET: env.RAZORPAY_KEY_SECRET,
    RAZORPAY_WEBHOOK_SECRET: env.RAZORPAY_WEBHOOK_SECRET,
    RAZORPAY_PLANS: env.RAZORPAY_PLANS,
  };
}

/**
 * Fail loud: a missing/incomplete provider configuration is a 503
 * PROVIDER_UNAVAILABLE, never a silent stub and never a fallback to the
 * other provider.
 */
export function requireProvider(name: BillingProvider): PaymentProvider {
  const provider = getBillingProviders()[name];
  if (!provider || !provider.isConfigured()) {
    throw new AppError('PROVIDER_UNAVAILABLE', `Billing provider ${name} is not configured. Please try again once billing is enabled.`);
  }
  return provider;
}
