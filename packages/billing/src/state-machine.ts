import type { BillingEvent, Plan, SubscriptionStatus } from './types';

/**
 * The internal subscription state machine (PRD §18.2) as pure functions.
 *
 * The PRD transition table is implemented exactly; the few additions are
 * documented, provider-forced, and never grant access the PRD denies:
 * - PAST_DUE -> ACTIVE: a retry succeeds before dunning formally opens (same
 *   "payment recovered" semantic the PRD gives to GRACE_PERIOD -> ACTIVE).
 * - ACTIVE -> GRACE_PERIOD: the provider (Razorpay `halted`) reports dunning
 *   directly; a missed payment-failed event must not strand the sub.
 * - CANCELED -> ACTIVE / EXPIRED -> ACTIVE: a new purchase while the paid
 *   period still runs, or after it ended (the provider re-activates).
 * - PAUSED -> ACTIVE: the resume half of the PRD's "supported pause request".
 * - TRIALING -> CANCELED: cancel during trial (access never started).
 *
 * Product semantics (approved decision B): M1 checkouts create DIRECT PAID
 * subscriptions; TRIALING is modeled and ready, but no M1 flow enters it.
 */

/** PRD §18.3: failed payments enter a grace period — 7 days with full access. */
export const GRACE_PERIOD_DAYS = 7;
export const DAY_MS = 86_400_000;

/** Lower rank = fewer entitlements. FREE exists so the rank is total. */
export const PLAN_RANK: Record<Plan, number> = { FREE: 0, PRO: 1, TEAM: 2, ENTERPRISE: 3 };

/**
 * The mutable, provider-independent subscription state. The database row is
 * this shape plus identity/version columns; `readEffectivePlan()` reads the
 * same fields and remains the single entitlement source of truth (unchanged).
 */
export interface SubscriptionState {
  plan: Plan;
  status: SubscriptionStatus;
  currentPeriodEnd: Date | null;
  trialEndsAt: Date | null;
  cancelAtPeriodEnd: boolean;
  /** When the 7-day full-access grace window (PAST_DUE/GRACE_PERIOD) ends. */
  graceEndsAt: Date | null;
  /**
   * A downgrade awaiting the next billing period (PRD §18.3: "Limits apply at
   * the next billing period"). `plan` keeps the current period's entitlements;
   * `pendingPlan` takes effect at `currentPeriodEnd`.
   */
  pendingPlan: Plan | null;
}

export interface SubscriptionChange {
  field: 'status' | 'plan' | 'pending_plan' | 'current_period_end' | 'trial_ends_at' | 'cancel_at_period_end' | 'grace_ends_at';
  from: string | null;
  to: string | null;
}

export interface ApplyEventResult {
  next: SubscriptionState;
  changed: boolean;
  changes: SubscriptionChange[];
  /** True when the verified event could not advance state (illegal transition, already reflected). */
  skipped: boolean;
  skipReason: string | null;
}

const TRANSITIONS: Record<SubscriptionStatus, readonly SubscriptionStatus[]> = {
  // PRD §18.2 rows: TRIALING->ACTIVE, TRIALING->EXPIRED, ACTIVE->PAST_DUE,
  // PAST_DUE->GRACE_PERIOD, GRACE_PERIOD->ACTIVE, GRACE_PERIOD->EXPIRED,
  // ACTIVE->CANCELED, CANCELED->EXPIRED, ACTIVE->PAUSED — plus the documented
  // provider-forced additions (file header).
  TRIALING: ['ACTIVE', 'EXPIRED', 'CANCELED'],
  ACTIVE: ['PAST_DUE', 'GRACE_PERIOD', 'CANCELED', 'PAUSED'],
  PAST_DUE: ['GRACE_PERIOD', 'ACTIVE', 'EXPIRED'],
  GRACE_PERIOD: ['ACTIVE', 'EXPIRED'],
  CANCELED: ['EXPIRED', 'ACTIVE'],
  PAUSED: ['ACTIVE', 'EXPIRED'],
  EXPIRED: ['ACTIVE', 'TRIALING'],
};

export function canTransition(from: SubscriptionStatus, to: SubscriptionStatus): boolean {
  if (from === to) return true;
  return (TRANSITIONS[from] ?? []).includes(to);
}

function withGrace(now: Date, graceEndsAt: Date | null): Date {
  return graceEndsAt ?? new Date(now.getTime() + GRACE_PERIOD_DAYS * DAY_MS);
}

/**
 * Applies ONE verified, normalized event to a subscription state.
 * Pure: no I/O, no hidden clock (the caller stamps `now` from the verified
 * event time), deterministic — the same inputs always produce the same output,
 * which is what makes version-fenced application and replay safe.
 */
export function applyBillingEvent(state: SubscriptionState, event: BillingEvent, now: Date): ApplyEventResult {
  const snapshot = event.snapshot;
  const changes: SubscriptionChange[] = [];
  const next: SubscriptionState = {
    plan: state.plan,
    status: state.status,
    currentPeriodEnd: state.currentPeriodEnd,
    trialEndsAt: state.trialEndsAt,
    cancelAtPeriodEnd: state.cancelAtPeriodEnd,
    graceEndsAt: state.graceEndsAt,
    pendingPlan: state.pendingPlan,
  };

  const target = targetStatusFor(event);
  if (target !== null && target !== state.status) {
    if (!canTransition(state.status, target)) {
      return {
        next: state,
        changed: false,
        changes: [],
        skipped: true,
        skipReason: `illegal transition ${state.status} -> ${target} (event ${event.type})`,
      };
    }
    next.status = target;
    changes.push({ field: 'status', from: state.status, to: target });
    if (target === 'PAST_DUE') {
      // Grace (dunning) clock starts at the FIRST failed payment: 7 days of full access.
      next.graceEndsAt = new Date(now.getTime() + GRACE_PERIOD_DAYS * DAY_MS);
      changes.push({ field: 'grace_ends_at', from: iso(state.graceEndsAt), to: iso(next.graceEndsAt) });
    } else if (target === 'GRACE_PERIOD') {
      next.graceEndsAt = withGrace(now, state.graceEndsAt);
      if (state.graceEndsAt === null) changes.push({ field: 'grace_ends_at', from: null, to: iso(next.graceEndsAt) });
    } else if (target === 'ACTIVE') {
      next.graceEndsAt = null;
      next.cancelAtPeriodEnd = false;
      if (state.graceEndsAt !== null) changes.push({ field: 'grace_ends_at', from: iso(state.graceEndsAt), to: null });
      if (state.cancelAtPeriodEnd) changes.push({ field: 'cancel_at_period_end', from: 'true', to: 'false' });
    } else if (target === 'CANCELED') {
      next.cancelAtPeriodEnd = snapshot?.cancelAtPeriodEnd ?? true;
      if (state.cancelAtPeriodEnd !== next.cancelAtPeriodEnd) {
        changes.push({ field: 'cancel_at_period_end', from: iso(state.cancelAtPeriodEnd), to: iso(next.cancelAtPeriodEnd) });
      }
    } else if (target === 'EXPIRED') {
      next.graceEndsAt = null;
      next.cancelAtPeriodEnd = false;
      next.trialEndsAt = null;
      next.pendingPlan = null;
      if (state.graceEndsAt !== null) changes.push({ field: 'grace_ends_at', from: iso(state.graceEndsAt), to: null });
      if (state.cancelAtPeriodEnd) changes.push({ field: 'cancel_at_period_end', from: 'true', to: 'false' });
      if (state.trialEndsAt !== null) changes.push({ field: 'trial_ends_at', from: iso(state.trialEndsAt), to: null });
      if (state.pendingPlan !== null) changes.push({ field: 'pending_plan', from: state.pendingPlan, to: null });
    }
  }

  // Field updates from the snapshot — applied on ANY non-skipped event,
  // including same-status ones (renewals move the period end forward).
  if (snapshot) {
    if (snapshot.plan !== null && snapshot.plan !== state.plan) {
      const active = next.status === 'ACTIVE' || next.status === 'PAST_DUE' || next.status === 'GRACE_PERIOD' || next.status === 'PAUSED';
      if (active) {
        if (PLAN_RANK[snapshot.plan] > PLAN_RANK[next.plan]) {
          // Upgrade: entitlements widen immediately (never worse than the PRD allows).
          next.plan = snapshot.plan;
          next.pendingPlan = null;
          changes.push({ field: 'plan', from: state.plan, to: snapshot.plan });
          if (state.pendingPlan !== null) changes.push({ field: 'pending_plan', from: state.pendingPlan, to: null });
        } else {
          // Downgrade: PRD §18.3 — limits apply at the next billing period.
          next.pendingPlan = snapshot.plan;
          changes.push({ field: 'pending_plan', from: iso(state.pendingPlan), to: snapshot.plan });
        }
      }
    }
    if (snapshot.currentPeriodEnd !== null && snapshot.currentPeriodEnd.getTime() !== (state.currentPeriodEnd?.getTime() ?? NaN)) {
      next.currentPeriodEnd = snapshot.currentPeriodEnd;
      changes.push({ field: 'current_period_end', from: iso(state.currentPeriodEnd), to: iso(snapshot.currentPeriodEnd) });
    }
    if (snapshot.trialEndsAt !== null && snapshot.trialEndsAt.getTime() !== (state.trialEndsAt?.getTime() ?? NaN)) {
      next.trialEndsAt = snapshot.trialEndsAt;
      changes.push({ field: 'trial_ends_at', from: iso(state.trialEndsAt), to: iso(snapshot.trialEndsAt) });
    }
    const statusIsCancelling = next.status === 'CANCELED' || next.status === 'EXPIRED';
    if (!statusIsCancelling && snapshot.cancelAtPeriodEnd !== state.cancelAtPeriodEnd) {
      next.cancelAtPeriodEnd = snapshot.cancelAtPeriodEnd;
      changes.push({ field: 'cancel_at_period_end', from: iso(state.cancelAtPeriodEnd), to: iso(snapshot.cancelAtPeriodEnd) });
    }
  }

  return { next, changed: changes.length > 0, changes, skipped: false, skipReason: null };
}

function iso(d: boolean | Date | string | null): string | null {
  if (typeof d === 'boolean') return d ? 'true' : 'false';
  if (typeof d === 'string') return d;
  return d ? d.toISOString() : null;
}

/**
 * The status an event intends, or null when the event never changes status
 * (REFUND_ISSUED: PRD §18.3 — refunds are reflected through webhooks; access
 * is preserved through the paid period, so entitlements are untouched).
 */
function targetStatusFor(event: BillingEvent): SubscriptionStatus | null {
  const snapshot = event.snapshot;
  switch (event.type) {
    case 'PAYMENT_FAILED':
      return 'PAST_DUE';
    case 'DUNNING_STARTED':
      return 'GRACE_PERIOD';
    case 'DUNNING_EXHAUSTED':
      return 'EXPIRED';
    case 'SUBSCRIPTION_CANCELED':
      return 'CANCELED';
    case 'SUBSCRIPTION_PERIOD_ENDED':
      return 'EXPIRED';
    case 'SUBSCRIPTION_PAUSED':
      return 'PAUSED';
    case 'SUBSCRIPTION_RESUMED':
      return 'ACTIVE';
    case 'PAYMENT_SUCCEEDED':
    case 'PAYMENT_RECOVERED':
    case 'SUBSCRIPTION_ACTIVATED':
      return 'ACTIVE';
    case 'SUBSCRIPTION_CREATED':
      return snapshot?.status ?? 'TRIALING';
    case 'SUBSCRIPTION_UPDATED':
      return snapshot?.status ?? null;
    case 'REFUND_ISSUED':
      return null;
  }
}

export interface DeadlineResult {
  changed: boolean;
  next: SubscriptionState;
  /** Machine-readable reasons, e.g. 'dunning_exhausted', 'downgrade_applied'. */
  actions: string[];
}

/**
 * Time-driven transitions the provider does not (or has not yet) webhook:
 * trial end without payment, dunning exhaustion, paid-period end after
 * cancellation, and the next-period swap of a pending downgrade.
 * Pure; the worker sweeps it on a schedule, version-fenced and idempotent.
 */
export function applySubscriptionDeadlines(state: SubscriptionState, now: Date): DeadlineResult {
  const changes: string[] = [];
  const next: SubscriptionState = { ...state };

  if (state.status === 'TRIALING' && state.trialEndsAt && state.trialEndsAt <= now) {
    next.status = 'EXPIRED';
    next.trialEndsAt = null;
    next.pendingPlan = null;
    changes.push('trial_ended_without_payment');
  } else if (state.status === 'PAST_DUE' || state.status === 'GRACE_PERIOD') {
    // readEffectivePlan's 7-day rule is the fallback for rows predating grace_ends_at.
    const deadline = state.graceEndsAt ?? (state.currentPeriodEnd ? new Date(state.currentPeriodEnd.getTime() + GRACE_PERIOD_DAYS * DAY_MS) : null);
    if (deadline && deadline <= now) {
      next.status = 'EXPIRED';
      next.graceEndsAt = null;
      next.cancelAtPeriodEnd = false;
      next.pendingPlan = null;
      changes.push('dunning_exhausted');
    }
  } else if (state.status === 'CANCELED' && (!state.currentPeriodEnd || state.currentPeriodEnd <= now)) {
    // Cancellation preserves access THROUGH the paid period (PRD §18.3).
    next.status = 'EXPIRED';
    next.cancelAtPeriodEnd = false;
    next.graceEndsAt = null;
    next.pendingPlan = null;
    changes.push('paid_period_ended');
  } else if (state.status === 'ACTIVE' && state.pendingPlan !== null && state.currentPeriodEnd && state.currentPeriodEnd <= now) {
    next.plan = state.pendingPlan;
    next.pendingPlan = null;
    changes.push('downgrade_applied');
  }

  return { changed: changes.length > 0, next, actions: changes };
}
