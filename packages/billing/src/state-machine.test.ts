import { describe, expect, it } from 'vitest';
import {
  applyBillingEvent,
  applySubscriptionDeadlines,
  canTransition,
  GRACE_PERIOD_DAYS,
  type SubscriptionState,
} from './state-machine';
import type { BillingEvent, BillingEventType } from './types';

/**
 * Hermetic state-machine coverage (PRD §18.2 transition table + §18.3 rules).
 * No database, no providers, no credentials — pure domain rules.
 */

const DAY = 86_400_000;
const NOW = new Date('2026-09-11T12:00:00Z');

function free(): SubscriptionState {
  return {
    plan: 'FREE',
    status: 'ACTIVE',
    currentPeriodEnd: null,
    trialEndsAt: null,
    cancelAtPeriodEnd: false,
    graceEndsAt: null,
    pendingPlan: null,
  };
}

function paid(plan: SubscriptionState['plan'], over: Partial<SubscriptionState> = {}): SubscriptionState {
  return { ...free(), plan, status: 'ACTIVE', currentPeriodEnd: new Date(NOW.getTime() + 30 * DAY), ...over };
}

let eventSeq = 0;
function event(type: BillingEventType, over: Partial<BillingEvent> = {}): BillingEvent {
  eventSeq += 1;
  return {
    provider: 'STRIPE',
    providerEventId: `evt_test_${eventSeq}`,
    type,
    occurredAt: NOW,
    providerSubscriptionId: null,
    providerCustomerId: null,
    snapshot: null,
    metadata: {},
    ...over,
  };
}

function snapshot(over: Partial<NonNullable<BillingEvent['snapshot']>> = {}) {
  return {
    provider: 'STRIPE' as const,
    providerSubscriptionId: 'sub_1',
    providerCustomerId: 'cus_1',
    plan: 'PRO' as const,
    providerPlanRef: 'price_1',
    status: 'ACTIVE' as const,
    currentPeriodEnd: new Date(NOW.getTime() + 30 * DAY),
    trialEndsAt: null,
    cancelAtPeriodEnd: false,
    currency: 'USD',
    ...over,
  };
}

describe('PRD §18.2 transition table', () => {
  it('allows every transition the PRD specifies', () => {
    const rows: Array<[SubscriptionState['status'], SubscriptionState['status']]> = [
      ['TRIALING', 'ACTIVE'], // successful first payment
      ['TRIALING', 'EXPIRED'], // trial ends without payment
      ['ACTIVE', 'PAST_DUE'], // payment failure
      ['PAST_DUE', 'GRACE_PERIOD'], // dunning window opens
      ['GRACE_PERIOD', 'ACTIVE'], // payment recovered
      ['GRACE_PERIOD', 'EXPIRED'], // dunning exhausted
      ['ACTIVE', 'CANCELED'], // user cancels; access until period end
      ['CANCELED', 'EXPIRED'], // paid period ends
      ['ACTIVE', 'PAUSED'], // supported pause request
    ];
    for (const [from, to] of rows) expect(canTransition(from, to), `${from} -> ${to}`).toBe(true);
  });

  it('rejects transitions that would grant unearned access', () => {
    expect(canTransition('EXPIRED', 'GRACE_PERIOD')).toBe(false);
    expect(canTransition('CANCELED', 'GRACE_PERIOD')).toBe(false);
    expect(canTransition('EXPIRED', 'PAST_DUE')).toBe(false);
    expect(canTransition('PAUSED', 'PAST_DUE')).toBe(false);
    expect(canTransition('TRIALING', 'PAUSED')).toBe(false);
    expect(canTransition('ACTIVE', 'EXPIRED')).toBe(false); // an active sub's period rolls, it does not expire
    expect(canTransition('CANCELED', 'CANCELED')).toBe(true); // same-state is a field-update no-op, not a transition
  });

  it('payment failure enters PAST_DUE with a 7-day full-access grace clock (PRD §18.3)', () => {
    const start = paid('PRO');
    const result = applyBillingEvent(start, event('PAYMENT_FAILED'), NOW);
    expect(result.skipped).toBe(false);
    expect(result.next.status).toBe('PAST_DUE');
    expect(result.next.graceEndsAt?.getTime()).toBe(NOW.getTime() + GRACE_PERIOD_DAYS * DAY);
    expect(result.changes.map((c) => c.field)).toEqual(['status', 'grace_ends_at']);
  });

  it('a recovered payment clears the grace clock (PAST_DUE -> ACTIVE)', () => {
    const start = paid('PRO', { status: 'PAST_DUE', graceEndsAt: new Date(NOW.getTime() + DAY) });
    const result = applyBillingEvent(start, event('PAYMENT_SUCCEEDED', { snapshot: snapshot({ currentPeriodEnd: new Date(NOW.getTime() + 60 * DAY) }) }), NOW);
    expect(result.next.status).toBe('ACTIVE');
    expect(result.next.graceEndsAt).toBeNull();
    expect(result.next.currentPeriodEnd?.getTime()).toBe(NOW.getTime() + 60 * DAY);
  });

  it('dunning can open directly from ACTIVE when the provider reports it (Razorpay halted)', () => {
    const start = paid('PRO');
    const result = applyBillingEvent(start, event('DUNNING_STARTED', { snapshot: snapshot({ status: 'GRACE_PERIOD' }) }), NOW);
    expect(result.next.status).toBe('GRACE_PERIOD');
    expect(result.next.graceEndsAt?.getTime()).toBe(NOW.getTime() + GRACE_PERIOD_DAYS * DAY);
  });

  it('user cancellation keeps access until the paid period ends', () => {
    const start = paid('PRO');
    const result = applyBillingEvent(start, event('SUBSCRIPTION_CANCELED', { snapshot: snapshot({ status: 'CANCELED', cancelAtPeriodEnd: true }) }), NOW);
    expect(result.next.status).toBe('CANCELED');
    expect(result.next.cancelAtPeriodEnd).toBe(true);
    expect(result.next.currentPeriodEnd?.getTime()).toBe(NOW.getTime() + 30 * DAY);
  });

  it('cancellation of a trialing subscription never granted access', () => {
    const start = { ...paid('PRO', { status: 'TRIALING', trialEndsAt: new Date(NOW.getTime() + 14 * DAY) }) };
    const result = applyBillingEvent(start, event('SUBSCRIPTION_CANCELED', { snapshot: snapshot({ status: 'CANCELED' }) }), NOW);
    expect(result.next.status).toBe('CANCELED');
  });

  it('a new purchase during the paid period re-activates (CANCELED -> ACTIVE)', () => {
    const start = paid('PRO', { status: 'CANCELED', cancelAtPeriodEnd: true });
    const result = applyBillingEvent(start, event('SUBSCRIPTION_ACTIVATED', { snapshot: snapshot({ status: 'ACTIVE', plan: 'PRO' }) }), NOW);
    expect(result.next.status).toBe('ACTIVE');
    expect(result.next.cancelAtPeriodEnd).toBe(false);
  });
});

describe('plan changes (PRD §18.3: limits apply at the next billing period)', () => {
  it('upgrade applies immediately', () => {
    const start = paid('PRO');
    const result = applyBillingEvent(start, event('SUBSCRIPTION_UPDATED', { snapshot: snapshot({ plan: 'TEAM' }) }), NOW);
    expect(result.next.plan).toBe('TEAM');
    expect(result.next.pendingPlan).toBeNull();
    expect(result.changes.some((c) => c.field === 'plan' && c.to === 'TEAM')).toBe(true);
  });

  it('downgrade defers to the next billing period', () => {
    const start = paid('TEAM');
    const result = applyBillingEvent(start, event('SUBSCRIPTION_UPDATED', { snapshot: snapshot({ plan: 'PRO' }) }), NOW);
    expect(result.next.plan).toBe('TEAM'); // current period keeps its entitlements
    expect(result.next.pendingPlan).toBe('PRO');
  });

  it('an upgrade cancels a pending downgrade', () => {
    const start = paid('TEAM', { pendingPlan: 'PRO' });
    const result = applyBillingEvent(start, event('SUBSCRIPTION_UPDATED', { snapshot: snapshot({ plan: 'ENTERPRISE' }) }), NOW);
    expect(result.next.plan).toBe('ENTERPRISE');
    expect(result.next.pendingPlan).toBeNull();
  });

  it('does not queue plan changes for a subscription that is ending', () => {
    const start = paid('TEAM', { status: 'CANCELED', cancelAtPeriodEnd: true });
    const result = applyBillingEvent(start, event('SUBSCRIPTION_UPDATED', { snapshot: snapshot({ status: 'CANCELED', plan: 'PRO' }) }), NOW);
    expect(result.next.pendingPlan).toBeNull();
  });
});

describe('out-of-order and duplicate tolerance', () => {
  it('skips an illegal transition instead of corrupting state', () => {
    const start = paid('PRO');
    const result = applyBillingEvent(start, event('SUBSCRIPTION_PERIOD_ENDED', { snapshot: snapshot({ status: 'EXPIRED' }) }), NOW);
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toMatch(/illegal transition ACTIVE -> EXPIRED/);
    expect(result.changed).toBe(false);
    expect(result.next).toBe(start);
  });

  it('applies a same-status renewal without a status change', () => {
    const start = paid('PRO', { currentPeriodEnd: new Date(NOW.getTime() + 1 * DAY) });
    const result = applyBillingEvent(start, event('PAYMENT_SUCCEEDED', { snapshot: snapshot({ currentPeriodEnd: new Date(NOW.getTime() + 31 * DAY) }) }), NOW);
    expect(result.skipped).toBe(false);
    expect(result.next.status).toBe('ACTIVE');
    expect(result.next.currentPeriodEnd?.getTime()).toBe(NOW.getTime() + 31 * DAY);
    expect(result.changes.map((c) => c.field)).toEqual(['current_period_end']);
  });

  it('records a refund without touching status or plan (PRD §18.3)', () => {
    const start = paid('PRO');
    const result = applyBillingEvent(start, event('REFUND_ISSUED'), NOW);
    expect(result.skipped).toBe(false);
    expect(result.changed).toBe(false);
    expect(result.next.status).toBe('ACTIVE');
    expect(result.next.plan).toBe('PRO');
  });
});

describe('TRIALING is modeled and ready (approved decision B: M1 checkouts are direct paid)', () => {
  it('trial end without payment expires; first payment activates', () => {
    const trial = { ...free(), status: 'TRIALING' as const, trialEndsAt: new Date(NOW.getTime() + 14 * DAY) };
    const activated = applyBillingEvent(trial, event('SUBSCRIPTION_ACTIVATED', { snapshot: snapshot({ status: 'ACTIVE' }) }), NOW);
    expect(activated.next.status).toBe('ACTIVE');

    const expired = applySubscriptionDeadlines(
      { ...trial, trialEndsAt: new Date(NOW.getTime() - DAY) },
      NOW,
    );
    expect(expired.changed).toBe(true);
    expect(expired.next.status).toBe('EXPIRED');
    expect(expired.actions).toEqual(['trial_ended_without_payment']);
  });
});

describe('deadline sweep (worker-side time transitions)', () => {
  it('dunning exhaustion expires after the 7-day window', () => {
    const state = paid('PRO', { status: 'PAST_DUE', graceEndsAt: new Date(NOW.getTime() + DAY) });
    const early = applySubscriptionDeadlines(state, NOW);
    expect(early.changed).toBe(false);
    const late = applySubscriptionDeadlines(state, new Date(NOW.getTime() + 2 * DAY));
    expect(late.changed).toBe(true);
    expect(late.next.status).toBe('EXPIRED');
    expect(late.actions).toEqual(['dunning_exhausted']);
  });

  it('legacy PAST_DUE rows without a grace clock fall back to period end + 7 days', () => {
    const state = paid('PRO', { status: 'PAST_DUE', graceEndsAt: null, currentPeriodEnd: new Date(NOW.getTime() - DAY) });
    const result = applySubscriptionDeadlines(state, new Date(NOW.getTime() + 8 * DAY));
    expect(result.next.status).toBe('EXPIRED');
  });

  it('a canceled subscription expires only when the paid period ends', () => {
    const state = paid('PRO', { status: 'CANCELED', cancelAtPeriodEnd: true, currentPeriodEnd: new Date(NOW.getTime() + 30 * DAY) });
    expect(applySubscriptionDeadlines(state, NOW).changed).toBe(false);
    const later = applySubscriptionDeadlines(state, new Date(NOW.getTime() + 31 * DAY));
    expect(later.next.status).toBe('EXPIRED');
    expect(later.actions).toEqual(['paid_period_ended']);
  });

  it('a pending downgrade swaps at the period boundary', () => {
    const state = paid('TEAM', { pendingPlan: 'PRO', currentPeriodEnd: new Date(NOW.getTime() + 1 * DAY) });
    expect(applySubscriptionDeadlines(state, NOW).changed).toBe(false);
    const atBoundary = applySubscriptionDeadlines(state, new Date(NOW.getTime() + 1 * DAY));
    expect(atBoundary.next.plan).toBe('PRO');
    expect(atBoundary.next.pendingPlan).toBeNull();
    expect(atBoundary.actions).toEqual(['downgrade_applied']);
  });

  it('an expired subscription is a fixed point', () => {
    const state = paid('PRO', { status: 'EXPIRED', graceEndsAt: null, cancelAtPeriodEnd: false, currentPeriodEnd: new Date(NOW.getTime() - DAY) });
    const result = applySubscriptionDeadlines(state, NOW);
    expect(result.changed).toBe(false);
    expect(result.next.status).toBe('EXPIRED');
  });
});
