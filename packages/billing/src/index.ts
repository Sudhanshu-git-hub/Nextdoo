/**
 * @nextdoo/billing — the provider-agnostic billing domain (M6-i3, PRD §18).
 *
 * Layering rule: the app depends on this package, never the other way round.
 * Only the sync service (apps/web) and the reconciliation job (apps/worker)
 * construct adapters; everything else sees the normalized model.
 */

export * from './types';
export * from './plans';
export * from './signature';
export * from './state-machine';
export * from './normalize';
export * from './reconcile';
export * from './config';
export { StripeProvider, type StripeProviderConfig } from './adapters/stripe';
export { RazorpayProvider, type RazorpayProviderConfig } from './adapters/razorpay';
