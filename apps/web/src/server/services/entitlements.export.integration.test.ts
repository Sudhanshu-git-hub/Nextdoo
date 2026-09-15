import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { count, eq, isNull, and } from 'drizzle-orm';
import { AppError, limitsFor } from '@nextdoo/contracts';
import {
  auditLogs,
  exports,
  notifications,
  projects,
  subscriptions,
  tasks,
} from '@nextdoo/db';
import { requireTestDatabase } from '../../../../../tests/database';
import { getDb, withTransaction } from '../db';
import type { AuthContext } from '../auth';
import { getPlan, registerUser } from './accounts';
import { completeTask, createTask } from './tasks';
import { createProject } from './projects';
import { assertHistoryWindow, getEntitlementSnapshot } from './entitlements';
import { buildExport, listAuditLogs } from './data-rights';
import { requestExport } from './exports';

/**
 * M6 commercial-readiness regression (PRD §18.1 "exact limits must be
 * configured server-side and exposed through an entitlement endpoint"):
 *
 * - the entitlement snapshot reflects configured limits and live usage, and
 *   re-evaluates on every mutation after a plan change (upgrade and downgrade);
 * - Free active-task cap boundary (200/201) and slot release;
 * - Free project cap boundary (3/4), existing rows preserved across downgrade;
 * - Free historical-analytics window (30 workspace-local days) including the
 *   workspace time-zone boundary; paid plans see full history;
 * - plan-based audit-log retention (None / 30 days / 1 year / 7 years) as a
 *   visible-history window, with the actor boundary intact;
 * - export plan quota failure leaves no row;
 * - the credential-free account export is complete for the owner, tenant
 *   isolated, and scrubs notifications that reference foreign tasks.
 *
 * Async export generation, download authorisation, idempotent replay, retries
 * and tenant scoping are already covered by export-workflow.integration.test.ts
 * and e2e/exports.spec.ts; the calendar-connection cap and
 * suspend-on-downgrade by calendar-connections.integration.test.ts. This file
 * covers the entitlement-side boundaries those suites do not.
 */

await requireTestDatabase();

interface Fixture { actor: AuthContext; userId: string; workspaceId: string; email: string }

async function fixture(timeZone = 'UTC'): Promise<Fixture> {
  const email = `entitlements-${randomUUID()}@test.local`;
  const user = await registerUser({ email, passwordHash: 'test', name: null, timeZone });
  const actor: AuthContext = {
    userId: user.id,
    workspaceId: user.workspaceId,
    sessionId: `integration-${user.id}`,
    email: user.email,
    emailVerified: true,
    timeZone,
  };
  return { actor, userId: user.id, workspaceId: user.workspaceId, email };
}

async function setPlan(userId: string, plan: 'FREE' | 'PRO' | 'TEAM' | 'ENTERPRISE') {
  await withTransaction(async (db) => {
    await db
      .update(subscriptions)
      .set({ plan, status: 'ACTIVE', currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000) })
      .where(eq(subscriptions.userId, userId));
  });
}

async function insertActiveTasks(workspaceId: string, n: number): Promise<string[]> {
  const ids = Array.from({ length: n }, () => randomUUID());
  await getDb().insert(tasks).values(ids.map((id, i) => ({ id, workspaceId, title: `Bulk task ${i + 1}` })));
  return ids;
}

/** Local calendar date (YYYY-MM-DD) of `n` days before now, in the zone. */
function localDateDaysAgo(n: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(Date.now() - n * 86_400_000),
  );
}

function isEntitlementLimit(error: unknown): boolean {
  return error instanceof AppError && error.code === 'ENTITLEMENT_LIMIT_REACHED';
}

it('the entitlement snapshot exposes configured limits, live usage, and re-evaluates on plan change', async () => {
  const fx = await fixture();
  const free = await getEntitlementSnapshot(fx.userId, fx.workspaceId);
  expect(free.plan).toBe('FREE');
  expect(free.limits).toEqual(limitsFor('FREE'));
  expect(free.limits.activeTasks).toBe(200);
  expect(free.limits.trackingHistoryDays).toBe(30);
  expect(free.limits.exportsPerDay).toBe(1);
  expect(free.limits.auditLogRetentionDays).toBe(0);
  expect(free.usage).toEqual({ activeTasks: 0, projects: 0, calendarConnections: 0 });

  await createTask(fx.actor, { workspaceId: fx.workspaceId, title: 'Snapshot task', priority: 'NONE', tagIds: [] });
  await createProject(fx.actor, { name: 'Snapshot project' });
  const after = await getEntitlementSnapshot(fx.userId, fx.workspaceId);
  expect(after.usage).toEqual({ activeTasks: 1, projects: 1, calendarConnections: 0 });

  await setPlan(fx.userId, 'PRO');
  const pro = await getEntitlementSnapshot(fx.userId, fx.workspaceId);
  expect(pro.plan).toBe('PRO');
  expect(pro.limits.activeTasks).toBeNull();
  expect(pro.limits.trackingHistoryDays).toBeNull();
  expect(pro.limits.auditLogRetentionDays).toBe(30);
  // Usage counts are plan-independent and survive the change.
  expect(pro.usage).toEqual({ activeTasks: 1, projects: 1, calendarConnections: 0 });
});

it('the free plan blocks the 201st active task and freeing a slot unblocks creation', async () => {
  const fx = await fixture();
  const ids = await insertActiveTasks(fx.workspaceId, 200);

  await expect(
    createTask(fx.actor, { workspaceId: fx.workspaceId, title: 'The 201st task', priority: 'NONE', tagIds: [] }),
  ).rejects.toSatisfy(isEntitlementLimit);

  // The rejection must not have persisted a task.
  const db = getDb();
  const [row] = await db.select({ n: count() }).from(tasks).where(and(eq(tasks.workspaceId, fx.workspaceId), isNull(tasks.deletedAt)));
  expect(row?.n).toBe(200);

  // Completing one task frees exactly one slot; the next create succeeds.
  await completeTask(fx.actor, ids[0]!, 1);
  const created = await createTask(fx.actor, { workspaceId: fx.workspaceId, title: 'Fits after completion', priority: 'NONE', tagIds: [] });
  expect(created.id).toBeTruthy();
  const [after] = await db.select({ n: count() }).from(tasks).where(and(eq(tasks.workspaceId, fx.workspaceId), eq(tasks.status, 'ACTIVE'), isNull(tasks.deletedAt)));
  expect(after?.n).toBe(200);
});

it('plan changes re-evaluate the task cap on the very next mutation, both directions', async () => {
  const fx = await fixture();
  await insertActiveTasks(fx.workspaceId, 200);

  // Free at the cap: blocked.
  await expect(
    createTask(fx.actor, { workspaceId: fx.workspaceId, title: 'Blocked at cap', priority: 'NONE', tagIds: [] }),
  ).rejects.toSatisfy(isEntitlementLimit);

  // Upgrade: the next mutation succeeds (no re-scan needed, cap is null).
  await setPlan(fx.userId, 'PRO');
  const up = await createTask(fx.actor, { workspaceId: fx.workspaceId, title: 'Allowed after upgrade', priority: 'NONE', tagIds: [] });
  expect(up.id).toBeTruthy();

  // Downgrade: the same mutation is blocked again, and existing rows are
  // never deleted or mutated — the user must bring the count down themselves.
  await setPlan(fx.userId, 'FREE');
  await expect(
    createTask(fx.actor, { workspaceId: fx.workspaceId, title: 'Blocked after downgrade', priority: 'NONE', tagIds: [] }),
  ).rejects.toSatisfy(isEntitlementLimit);
  const db = getDb();
  const [row] = await db.select({ n: count() }).from(tasks).where(and(eq(tasks.workspaceId, fx.workspaceId), isNull(tasks.deletedAt)));
  expect(row?.n).toBe(201);
});

it('the free plan allows exactly three projects, and downgrade preserves existing ones', async () => {
  const fx = await fixture();
  for (let i = 1; i <= 3; i += 1) {
    const project = await createProject(fx.actor, { name: `Free project ${i}` });
    expect(project.id).toBeTruthy();
  }
  await expect(createProject(fx.actor, { name: 'Fourth free project' })).rejects.toSatisfy(isEntitlementLimit);

  const db = getDb();
  const [row] = await db.select({ n: count() }).from(projects).where(and(eq(projects.workspaceId, fx.workspaceId), eq(projects.status, 'ACTIVE'), isNull(projects.deletedAt)));
  expect(row?.n).toBe(3);

  // A paid account may exceed three; after downgrade the existing rows stay.
  await setPlan(fx.userId, 'PRO');
  const fourth = await createProject(fx.actor, { name: 'Fourth after upgrade' });
  expect(fourth.id).toBeTruthy();
  await setPlan(fx.userId, 'FREE');
  await expect(createProject(fx.actor, { name: 'Fifth on free' })).rejects.toSatisfy(isEntitlementLimit);
  const [after] = await db.select({ n: count() }).from(projects).where(and(eq(projects.workspaceId, fx.workspaceId), eq(projects.status, 'ACTIVE'), isNull(projects.deletedAt)));
  expect(after?.n).toBe(4);
});

it('free historical analytics are bounded to the last 30 workspace-local days', async () => {
  const fx = await fixture();

  // Within the window (including today) resolves.
  await expect(assertHistoryWindow(fx.userId, fx.workspaceId, null)).resolves.toBeUndefined();
  await expect(assertHistoryWindow(fx.userId, fx.workspaceId, localDateDaysAgo(0, 'UTC'))).resolves.toBeUndefined();
  await expect(assertHistoryWindow(fx.userId, fx.workspaceId, localDateDaysAgo(29, 'UTC'))).resolves.toBeUndefined();
  // The 30th day is the boundary: still included.
  await expect(assertHistoryWindow(fx.userId, fx.workspaceId, localDateDaysAgo(30, 'UTC'))).resolves.toBeUndefined();
  // The 31st day crosses the boundary: refused, no data.
  await expect(assertHistoryWindow(fx.userId, fx.workspaceId, localDateDaysAgo(31, 'UTC'))).rejects.toSatisfy(isEntitlementLimit);
});

it('the history window boundary follows the workspace time zone, not UTC', async () => {
  // Pacific/Kiritimati (UTC+14): the local calendar date can differ from the
  // UTC calendar date, and the 30-day boundary must be computed locally.
  const fx = await fixture('Pacific/Kiritimati');
  const tz = 'Pacific/Kiritimati';
  await expect(assertHistoryWindow(fx.userId, fx.workspaceId, localDateDaysAgo(30, tz))).resolves.toBeUndefined();
  await expect(assertHistoryWindow(fx.userId, fx.workspaceId, localDateDaysAgo(31, tz))).rejects.toSatisfy(isEntitlementLimit);
});

it('paid plans see the full historical window', async () => {
  const fx = await fixture();
  await setPlan(fx.userId, 'PRO');
  await expect(assertHistoryWindow(fx.userId, fx.workspaceId, localDateDaysAgo(31, 'UTC'))).resolves.toBeUndefined();
  await expect(assertHistoryWindow(fx.userId, fx.workspaceId, localDateDaysAgo(400, 'UTC'))).resolves.toBeUndefined();
});

it('audit history visibility follows the plan retention window while the actor boundary holds', async () => {
  const fx = await fixture();
  const other = await fixture();
  const db = getDb();
  const makeId = () => randomUUID();
  const age = (days: number) => new Date(Date.now() - days * 86_400_000);
  // A 10-day-old, a 40-day-old, and a 400-day-old event for the account owner,
  // plus one 10-day-old event by a different account (same DB, different actor).
  for (const days of [10, 40, 400]) {
    await db.insert(auditLogs).values({
      id: makeId(), workspaceId: fx.workspaceId, actorId: fx.userId,
      action: 'task.updated', targetType: 'task', targetId: makeId(), createdAt: age(days),
    });
  }
  await db.insert(auditLogs).values({
    id: makeId(), workspaceId: other.workspaceId, actorId: other.userId,
    action: 'account.password_changed', targetType: 'user', targetId: other.userId, createdAt: age(10),
  });

  const listFor = async (userId: string, workspaceId: string): Promise<number> => {
    // Same resolution the /api/v1/audit-logs route applies. Count only the
    // seeded `task.updated` rows — registration writes its own current-time
    // `account.created` event, which is legitimately inside short windows.
    const retentionDays = limitsFor(await getPlan(userId)).auditLogRetentionDays;
    const rows = await listAuditLogs(userId, workspaceId, 200, undefined, retentionDays);
    return rows.filter((r) => r.action === 'task.updated').length;
  };

  await setPlan(fx.userId, 'FREE');
  expect(await listFor(fx.userId, fx.workspaceId)).toBe(0); // Free retains nothing.

  await setPlan(fx.userId, 'PRO');
  expect(await listFor(fx.userId, fx.workspaceId)).toBe(1); // Only the 10-day row.

  await setPlan(fx.userId, 'TEAM');
  expect(await listFor(fx.userId, fx.workspaceId)).toBe(2); // 10 + 40 days.

  await setPlan(fx.userId, 'ENTERPRISE');
  expect(await listFor(fx.userId, fx.workspaceId)).toBe(3); // All three.

  // The actor boundary holds even at 7-year retention: `other` sees only
  // their own account events (the seeded one plus their registration event),
  // never `fx`'s, and `fx` never sees `other`'s seeded event.
  await setPlan(other.userId, 'ENTERPRISE');
  const otherRows = await listAuditLogs(other.userId, other.workspaceId, 200, undefined, 2555);
  expect(otherRows.every((r) => r.action.startsWith('account.'))).toBe(true);
  expect(otherRows.some((r) => r.action === 'account.password_changed')).toBe(true);
  const mine = await listAuditLogs(fx.userId, fx.workspaceId, 200, undefined, 2555);
  expect(mine.some((r) => r.action === 'account.password_changed')).toBe(false);
  expect(mine.some((r) => r.targetId === other.userId)).toBe(false);
});

it('a rejected export request leaves no row and does not extend the day', async () => {
  const fx = await fixture();
  const db = getDb();

  const first = await requestExport(fx.actor, { format: 'json', requestId: randomUUID() });
  expect(first.id).toBeTruthy();

  // Second request the same day: plan limit. The rejection must not create a row.
  await expect(requestExport(fx.actor, { format: 'csv', requestId: randomUUID() })).rejects.toSatisfy(isEntitlementLimit);
  const [row] = await db.select({ n: count() }).from(exports).where(eq(exports.userId, fx.userId));
  expect(row?.n).toBe(1);
});

it('the account export is complete for the owner and isolated from other tenants', async () => {
  const a = await fixture();
  const b = await fixture();
  const db = getDb();

  await createProject(a.actor, { name: 'Owner project' });
  const ownerTask = await createTask(a.actor, { workspaceId: a.workspaceId, title: 'Owner export task', priority: 'HIGH', tagIds: [] });
  await createTask(b.actor, { workspaceId: b.workspaceId, title: 'Foreign export task', priority: 'HIGH', tagIds: [] });

  const bundle = await buildExport(a.userId);
  expect(bundle.formatVersion).toBe(1);
  expect(bundle.account.email).toBe(a.email);

  const taskRows = bundle.tasks as Array<{ id: string; title: string; workspaceId: string }>;
  expect(taskRows.some((t) => t.id === ownerTask.id && t.title === 'Owner export task')).toBe(true);
  // No foreign workspace, task, or project anywhere in the bundle.
  for (const list of [bundle.workspaces, bundle.tasks, bundle.projects, bundle.reminders, bundle.trackingEvents, bundle.trackingResults]) {
    const rows = list as Array<{ workspaceId?: string | null }>;
    expect(rows.some((r) => r.workspaceId === b.workspaceId)).toBe(false);
  }
  const [foreign] = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.title, 'Foreign export task'));
  expect(foreign?.id).toBeTruthy();
  expect((bundle.tasks as Array<{ id: string }>).some((t) => t.id === foreign?.id)).toBe(false);
  expect((bundle.auditLogs as Array<{ actorId?: string | null }>).some((r) => r.actorId === b.userId)).toBe(false);

  // The export itself is audited for the owner.
  const [audit] = await db.select({ action: auditLogs.action }).from(auditLogs).where(and(eq(auditLogs.actorId, a.userId), eq(auditLogs.action, 'account.exported')));
  expect(audit?.action).toBe('account.exported');
});

it('the account export scrubs notifications that reference tasks outside the account', async () => {
  const a = await fixture();
  const b = await fixture();
  const db = getDb();
  const foreignTask = await createTask(b.actor, { workspaceId: b.workspaceId, title: 'Foreign reminder task', priority: 'NONE', tagIds: [] });
  const ownedTask = await createTask(a.actor, { workspaceId: a.workspaceId, title: 'Owner reminder task', priority: 'NONE', tagIds: [] });

  // Legacy cross-reference: a notification on A's account pointing at B's task
  // (possible through pre-sharing bugs or imports). Its task content must not
  // leak through the export.
  const foreignRef = randomUUID();
  const ownedRef = randomUUID();
  const noWsRef = randomUUID();
  await db.insert(notifications).values([
    { id: foreignRef, userId: a.userId, workspaceId: null, type: 'task_reminder', title: 'Foreign reminder', body: 'foreign body that must not leak', taskId: foreignTask.id },
    { id: ownedRef, userId: a.userId, workspaceId: a.workspaceId, type: 'task_reminder', title: 'Owner reminder', body: 'owner body', taskId: ownedTask.id },
    { id: noWsRef, userId: a.userId, workspaceId: null, type: 'export_ready', title: 'Export ready', body: 'no task reference' },
  ]);

  const bundle = await buildExport(a.userId);
  const notices = bundle.notifications as Array<{ id: string; taskId: string | null; body: string | null; title: string }>;
  const scrubbed = notices.find((n) => n.id === foreignRef);
  expect(scrubbed).toBeTruthy();
  expect(scrubbed?.taskId).toBeNull();
  expect(scrubbed?.body).toBeNull();
  expect(scrubbed?.title).toBe('Reminder for unavailable task');

  const owned = notices.find((n) => n.id === ownedRef);
  expect(owned?.taskId).toBe(ownedTask.id);
  expect(owned?.body).toBe('owner body');

  const noWs = notices.find((n) => n.id === noWsRef);
  expect(noWs?.body).toBe('no task reference');

  // No foreign task content survives anywhere in the bundle.
  const flat = JSON.stringify(bundle);
  expect(flat.includes(foreignTask.id)).toBe(false);
  expect(flat.includes('Foreign reminder task')).toBe(false);
  expect(flat.includes('foreign body that must not leak')).toBe(false);
});
