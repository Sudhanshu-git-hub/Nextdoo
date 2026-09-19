import { describe, expect, it } from 'vitest';
import { compareSubscription, type DriftReport } from './reconcile';
import type { LocalSubscriptionLike } from './reconcile';
import type { ProviderSubscriptionSnapshot } from './types';

/** Hermetic drift-detection coverage for the nightly reconciliation job (PRD §18.3). */

const PERIOD_END = new Date('2026-10-11T12:00:00Z');

function local(over: Partial<LocalSubscriptionLike> = {}): LocalSubscriptionLike {
  return { status: 'ACTIVE', plan: 'PRO', currentPeriodEnd: PERIOD_END, cancelAtPeriodEnd: false, ...over };
}

function snapshot(over: Partial<ProviderSubscriptionSnapshot> = {}): ProviderSubscriptionSnapshot {
  return {
    provider: 'STRIPE',
    providerSubscriptionId: 'sub_1',
    providerCustomerId: 'cus_1',
    plan: 'PRO',
    providerPlanRef: 'price_1',
    status: 'ACTIVE',
    currentPeriodEnd: PERIOD_END,
    trialEndsAt: null,
    cancelAtPeriodEnd: false,
    currency: 'USD',
    ...over,
  };
}

describe('compareSubscription', () => {
  it('reports no drift when local state matches the provider', () => {
    expect(compareSubscription(local(), snapshot())).toBeNull();
    // Canceled-at-period-end is represented on both sides as CANCELED.
    expect(compareSubscription(local({ status: 'CANCELED', cancelAtPeriodEnd: true }), snapshot({ status: 'CANCELED', cancelAtPeriodEnd: true }))).toBeNull();
  });

  it('detects a status drift (provider past_due, local active)', () => {
    const report = compareSubscription(local(), snapshot({ status: 'PAST_DUE' }));
    expect(report).toMatchObject({
      providerSubscriptionId: 'sub_1',
      providerStatus: 'PAST_DUE',
      providerPlan: 'PRO',
      diffs: [{ field: 'status', local: 'ACTIVE', provider: 'PAST_DUE' }],
    });
  });

  it('detects a plan drift and an unmapped provider plan', () => {
    const planDrift = compareSubscription(local(), snapshot({ plan: 'TEAM' }))!;
    expect(planDrift.diffs).toEqual([{ field: 'plan', local: 'PRO', provider: 'TEAM' }]);

    const unmapped = compareSubscription(local(), snapshot({ plan: null, providerPlanRef: 'price_unknown' }))!;
    expect(unmapped.diffs).toEqual([{ field: 'plan', local: 'PRO', provider: null }]);
  });

  it('detects a period-end drift beyond the one-minute tolerance but not within it', () => {
    expect(compareSubscription(local(), snapshot({ currentPeriodEnd: new Date(PERIOD_END.getTime() + 30_000) }))).toBeNull();
    const report = compareSubscription(local(), snapshot({ currentPeriodEnd: new Date(PERIOD_END.getTime() + 3600_000) }));
    expect(report?.diffs.map((d) => d.field)).toEqual(['current_period_end']);
  });

  it('detects a cancel-flag drift', () => {
    const report = compareSubscription(local(), snapshot({ cancelAtPeriodEnd: true }));
    expect(report?.diffs).toEqual([{ field: 'cancel_at_period_end', local: 'false', provider: 'true' }]);
  });

  it('does not drift on a missing provider period end that local also lacks', () => {
    expect(compareSubscription(local({ currentPeriodEnd: null }), snapshot({ currentPeriodEnd: null }))).toBeNull();
  });

  it('keeps the drift report JSON-serializable for audit metadata', () => {
    const report: DriftReport | null = compareSubscription(local({ status: 'PAST_DUE' }), snapshot({ status: 'GRACE_PERIOD' }));
    expect(() => JSON.stringify(report)).not.toThrow();
    expect(report?.provider).toBe('STRIPE');
  });
});
