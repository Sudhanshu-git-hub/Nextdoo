import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { AppError } from '@nextdoo/contracts';
import {
  applyBillingEvent,
  applySubscriptionDeadlines,
  compareSubscription,
  type BillingEvent,
  type BillingProvider,
  type CheckoutResult,
  type DriftReport,
  type PaymentProvider,
  type Plan,
  type PurchasablePlan,
  type SubscriptionState,
  type SubscriptionStatus,
} from '@nextdoo/billing';
import type { Database } from './client';
import { auditLogs, billingEvents, subscriptions, users, workspaces } from './schema';
import { readEffectivePlan } from './effective-plan';

/**
 * Subscription/entitlement synchronization (M6-i3, PRD §18.3).
 *
 * This is the ONLY place provider events touch the subscriptions table:
 * signature-verified, deduplicated, tenant-resolved, version-fenced,
 * audited — and `readEffectivePlan()` (unchanged) remains the single
 * entitlement source of truth that all M1–M6 enforcement already reads.
 *
 * Webhooks are untrusted, potentially duplicated and out of order:
 * - dedup: per-provider (provider, event id) primary key, insert-on-conflict;
 * - tenant isolation: an event only ever resolves through ITS OWN provider's
 *   stored customer/subscription mapping — a Stripe id can never match a
 *   Razorpay row and one user's event can never touch another user's row;
 * - out-of-order: events older than the local event horizon (last_event_at
 *   minus a 60 s provider-clock tolerance) are skipped and audited, never
 *   applied — stale data must not roll state back.
 */

/** Provider clock tolerance for the out-of-order horizon. */
const STALE_EVENT_TOLERANCE_MS = 60_000;
const APPLY_RETRIES = 3;
const BULK_LIMIT = 250;

/** Activation-class events may reference a NEW provider subscription id (re-purchase). */
const ACTIVATION_EVENT_TYPES: ReadonlySet<string> = new Set([
  'SUBSCRIPTION_ACTIVATED',
  'PAYMENT_SUCCEEDED',
  'SUBSCRIPTION_CREATED',
]);

class VersionConflictError extends Error {}

export interface BillingEventInput {
  event: BillingEvent;
  /** The verified raw provider payload, persisted as audit evidence. */
  payload: unknown;
  /** The provider-stamped event time from signature verification. */
  occurredAt: Date;
  requestId?: string | null;
  ipHash?: string | null;
}

export interface BillingEventOutcome {
  /** The provider event id had been seen before (deduped; acked, not re-applied). */
  duplicate: boolean;
  /** True when the event changed the subscription row. */
  applied: boolean;
  /** No local subscription owns this event's customer; persisted + audited, no state change. */
  unresolved: boolean;
  status: SubscriptionStatus | null;
  plan: Plan | null;
  version: number | null;
  skipReason: string | null;
}

function rowToState(row: typeof subscriptions.$inferSelect): SubscriptionState {
  return {
    plan: row.plan,
    status: row.status,
    currentPeriodEnd: row.currentPeriodEnd,
    trialEndsAt: row.trialEndsAt,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    graceEndsAt: row.graceEndsAt,
    pendingPlan: row.pendingPlan,
  };
}

async function workspaceOfOwner(db: { select: Database['select'] }, ownerId: string): Promise<string | null> {
  const [ws] = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.ownerId, ownerId)).limit(1);
  return ws?.id ?? null;
}

async function writeBillingAudit(
  db: { insert: Database['insert'] },
  input: { workspaceId: string | null; actorId: string | null; action: string; targetId: string | null; metadata: Record<string, unknown>; requestId?: string | null; ipHash?: string | null },
): Promise<void> {
  await db.insert(auditLogs).values({
    id: randomUUID(),
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    action: input.action,
    targetType: 'subscription',
    targetId: input.targetId,
    metadata: input.metadata,
    requestId: input.requestId ?? null,
    ipHash: input.ipHash ?? null,
  });
}

/**
 * Applies ONE verified, normalized provider event (PRD §18.3).
 * Idempotent: the same (provider, event id) is applied exactly once.
 */
export async function handleBillingEvent(db: Database, input: BillingEventInput): Promise<BillingEventOutcome> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < APPLY_RETRIES; attempt++) {
    try {
      return await db.transaction(async (tx) => {
        // 1. Persist + dedup on (provider, event id) BEFORE any state change.
        const inserted = await tx
          .insert(billingEvents)
          .values({
            provider: input.event.provider,
            providerEventId: input.event.providerEventId,
            type: input.event.type,
            payload: input.payload as Record<string, unknown>,
          })
          .onConflictDoNothing({ target: [billingEvents.provider, billingEvents.providerEventId] })
          .returning({ providerEventId: billingEvents.providerEventId });
        if (inserted.length === 0) {
          return { duplicate: true, applied: false, unresolved: false, status: null, plan: null, version: null, skipReason: 'duplicate_event' };
        }

        // 2. Tenant resolution: strictly this provider's stored mapping.
        let sub: typeof subscriptions.$inferSelect | undefined;
        if (input.event.providerSubscriptionId) {
          [sub] = await tx
            .select()
            .from(subscriptions)
            .where(and(eq(subscriptions.provider, input.event.provider), eq(subscriptions.providerSubscriptionId, input.event.providerSubscriptionId)))
            .limit(1)
            .for('update');
        }
        if (!sub && input.event.providerCustomerId) {
          [sub] = await tx
            .select()
            .from(subscriptions)
            .where(and(eq(subscriptions.provider, input.event.provider), eq(subscriptions.providerCustomerId, input.event.providerCustomerId)))
            .limit(1)
            .for('update');
        }

        if (!sub) {
          await writeBillingAudit(tx, {
            workspaceId: null,
            actorId: null,
            action: 'billing.event_unresolved',
            targetId: null,
            metadata: {
              provider: input.event.provider,
              event_id: input.event.providerEventId,
              event_type: input.event.type,
              customer: input.event.providerCustomerId,
            },
            requestId: input.requestId,
            ipHash: input.ipHash,
          });
          return { duplicate: false, applied: false, unresolved: true, status: null, plan: null, version: null, skipReason: 'no_local_subscription' };
        }

        const state = rowToState(sub);

        // 3a. An event for a superseded provider subscription (after a
        //     re-purchase) is stale — only activation-class events may move
        //     the row to a new provider subscription id.
        if (
          input.event.providerSubscriptionId &&
          sub.providerSubscriptionId &&
          input.event.providerSubscriptionId !== sub.providerSubscriptionId &&
          !ACTIVATION_EVENT_TYPES.has(input.event.type)
        ) {
          await writeBillingAudit(tx, {
            workspaceId: await workspaceOfOwner(tx, sub.userId),
            actorId: sub.userId,
            action: 'billing.event_skipped',
            targetId: sub.id,
            metadata: { provider: input.event.provider, event_id: input.event.providerEventId, event_type: input.event.type, reason: 'stale_provider_subscription' },
            requestId: input.requestId,
            ipHash: input.ipHash,
          });
          return { duplicate: false, applied: false, unresolved: false, status: state.status, plan: state.plan, version: sub.version, skipReason: 'stale_provider_subscription' };
        }

        // 3b. Out-of-order: older than the local event horizon (with clock
        //     tolerance) — applying it would roll state back on stale data.
        if (sub.lastEventAt && input.event.occurredAt.getTime() < sub.lastEventAt.getTime() - STALE_EVENT_TOLERANCE_MS) {
          await writeBillingAudit(tx, {
            workspaceId: await workspaceOfOwner(tx, sub.userId),
            actorId: sub.userId,
            action: 'billing.event_skipped',
            targetId: sub.id,
            metadata: {
              provider: input.event.provider,
              event_id: input.event.providerEventId,
              event_type: input.event.type,
              reason: 'stale_event',
              event_at: input.event.occurredAt.toISOString(),
              local_at: sub.lastEventAt.toISOString(),
            },
            requestId: input.requestId,
            ipHash: input.ipHash,
          });
          return { duplicate: false, applied: false, unresolved: false, status: state.status, plan: state.plan, version: sub.version, skipReason: 'stale_event' };
        }

        // 4. State machine (pure) — illegal transitions are skipped, audited.
        const result = applyBillingEvent(state, input.event, input.event.occurredAt);

        if (result.skipped) {
          await writeBillingAudit(tx, {
            workspaceId: await workspaceOfOwner(tx, sub.userId),
            actorId: sub.userId,
            action: 'billing.event_skipped',
            targetId: sub.id,
            metadata: { provider: input.event.provider, event_id: input.event.providerEventId, event_type: input.event.type, reason: result.skipReason ?? 'skipped' },
            requestId: input.requestId,
            ipHash: input.ipHash,
          });
          return { duplicate: false, applied: false, unresolved: false, status: state.status, plan: state.plan, version: sub.version, skipReason: result.skipReason };
        }

        // 5. Version-fenced write. The row is FOR UPDATE-locked so this is a
        //    belt-and-braces guard, but a lost update must never happen.
        if (result.changed) {
          const providerSubscriptionId = input.event.providerSubscriptionId ?? sub.providerSubscriptionId;
          const providerCustomerId = input.event.providerCustomerId ?? sub.providerCustomerId;
          const providerPlanRef = input.event.snapshot?.providerPlanRef ?? sub.providerPlanRef;
          const updated = await tx
            .update(subscriptions)
            .set({
              plan: result.next.plan,
              status: result.next.status,
              currentPeriodEnd: result.next.currentPeriodEnd,
              trialEndsAt: result.next.trialEndsAt,
              cancelAtPeriodEnd: result.next.cancelAtPeriodEnd,
              graceEndsAt: result.next.graceEndsAt,
              pendingPlan: result.next.pendingPlan,
              pendingPlanEffectiveAt: result.next.pendingPlan !== null ? result.next.currentPeriodEnd : sub.pendingPlanEffectiveAt,
              providerSubscriptionId,
              providerCustomerId,
              providerPlanRef,
              lastEventAt: input.event.occurredAt,
              updatedAt: new Date(),
              version: sql`${subscriptions.version} + 1`,
            })
            .where(and(eq(subscriptions.id, sub.id), eq(subscriptions.version, sub.version)))
            .returning({ version: subscriptions.version });
          if (updated.length === 0) throw new VersionConflictError();
        }

        // 6. Audit — every resolved event leaves evidence, including
        //    no-state-change events such as refunds.
        await writeBillingAudit(tx, {
          workspaceId: await workspaceOfOwner(tx, sub.userId),
          actorId: sub.userId,
          action: result.changed ? 'billing.subscription_changed' : 'billing.subscription_event',
          targetId: sub.id,
          metadata: {
            provider: input.event.provider,
            event_id: input.event.providerEventId,
            event_type: input.event.type,
            from_status: state.status,
            to_status: result.next.status,
            from_plan: state.plan,
            to_plan: result.next.plan,
            changes: result.changes,
          },
          requestId: input.requestId,
          ipHash: input.ipHash,
        });

        // 7. Link the stored event to its owner for audit/tax queries.
        await tx
          .update(billingEvents)
          .set({ userId: sub.userId })
          .where(and(eq(billingEvents.provider, input.event.provider), eq(billingEvents.providerEventId, input.event.providerEventId)));

        return {
          duplicate: false,
          applied: result.changed,
          unresolved: false,
          status: result.next.status,
          plan: result.next.plan,
          version: result.changed ? sub.version + 1 : sub.version,
          skipReason: null,
        };
      });
    } catch (error) {
      if (error instanceof VersionConflictError && attempt < APPLY_RETRIES - 1) {
        lastError = error;
        continue;
      }
      throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new AppError('INTERNAL_ERROR', 'Something went wrong. Please try again.');
}

export interface CheckoutInput {
  userId: string;
  workspaceId: string;
  plan: PurchasablePlan;
  successUrl: string;
  cancelUrl: string;
  requestId?: string | null;
  ipHash?: string | null;
}

/**
 * Starts a paid checkout (M1: direct purchase, no trials — approved decision B).
 * Fails loud with PROVIDER_UNAVAILABLE when the provider is not fully
 * configured — never a silent stub. The client receives the checkout
 * handoff only; entitlements change exclusively via verified webhooks.
 */
export async function startCheckout(db: Database, provider: PaymentProvider, input: CheckoutInput): Promise<CheckoutResult> {
  if (!provider.isConfigured()) {
    throw new AppError('PROVIDER_UNAVAILABLE', `Billing provider ${provider.id} is not configured. Please try again once billing is enabled.`);
  }
  return db.transaction(async (tx) => {
    const [user] = await tx.select({ id: users.id, email: users.email, name: users.name, deletedAt: users.deletedAt }).from(users).where(eq(users.id, input.userId)).limit(1);
    if (!user || user.deletedAt !== null) throw new AppError('NOT_FOUND', 'The requested user does not exist.', { resource: { type: 'user', id: input.userId } });

    const [sub] = await tx.select().from(subscriptions).where(eq(subscriptions.userId, input.userId)).limit(1).for('update');
    if (!sub) throw new AppError('INTERNAL_ERROR', 'No subscription row for this user; account provisioning is inconsistent.');

    let customerId = sub.providerCustomerId;
    if (customerId !== null && sub.provider !== provider.id) {
      // Cross-provider switching is a support action in M1, never silent.
      throw new AppError('VALIDATION_FAILED', 'This account already has a subscription with a different billing provider. Contact support to switch.');
    }

    if (customerId === null) {
      const created = await provider.createCustomer({ userId: input.userId, email: user.email, name: user.name });
      const updated = await tx
        .update(subscriptions)
        .set({ provider: provider.id, providerCustomerId: created.providerCustomerId, updatedAt: new Date(), version: sql`${subscriptions.version} + 1` })
        .where(and(eq(subscriptions.id, sub.id), eq(subscriptions.version, sub.version)))
        .returning({ version: subscriptions.version });
      if (updated.length === 0) throw new AppError('RESOURCE_VERSION_CONFLICT', 'Your subscription changed while starting checkout. Please retry.');
      customerId = created.providerCustomerId;
    }

    const result = await provider.createCheckout({
      userId: input.userId,
      plan: input.plan,
      customer: { id: customerId, email: user.email, name: user.name },
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
    });

    await writeBillingAudit(tx, {
      workspaceId: input.workspaceId,
      actorId: input.userId,
      action: 'billing.checkout_started',
      targetId: sub.id,
      metadata: { provider: provider.id, plan: input.plan, method: result.method, session: result.providerSessionId },
      requestId: input.requestId,
      ipHash: input.ipHash,
    });

    return result;
  });
}

/**
 * Time-driven transitions (PRD §18.2 rows that are clocks, not webhooks):
 * trial end, dunning exhaustion, paid-period end after cancellation, and the
 * next-period swap of a pending downgrade. Idempotent and version-fenced.
 */
export interface BillingSweepResult {
  checked: number;
  expired: number;
  downgradesApplied: number;
  skipped: number;
}

export async function applyBillingDeadlines(db: Database, now: Date = new Date(), limit = BULK_LIMIT): Promise<BillingSweepResult> {
  const result: BillingSweepResult = { checked: 0, expired: 0, downgradesApplied: 0, skipped: 0 };
  // Raw sql parameters are ISO strings with an explicit cast (house pattern;
  // see reminder-delivery) — the driver must never guess a Date's wire type.
  const instant = now.toISOString();
  const deadlineExpr = sql`coalesce(${subscriptions.graceEndsAt}, ${subscriptions.currentPeriodEnd} + interval '7 days')`;
  const candidates = await db
    .select()
    .from(subscriptions)
    .where(
      or(
        and(eq(subscriptions.status, 'TRIALING'), isNotNull(subscriptions.trialEndsAt), sql`${subscriptions.trialEndsAt} <= ${instant}::timestamptz`),
        and(inArray(subscriptions.status, ['PAST_DUE', 'GRACE_PERIOD']), sql`${deadlineExpr} <= ${instant}::timestamptz`),
        and(eq(subscriptions.status, 'CANCELED'), sql`(${subscriptions.currentPeriodEnd} is null or ${subscriptions.currentPeriodEnd} <= ${instant}::timestamptz)`),
        and(eq(subscriptions.status, 'ACTIVE'), isNotNull(subscriptions.pendingPlan), sql`${subscriptions.currentPeriodEnd} <= ${instant}::timestamptz`),
      ),
    )
    .limit(limit);

  for (const row of candidates) {
    result.checked++;
    try {
      const changed = await db.transaction(async (tx) => {
        const [locked] = await tx.select().from(subscriptions).where(eq(subscriptions.id, row.id)).limit(1).for('update');
        if (!locked || locked.version !== row.version) return false;
        const outcome = applySubscriptionDeadlines(rowToState(locked), now);
        if (!outcome.changed) return false;
        const updated = await tx
          .update(subscriptions)
          .set({
            plan: outcome.next.plan,
            status: outcome.next.status,
            currentPeriodEnd: outcome.next.currentPeriodEnd,
            trialEndsAt: outcome.next.trialEndsAt,
            cancelAtPeriodEnd: outcome.next.cancelAtPeriodEnd,
            graceEndsAt: outcome.next.graceEndsAt,
            pendingPlan: outcome.next.pendingPlan,
            updatedAt: new Date(),
            version: sql`${subscriptions.version} + 1`,
          })
          .where(and(eq(subscriptions.id, locked.id), eq(subscriptions.version, locked.version)))
          .returning({ version: subscriptions.version });
        if (updated.length === 0) return false;
        await writeBillingAudit(tx, {
          workspaceId: await workspaceOfOwner(tx, locked.userId),
          actorId: locked.userId,
          action: 'billing.deadline_swept',
          targetId: locked.id,
          metadata: {
            actions: outcome.actions,
            from_status: locked.status,
            to_status: outcome.next.status,
            from_plan: locked.plan,
            to_plan: outcome.next.plan,
          },
        });
        return true;
      });
      if (!changed) {
        result.skipped++;
        continue;
      }
      // Re-read the row to classify the outcome.
      const [after] = await db.select().from(subscriptions).where(eq(subscriptions.id, row.id)).limit(1);
      if (after?.status === 'EXPIRED') result.expired++;
      else if (after?.pendingPlan === null && after?.plan !== row.plan) result.downgradesApplied++;
    } catch {
      result.skipped++;
    }
  }
  return result;
}

export interface ReconcileOutcome {
  provider: BillingProvider;
  checked: number;
  drifted: DriftReport[];
  unreachable: number;
}

/**
 * Nightly reconciliation (PRD §18.3): compare provider subscription state
 * against local entitlements and ALERT on drift. Drift is audited and
 * returned to the caller (the worker logs it); it is never auto-rewritten —
 * silent self-correction would destroy the audit trail.
 */
export async function reconcileBilling(
  db: Database,
  provider: PaymentProvider,
  now: Date = new Date(),
  /** Optional tenant scoping (the nightly job passes nothing: all users). */
  userId?: string,
): Promise<ReconcileOutcome> {
  if (!provider.isConfigured()) return { provider: provider.id, checked: 0, drifted: [], unreachable: 0 };

  const rows = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.provider, provider.id),
        isNotNull(subscriptions.providerSubscriptionId),
        inArray(subscriptions.status, ['TRIALING', 'ACTIVE', 'PAST_DUE', 'GRACE_PERIOD', 'CANCELED', 'PAUSED']),
        userId ? eq(subscriptions.userId, userId) : undefined,
      ),
    )
    .limit(BULK_LIMIT);

  const outcome: ReconcileOutcome = { provider: provider.id, checked: rows.length, drifted: [], unreachable: 0 };
  for (const row of rows) {
    let snapshot;
    try {
      snapshot = await provider.getSubscription(row.providerSubscriptionId!);
    } catch {
      outcome.unreachable++;
      continue;
    }
    const drift = compareSubscription(row, snapshot);
    if (!drift) continue;
    outcome.drifted.push(drift);
    await db.transaction(async (tx) => {
      await writeBillingAudit(tx, {
        workspaceId: await workspaceOfOwner(tx, row.userId),
        actorId: row.userId,
        action: 'billing.reconciliation_drift',
        targetId: row.id,
        metadata: {
          provider: provider.id,
          subscription_id: row.providerSubscriptionId,
          checked_at: now.toISOString(),
          local_status: row.status,
          provider_status: snapshot.status,
          diffs: drift.diffs,
        },
      });
    });
  }
  return outcome;
}

/** Server-authoritative subscription view for GET /v1/billing/subscription. */
export async function getBillingSubscriptionState(db: Database, userId: string) {
  const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.userId, userId)).limit(1);
  const effectivePlan = await readEffectivePlan(db, userId);
  if (!sub) {
    return {
      plan: 'FREE' as Plan,
      effectivePlan,
      status: 'ACTIVE' as SubscriptionStatus,
      provider: null,
      currentPeriodEnd: null,
      trialEndsAt: null,
      cancelAtPeriodEnd: false,
      graceEndsAt: null,
      pendingPlan: null,
    };
  }
  return {
    plan: sub.plan,
    effectivePlan,
    status: sub.status,
    provider: sub.provider,
    currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
    trialEndsAt: sub.trialEndsAt?.toISOString() ?? null,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    graceEndsAt: sub.graceEndsAt?.toISOString() ?? null,
    pendingPlan: sub.pendingPlan,
  };
}
