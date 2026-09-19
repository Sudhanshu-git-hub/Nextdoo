import type { Plan, ProviderSubscriptionSnapshot, SubscriptionStatus } from './types';

/**
 * Reconciliation (PRD §18.3): "A nightly reconciliation job compares provider
 * subscription state against local entitlements and alerts on drift."
 *
 * The comparison is a pure diff of the internal state against the provider's
 * current snapshot. Drift is REPORTED (audit + worker log), never silently
 * rewritten — silently trusting the provider after the fact would defeat the
 * point of the audit trail.
 */

export interface DriftField {
  field: 'status' | 'plan' | 'current_period_end' | 'cancel_at_period_end';
  local: string | null;
  provider: string | null;
}

export interface DriftReport {
  provider: ProviderSubscriptionSnapshot['provider'];
  providerSubscriptionId: string;
  providerCustomerId: string | null;
  providerStatus: SubscriptionStatus;
  providerPlan: Plan | null;
  diffs: DriftField[];
}

export interface LocalSubscriptionLike {
  status: SubscriptionStatus;
  plan: Plan;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

/** Returns the drift report, or null when local state matches the provider. */
export function compareSubscription(local: LocalSubscriptionLike, snapshot: ProviderSubscriptionSnapshot): DriftReport | null {
  const diffs: DriftField[] = [];

  if (local.status !== snapshot.status) {
    diffs.push({ field: 'status', local: local.status, provider: snapshot.status });
  }

  if (snapshot.plan === null) {
    // The provider references a price/plan the configuration does not know:
    // the local plan cannot be verified either way — that is itself drift.
    diffs.push({ field: 'plan', local: local.plan, provider: null });
  } else if (snapshot.plan !== local.plan) {
    diffs.push({ field: 'plan', local: local.plan, provider: snapshot.plan });
  }

  if (snapshot.currentPeriodEnd === null) {
    // Only drift when local claims a period end the provider cannot confirm.
    if (local.currentPeriodEnd !== null) {
      diffs.push({ field: 'current_period_end', local: local.currentPeriodEnd.toISOString(), provider: null });
    }
  } else if (local.currentPeriodEnd === null || Math.abs(local.currentPeriodEnd.getTime() - snapshot.currentPeriodEnd.getTime()) > 60_000) {
    diffs.push({
      field: 'current_period_end',
      local: local.currentPeriodEnd?.toISOString() ?? null,
      provider: snapshot.currentPeriodEnd.toISOString(),
    });
  }

  if (local.cancelAtPeriodEnd !== snapshot.cancelAtPeriodEnd) {
    diffs.push({ field: 'cancel_at_period_end', local: String(local.cancelAtPeriodEnd), provider: String(snapshot.cancelAtPeriodEnd) });
  }

  if (diffs.length === 0) return null;
  return {
    provider: snapshot.provider,
    providerSubscriptionId: snapshot.providerSubscriptionId,
    providerCustomerId: snapshot.providerCustomerId,
    providerStatus: snapshot.status,
    providerPlan: snapshot.plan,
    diffs,
  };
}
