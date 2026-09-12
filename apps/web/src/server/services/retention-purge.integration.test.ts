import { randomUUID } from 'node:crypto';
import { and, count, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { limitsFor } from '@nextdoo/contracts';
import {
  attachments,
  auditLogs,
  createDb,
  exports,
  mailDeliveries,
  outbox,
  recurrenceRules,
  reminders,
  runRetentionPurge,
  subscriptions,
  type RetentionPurgeResult,
  syncChanges,
  syncTombstones,
  tags,
  taskDependencies,
  taskOccurrences,
  taskTags,
  tasks,
  timerSessions,
  trackingEvents,
  trackingJobs,
  trackingResults,
  users,
  workspaceMembers,
  workspaces,
  type AttachmentObjectStore,
  type Database,
} from '@nextdoo/db';
import { dedicatedDatabase } from '../../../../../tests/dedicated-database';

/**
 * M6-i6 regression for the destructive retention pipeline (PRD §12.4
 * `retention.purge`, §13.5 retention table, §18.1 "Audit log retention",
 * §6.3 "Deleted → Permanently deleted").
 *
 * The sweeps are global (the real job takes no workspace argument), so this
 * file runs on a dedicated disposable database — one fresh schema per test —
 * instead of the shared integration database, whose back-dated fixtures the
 * parallel suite depends on.
 *
 * Covered:
 * - 30-day deleted-task expiry at the exact boundary (<=) with full cascade;
 * - plan audit retention (FREE 0 / PRO 30 / TEAM 365 / ENTERPRISE 2555 days)
 *   at the exact boundary for every plan;
 * - the one-year security-log floor and its boundary, per plan;
 * - tenant isolation (workspace rows and account-level rows);
 * - in-flight-export retention (PENDING/PROCESSING block, READY does not);
 * - no-action parent FK: referenced tasks retained and counted, converging
 *   once the referencing task is purged;
 * - per-row failure isolation (a corrupted row is reported, the sweep
 *   continues, the row survives and is purged once repaired);
 * - sync-tombstone expiry (any entity type, unexpired and in-restore-window
 *   tombstones kept);
 * - failed-job expiry (tracking jobs, reminders, exports, mail deliveries)
 *   for terminal failures older than 30 days only;
 * - records other PRD rules protect: tracking events/results, sync replay
 *   log, outbox, in-window audit, active and in-restore-window tasks;
 * - bounded passes across runs (crash/restart) and idempotent reruns.
 *
 * Worker-level retry/alert/dead-letter behaviour is covered by
 * apps/worker/src/retention-purge.integration.test.ts.
 */

const DAY = 86_400_000;
/** Fixed clock: every fixture is positioned relative to this instant. */
const NOW = new Date('2026-09-12T00:00:00.000Z');
/** NOW plus an offset in milliseconds. */
const at = (ms: number) => new Date(NOW.getTime() + ms);
const daysAgo = (d: number) => at(-d * DAY);

type Plan = 'FREE' | 'PRO' | 'TEAM' | 'ENTERPRISE';

let pool: ReturnType<typeof createDb> | undefined;
let db: Database;

beforeEach(async () => {
  pool = createDb((await dedicatedDatabase('nextdoo_retention_web')).url, { max: 2 });
  db = pool.db;
});

afterEach(async () => {
  await pool?.close();
});

// ---------------------------------------------------------------- fixtures

async function makeOwner(plan: Plan): Promise<{ userId: string; workspaceId: string }> {
  const userId = randomUUID();
  const workspaceId = randomUUID();
  await db.insert(users).values({
    id: userId,
    email: `retention-${userId}@test.local`,
    passwordHash: 'test',
    name: null,
    timeZone: 'UTC',
  });
  await db.insert(workspaces).values({ id: workspaceId, ownerId: userId, name: 'Retention workspace', timeZone: 'UTC' });
  await db.insert(workspaceMembers).values({ workspaceId, userId, role: 'OWNER' });
  // currentPeriodEnd is real-time-relative: readEffectivePlan compares it
  // against the actual clock, not the test clock.
  await db.insert(subscriptions).values({
    id: randomUUID(),
    userId,
    plan,
    status: 'ACTIVE',
    currentPeriodEnd: new Date(Date.now() + 30 * DAY),
  });
  return { userId, workspaceId };
}

async function insertDeletedTask(
  workspaceId: string,
  deletedAt: Date | null,
  extra: { parentTaskId?: string; status?: typeof tasks.$inferInsert['status']; title?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await db.insert(tasks).values({
    id,
    workspaceId,
    title: extra.title ?? 'Retention task',
    status: extra.status ?? 'DELETED',
    deletedAt,
    parentTaskId: extra.parentTaskId,
  });
  if (deletedAt) {
    await db.insert(syncTombstones).values({
      id: randomUUID(),
      workspaceId,
      entityType: 'task',
      entityId: id,
      deletedAt,
      purgeAfter: new Date(deletedAt.getTime() + 30 * DAY),
    });
  }
  return id;
}

async function insertAudit(
  workspaceId: string | null,
  actorId: string,
  action: string,
  createdAt: Date,
): Promise<string> {
  const id = randomUUID();
  await db.insert(auditLogs).values({
    id,
    workspaceId,
    actorId,
    action,
    targetType: 'task',
    targetId: randomUUID(),
    createdAt,
  });
  return id;
}

function exists(table: PgTable, where: SQL | undefined): Promise<boolean> {
  return db
    .select({ n: count() })
    .from(table)
    .where(where)
    .then(([row]) => Number(row?.n ?? 0) > 0);
}

async function rowCount(table: PgTable, where: SQL | undefined): Promise<number> {
  const [row] = await db.select({ n: count() }).from(table).where(where);
  return Number(row?.n ?? 0);
}

function fakeStore(failOn?: Set<string>): { store: AttachmentObjectStore; files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    store: {
      write: async (key: string, data: Uint8Array) => { files.set(key, data); },
      read: async (key: string) => files.get(key) ?? null,
      remove: async (key: string) => {
        if (failOn?.has(key)) throw new Error('simulated object-store outage');
        files.delete(key);
      },
    },
  };
}

const SEC = 'account.password_changed'; // in SECURITY_AUDIT_ACTIONS
const NON_SEC = 'task.updated';

// ------------------------------------------------------------------- tests

it('purges deleted tasks at the exact 30-day boundary with their cascaded rows, tombstones and files, and keeps everything else', async () => {
  const o = await makeOwner('PRO');
  const { store, files } = fakeStore();

  const tBoundary = await insertDeletedTask(o.workspaceId, at(-30 * DAY)); // exactly due
  const tInside = await insertDeletedTask(o.workspaceId, at(-30 * DAY + 1)); // 1 ms inside the window
  const tOld = await insertDeletedTask(o.workspaceId, daysAgo(31)); // 1 day overdue
  const tActive = randomUUID();
  await db.insert(tasks).values({ id: tActive, workspaceId: o.workspaceId, title: 'Still active', status: 'ACTIVE', updatedAt: daysAgo(100) });
  const tNullDeleted = randomUUID();
  await db.insert(tasks).values({ id: tNullDeleted, workspaceId: o.workspaceId, title: 'Deleted without timestamp', status: 'DELETED' });

  // Full cascade fixture on the boundary task.
  const depTarget = randomUUID();
  await db.insert(tasks).values({ id: depTarget, workspaceId: o.workspaceId, title: 'Dependency target' });
  const tag = randomUUID();
  await db.insert(tags).values({ id: tag, workspaceId: o.workspaceId, name: 'retention' });
  await db.insert(taskTags).values({ taskId: tBoundary, tagId: tag });
  await db.insert(taskDependencies).values({ taskId: tBoundary, dependsOnTaskId: depTarget });
  const reminder = randomUUID();
  await db.insert(reminders).values({
    id: reminder, workspaceId: o.workspaceId, taskId: tBoundary, userId: o.userId,
    scheduledAt: daysAgo(29), nextAttemptAt: daysAgo(29),
  });
  await db.insert(timerSessions).values({
    id: randomUUID(), workspaceId: o.workspaceId, taskId: tBoundary, userId: o.userId,
    deviceId: 'integration', startedAt: daysAgo(29),
  });
  const rule = randomUUID();
  await db.insert(recurrenceRules).values({
    id: rule, workspaceId: o.workspaceId, templateTaskId: tBoundary,
    rule: { freq: 'DAILY', interval: 1 }, timeZone: 'UTC', seriesStart: daysAgo(60),
  });
  await db.insert(taskOccurrences).values({
    id: randomUUID(), recurrenceRuleId: rule, taskId: tBoundary, occurrenceKey: 'day-1', dueAt: daysAgo(59),
  });
  // The tasks_tracking_invalidation trigger already created the row on task
  // insert; update it to a queued state.
  await db
    .update(trackingJobs)
    .set({ revision: 2, queuedRevision: 1 })
    .where(eq(trackingJobs.taskId, tBoundary));
  const file = `attach-${randomUUID()}/${randomUUID()}.png`;
  await store.write(file, new Uint8Array([1, 2, 3]));
  await db.insert(attachments).values({
    id: randomUUID(), workspaceId: o.workspaceId, taskId: tBoundary, uploaderId: o.userId,
    objectKey: file, fileName: 'a.png', contentType: 'image/png', sizeBytes: 3,
  });
  // Records other PRD rules protect even though their task is purged.
  await db.insert(trackingEvents).values({
    id: randomUUID(), sequence: 1, workspaceId: o.workspaceId, taskId: tBoundary,
    type: 'TASK_COMPLETED', occurredAt: daysAgo(100), idempotencyKey: `ie-${randomUUID()}`,
  });
  await db.insert(trackingResults).values({
    id: randomUUID(), workspaceId: o.workspaceId, taskId: tBoundary,
    outcome: 'ON_TIME', components: {}, explanation: '', measuredWeight: '1', inputHash: 'h',
  });
  await db.insert(syncChanges).values({
    workspaceId: o.workspaceId, entityType: 'task', entityId: tBoundary, operation: 'delete', payload: {}, version: 2,
  });
  await db.insert(outbox).values({
    id: randomUUID(), eventType: 'task.deleted', workspaceId: o.workspaceId, actorId: o.userId,
    entityType: 'task', entityId: tBoundary, occurredAt: daysAgo(31),
  });

  const result = await runRetentionPurge(db, { now: NOW, attachmentStore: store });

  // Exact boundary: exactly 30 days is due (<=), 1 ms younger is not.
  expect(result.tasksPurged).toBe(2); // tBoundary + tOld
  expect(result.failures).toEqual([]);
  expect(result.attachmentFilesRemoved).toBe(1);
  expect(result.syncTombstonesPurged).toBe(2); // their due task tombstones

  const survivors = await db
    .select({ id: tasks.id, status: tasks.status })
    .from(tasks)
    .where(inArray(tasks.id, [tBoundary, tInside, tOld, tActive, tNullDeleted, depTarget]));
  expect(survivors.map((r) => r.id).sort()).toEqual([tActive, tInside, tNullDeleted, depTarget].sort());

  // Cascade: every related row is gone. The recurrence rule cascades from the
  // task and its occurrences cascade from the rule; the dependency target
  // (referenced by depends_on_task_id, not owned by the task) survives.
  expect(await exists(taskTags, eq(taskTags.taskId, tBoundary))).toBe(false);
  expect(await exists(taskDependencies, eq(taskDependencies.taskId, tBoundary))).toBe(false);
  expect(await exists(reminders, eq(reminders.taskId, tBoundary))).toBe(false);
  expect(await exists(timerSessions, eq(timerSessions.taskId, tBoundary))).toBe(false);
  expect(await exists(recurrenceRules, eq(recurrenceRules.templateTaskId, tBoundary))).toBe(false);
  expect(await exists(taskOccurrences, eq(taskOccurrences.recurrenceRuleId, rule))).toBe(false);
  expect(await exists(trackingJobs, eq(trackingJobs.taskId, tBoundary))).toBe(false);
  expect(await exists(attachments, eq(attachments.taskId, tBoundary))).toBe(false);
  expect(await exists(tasks, eq(tasks.id, depTarget))).toBe(true);
  expect(files.has(file)).toBe(false);

  // The retained task keeps its row, its in-window tombstone and its files.
  expect(await exists(syncTombstones, eq(syncTombstones.entityId, tInside))).toBe(true);

  // Protection invariants: history that outlives the task itself.
  expect(await exists(trackingEvents, eq(trackingEvents.taskId, tBoundary))).toBe(true);
  expect(await exists(trackingResults, eq(trackingResults.taskId, tBoundary))).toBe(true);
  expect(await exists(syncChanges, eq(syncChanges.entityId, tBoundary))).toBe(true);
  expect(await exists(outbox, eq(outbox.entityId, tBoundary))).toBe(true);

  // Nothing else was touched.
  expect(result.auditLogsPurged).toBe(0);
  expect(result.securityAuditRetained).toBe(0);
  expect(result.tasksRetainedForExports).toBe(0);
  expect(result.tasksRetainedForReferencingTasks).toBe(0);
  expect(result.failedJobsPurged).toEqual({ trackingJobs: 0, reminders: 0, exports: 0, mailDeliveries: 0 });
});

it('applies plan-based audit retention at the exact boundary for every plan', async () => {
  // Rows per plan: A inside the window, B exactly at it, C 1 ms past, D one
  // full day past. All non-security actions, so the floor never intervenes.
  const plans: Plan[] = ['FREE', 'PRO', 'TEAM', 'ENTERPRISE'];
  const seeded: Array<{ plan: Plan; a: string; b: string; c: string; d: string }> = [];
  for (const plan of plans) {
    const o = await makeOwner(plan);
    const r = limitsFor(plan).auditLogRetentionDays;
    seeded.push({
      plan,
      a: await insertAudit(o.workspaceId, o.userId, NON_SEC, at(r === 0 ? 1000 : -r * DAY + 1000)),
      b: await insertAudit(o.workspaceId, o.userId, NON_SEC, at(-r * DAY)),
      c: await insertAudit(o.workspaceId, o.userId, NON_SEC, at(-r * DAY - 1)),
      d: await insertAudit(o.workspaceId, o.userId, NON_SEC, at(-r * DAY - DAY)),
    });
  }

  const result = await runRetentionPurge(db, { now: NOW });

  // Two rows per plan (C and D) become eligible; A and B (boundary included)
  // stay for the life of their plan window.
  expect(result.auditLogsPurged).toBe(plans.length * 2);
  expect(result.securityAuditRetained).toBe(0);
  expect(result.workspacesScanned).toBe(plans.length);
  expect(result.failures).toEqual([]);
  for (const s of seeded) {
    expect(await exists(auditLogs, eq(auditLogs.id, s.a))).toBe(true);
    expect(await exists(auditLogs, eq(auditLogs.id, s.b))).toBe(true);
    expect(await exists(auditLogs, eq(auditLogs.id, s.c))).toBe(false);
    expect(await exists(auditLogs, eq(auditLogs.id, s.d))).toBe(false);
  }
});

it('keeps security-critical audit rows for one year (floor) at the exact floor boundary, per plan', async () => {
  // FREE (R=0): the floor alone decides.
  const free = await makeOwner('FREE');
  const s1 = await insertAudit(free.workspaceId, free.userId, SEC, at(-365 * DAY + 1)); // inside floor
  const s2 = await insertAudit(free.workspaceId, free.userId, SEC, at(-365 * DAY)); // exactly at floor
  const s3 = await insertAudit(free.workspaceId, free.userId, SEC, at(-365 * DAY - 1)); // floor expired
  const n1 = await insertAudit(free.workspaceId, free.userId, NON_SEC, daysAgo(10));
  const n2 = await insertAudit(free.workspaceId, free.userId, NON_SEC, at(1000));

  // PRO (R=30): the floor extends the window for security rows only.
  const pro = await makeOwner('PRO');
  const s4 = await insertAudit(pro.workspaceId, pro.userId, SEC, daysAgo(100)); // floor keeps
  const s5 = await insertAudit(pro.workspaceId, pro.userId, SEC, daysAgo(400)); // past floor
  const n3 = await insertAudit(pro.workspaceId, pro.userId, NON_SEC, daysAgo(100));
  const n4 = await insertAudit(pro.workspaceId, pro.userId, NON_SEC, daysAgo(10));

  // TEAM (R=365): floor equals the window — no extension.
  const team = await makeOwner('TEAM');
  const s6 = await insertAudit(team.workspaceId, team.userId, SEC, daysAgo(400));
  const n5 = await insertAudit(team.workspaceId, team.userId, NON_SEC, daysAgo(400));
  const n6 = await insertAudit(team.workspaceId, team.userId, NON_SEC, daysAgo(100));

  // ENTERPRISE (R=2555): the plan window is longer than the floor.
  const ent = await makeOwner('ENTERPRISE');
  const s7 = await insertAudit(ent.workspaceId, ent.userId, SEC, daysAgo(2000));
  const n7 = await insertAudit(ent.workspaceId, ent.userId, NON_SEC, daysAgo(2600));

  const result = await runRetentionPurge(db, { now: NOW });

  expect(result.auditLogsPurged).toBe(7); // s3 n1 s5 n3 s6 n5 n7
  // s1, s2 (FREE) and s4 (PRO) are exactly the rows the floor saved from a
  // shorter plan window.
  expect(result.securityAuditRetained).toBe(3);
  expect(result.failures).toEqual([]);

  for (const [id, kept] of [
    [s1, true], [s2, true], [s3, false], [n1, false], [n2, true],
    [s4, true], [s5, false], [n3, false], [n4, true],
    [s6, false], [n5, false], [n6, true],
    [s7, true], [n7, false],
  ] as Array<[string, boolean]>) {
    expect(await exists(auditLogs, eq(auditLogs.id, id)), `audit row ${id}`).toBe(kept);
  }
});

it('isolates tenants: each owner\u2019s plan window applies only to their own rows', async () => {
  const free = await makeOwner('FREE');
  const pro = await makeOwner('PRO');

  const f1 = await insertAudit(free.workspaceId, free.userId, NON_SEC, daysAgo(50));
  const f2 = await insertAudit(free.workspaceId, free.userId, NON_SEC, daysAgo(10));
  const p1 = await insertAudit(pro.workspaceId, pro.userId, NON_SEC, daysAgo(40));
  const p2 = await insertAudit(pro.workspaceId, pro.userId, NON_SEC, daysAgo(10));
  // Account-level rows (workspace_id NULL) follow the same per-owner rules.
  const f3 = await insertAudit(null, free.userId, NON_SEC, daysAgo(50));
  const p3 = await insertAudit(null, pro.userId, NON_SEC, daysAgo(10));

  const result = await runRetentionPurge(db, { now: NOW });

  expect(result.auditLogsPurged).toBe(4); // f1 f2 p1 f3
  expect(result.workspacesScanned).toBe(2);
  expect(result.accountOwnersScanned).toBe(2);
  expect(result.failures).toEqual([]);

  // Free retains nothing (0 days); PRO keeps its 10-day rows and purges its
  // 40-day row — independently, without ever touching the other tenant.
  expect(await exists(auditLogs, eq(auditLogs.id, f1))).toBe(false);
  expect(await exists(auditLogs, eq(auditLogs.id, f2))).toBe(false);
  expect(await exists(auditLogs, eq(auditLogs.id, p1))).toBe(false);
  expect(await exists(auditLogs, eq(auditLogs.id, p2))).toBe(true);
  expect(await exists(auditLogs, eq(auditLogs.id, f3))).toBe(false);
  expect(await exists(auditLogs, eq(auditLogs.id, p3))).toBe(true);
});

it('caps the per-run tenant scan at distinct tenants (a busy tenant cannot starve the others) and catches up on the next run', async () => {
  const a = await makeOwner('FREE');
  const b = await makeOwner('FREE');
  const c = await makeOwner('FREE');
  // Tenant "a" is busy (many eligible rows). A row-based candidate cap would
  // let its rows fill the whole slot budget, so the other tenants would not
  // be scanned at all; a distinct-tenant cap guarantees each scanned tenant
  // is one, and every tenant is eventually reached.
  for (let i = 0; i < 5; i++) await insertAudit(a.workspaceId, a.userId, NON_SEC, daysAgo(10));
  await insertAudit(b.workspaceId, b.userId, NON_SEC, daysAgo(10));
  await insertAudit(b.workspaceId, b.userId, NON_SEC, daysAgo(11));
  await insertAudit(c.workspaceId, c.userId, NON_SEC, daysAgo(10));
  await insertAudit(c.workspaceId, c.userId, NON_SEC, daysAgo(11));

  const counts: Record<string, number> = { [a.workspaceId]: 5, [b.workspaceId]: 2, [c.workspaceId]: 2 };
  const ordered = [a.workspaceId, b.workspaceId, c.workspaceId].sort();
  const first = ordered[0]!;
  const second = ordered[1]!;
  const third = ordered[2]!;
  const expectedFirstRun = (counts[first] ?? 0) + (counts[second] ?? 0);

  const run1 = await runRetentionPurge(db, { now: NOW, limit: { workspaces: 2 } });
  expect(run1.failures).toEqual([]);
  expect(run1.workspacesScanned).toBe(2);
  expect(run1.auditLogsPurged).toBe(expectedFirstRun);

  // The third tenant (largest workspace id) was not scanned yet: its rows
  // survive, untouched, and remain eligible for the next run.
  expect(await rowCount(auditLogs, and(eq(auditLogs.workspaceId, third), eq(auditLogs.action, NON_SEC)))).toBe(counts[third] ?? 0);

  // The next daily run picks up the remainder.
  const run2 = await runRetentionPurge(db, { now: NOW });
  expect(run2.failures).toEqual([]);
  expect(run2.workspacesScanned).toBe(1);
  expect(run2.auditLogsPurged).toBe(counts[third] ?? 0);
  expect(await rowCount(auditLogs, eq(auditLogs.action, NON_SEC))).toBe(0);
});

it('retains eligible tasks while the owner has an in-flight export and purges them once it completes', async () => {
  const pending = await makeOwner('FREE');
  const ready = await makeOwner('FREE');
  const processing = await makeOwner('FREE');

  const tPendingOwner = await insertDeletedTask(pending.workspaceId, daysAgo(31));
  const tReadyOwner = await insertDeletedTask(ready.workspaceId, daysAgo(31));
  const tProcessingOwner = await insertDeletedTask(processing.workspaceId, daysAgo(31));

  const insertExport = (userId: string, workspaceId: string, status: string) =>
    db.insert(exports).values({
      id: randomUUID(), userId, workspaceId, format: 'json', status,
      nextAttemptAt: daysAgo(1),
    });
  await insertExport(pending.userId, pending.workspaceId, 'PENDING');
  await insertExport(ready.userId, ready.workspaceId, 'READY');
  await insertExport(processing.userId, processing.workspaceId, 'PROCESSING');

  const first = await runRetentionPurge(db, { now: NOW });
  expect(first.tasksPurged).toBe(1); // only the READY export's owner
  expect(first.tasksRetainedForExports).toBe(2);
  expect(first.failures).toEqual([]);
  expect(await exists(tasks, eq(tasks.id, tPendingOwner))).toBe(true);
  expect(await exists(tasks, eq(tasks.id, tReadyOwner))).toBe(false);
  expect(await exists(tasks, eq(tasks.id, tProcessingOwner))).toBe(true);

  // The in-flight exports complete; the next daily run finishes the job.
  await db.update(exports).set({ status: 'READY', completedAt: daysAgo(1) }).where(inArray(exports.userId, [pending.userId, processing.userId]));
  const second = await runRetentionPurge(db, { now: NOW });
  expect(second.tasksPurged).toBe(2);
  expect(second.tasksRetainedForExports).toBe(0);
  expect(await exists(tasks, eq(tasks.id, tPendingOwner))).toBe(false);
  expect(await exists(tasks, eq(tasks.id, tProcessingOwner))).toBe(false);
});

it('retains a deleted task still referenced by other tasks until the reference is purged, then converges', async () => {
  const o = await makeOwner('PRO');
  const parent = await insertDeletedTask(o.workspaceId, daysAgo(40));
  const child = await insertDeletedTask(o.workspaceId, daysAgo(31), { parentTaskId: parent });
  // A second tenant whose parent is referenced by a task that is never
  // deleted: retained forever, counted every run, never a failure.
  const o2 = await makeOwner('PRO');
  const livingParent = await insertDeletedTask(o2.workspaceId, daysAgo(40));
  const livingChild = randomUUID();
  await db.insert(tasks).values({ id: livingChild, workspaceId: o2.workspaceId, title: 'Living child', status: 'ACTIVE', parentTaskId: livingParent });

  const first = await runRetentionPurge(db, { now: NOW });
  // The 40-day parents are processed before the 31-day child: both parents
  // are retained (referenced), the child is purged.
  expect(first.tasksPurged).toBe(1);
  expect(first.tasksRetainedForReferencingTasks).toBe(2);
  expect(first.failures).toEqual([]);
  // The retained parent's tombstone still has its own 30-day clock: it
  // expired 10 days ago, so the generic sweep removes it even though the
  // task row survives (restoration is impossible beyond the window anyway).
  expect(await exists(tasks, eq(tasks.id, parent))).toBe(true);
  expect(await exists(syncTombstones, eq(syncTombstones.entityId, parent))).toBe(false);
  expect(await exists(tasks, eq(tasks.id, child))).toBe(false);

  const second = await runRetentionPurge(db, { now: NOW });
  expect(second.tasksPurged).toBe(1); // the unblocked parent
  expect(second.tasksRetainedForReferencingTasks).toBe(1); // the living parent stays
  expect(await exists(tasks, eq(tasks.id, parent))).toBe(false);
  expect(await exists(tasks, eq(tasks.id, livingParent))).toBe(true);
  expect(await exists(tasks, eq(tasks.id, livingChild))).toBe(true);

  const third = await runRetentionPurge(db, { now: NOW });
  // Steady state: nothing left to purge, the living parent is still counted
  // (visible, never silently dropped, never a failing row).
  expect(third.tasksPurged).toBe(0);
  expect(third.tasksRetainedForReferencingTasks).toBe(1);
  expect(third.failures).toEqual([]);
});

it('isolates per-row failures: a corrupted row is reported, the sweep continues, and the row is purged once repaired', async () => {
  const o = await makeOwner('FREE');
  const poisoned = await insertDeletedTask(o.workspaceId, daysAgo(31));
  const healthy = await insertDeletedTask(o.workspaceId, daysAgo(31));

  // DDL runs through the raw client with the (self-generated, hex-dashed)
  // UUID inlined: drizzle's execute path cannot type a parameter referenced
  // from inside a plpgsql body.
  await db.$client.unsafe(`create or replace function retention_test_poison() returns trigger as $fn$
    begin
      if old.id = '${poisoned}'::uuid then raise exception 'simulated corrupted row'; end if;
      return old;
    end
  $fn$ language plpgsql`);
  try {
    await db.execute(sql`create trigger retention_test_poison before delete on tasks for each row execute function retention_test_poison()`);
    const first = await runRetentionPurge(db, { now: NOW });
    expect(first.tasksPurged).toBe(1); // the healthy task
    expect(first.failures).toEqual([{ kind: 'task', id: poisoned, error: 'simulated corrupted row' }]);
    // The failed delete rolled back: the task row is still intact (its
    // tombstone had its own 30-day clock expire a day earlier, so the
    // generic sweep removed it independently).
    expect(await exists(tasks, eq(tasks.id, poisoned))).toBe(true);
    expect(await exists(syncTombstones, eq(syncTombstones.entityId, poisoned))).toBe(false);
    expect(await exists(tasks, eq(tasks.id, healthy))).toBe(false);
  } finally {
    await db.execute(sql`drop trigger if exists retention_test_poison on tasks`);
    await db.execute(sql`drop function if exists retention_test_poison()`);
  }

  // Repaired: the next daily run picks the row up (never auto-skipped).
  const second = await runRetentionPurge(db, { now: NOW });
  expect(second.tasksPurged).toBe(1);
  expect(second.failures).toEqual([]);
  expect(await exists(tasks, eq(tasks.id, poisoned))).toBe(false);
});

it('purges expired sync tombstones of any entity type and keeps unexpired or in-restore-window ones', async () => {
  const o = await makeOwner('FREE');

  const expiredProject = randomUUID();
  await db.insert(syncTombstones).values({
    id: randomUUID(), workspaceId: o.workspaceId, entityType: 'project', entityId: expiredProject,
    deletedAt: daysAgo(40), purgeAfter: at(-3_600_000),
  });
  const futureProject = randomUUID();
  await db.insert(syncTombstones).values({
    id: randomUUID(), workspaceId: o.workspaceId, entityType: 'project', entityId: futureProject,
    deletedAt: daysAgo(29), purgeAfter: at(3_600_000),
  });
  // A task still inside its restore window: the task is kept, and so is its
  // tombstone (purge_after in the future).
  const inWindow = await insertDeletedTask(o.workspaceId, daysAgo(29));
  // An orphaned task tombstone (no task row left) that is due.
  const orphan = randomUUID();
  await db.insert(syncTombstones).values({
    id: randomUUID(), workspaceId: o.workspaceId, entityType: 'task', entityId: orphan,
    deletedAt: daysAgo(40), purgeAfter: at(-1),
  });

  const result = await runRetentionPurge(db, { now: NOW });

  expect(result.syncTombstonesPurged).toBe(2); // expiredProject + orphan
  expect(result.tasksPurged).toBe(0);
  expect(result.failures).toEqual([]);
  expect(await exists(syncTombstones, eq(syncTombstones.entityId, expiredProject))).toBe(false);
  expect(await exists(syncTombstones, eq(syncTombstones.entityId, futureProject))).toBe(true);
  expect(await exists(syncTombstones, eq(syncTombstones.entityId, inWindow))).toBe(true);
  expect(await exists(tasks, eq(tasks.id, inWindow))).toBe(true);
  expect(await exists(syncTombstones, eq(syncTombstones.entityId, orphan))).toBe(false);
});

it('purges terminally failed job entries older than 30 days at the exact boundary, and nothing else', async () => {
  const o = await makeOwner('FREE');
  const task = async (title: string) => {
    const id = randomUUID();
    await db.insert(tasks).values({ id, workspaceId: o.workspaceId, title });
    return id;
  };
  const jt1 = await task('job 1'), jt2 = await task('job 2'), jt3 = await task('job 3'), jt4 = await task('job 4'), jt5 = await task('job 5');

  // The tasks_tracking_invalidation trigger created one job row per task on
  // insert; the sweep state below is shaped by updating those rows.
  const job = (taskId: string, extra: Record<string, unknown>) =>
    db.update(trackingJobs).set({ ...extra }).where(eq(trackingJobs.taskId, taskId));
  await job(jt1, { attempts: 6, lastError: 'E', lastErrorAt: daysAgo(40), queuedRevision: 1, acknowledgedRevision: 1 }); // terminal, old
  await job(jt2, { attempts: 3, lastError: 'E', lastErrorAt: daysAgo(40), queuedRevision: 2, acknowledgedRevision: 1 }); // retryable
  await job(jt3, { attempts: 6, lastError: 'E', lastErrorAt: daysAgo(10) }); // terminal, recent
  await job(jt4, { attempts: 6, lastError: 'E', lastErrorAt: at(-30 * DAY), queuedRevision: 1, acknowledgedRevision: 1 }); // exact boundary
  await job(jt5, { attempts: 6, lastError: 'E', lastErrorAt: daysAgo(40), claimToken: randomUUID(), leaseExpiresAt: at(3_600_000) }); // in-flight claim

  const reminder = (taskId: string, status: typeof reminders.$inferInsert['status'], updatedAt: Date) =>
    db.insert(reminders).values({
      id: randomUUID(), workspaceId: o.workspaceId, taskId, userId: o.userId,
      scheduledAt: updatedAt, nextAttemptAt: updatedAt, status, updatedAt,
    });
  await reminder(jt1, 'FAILED', daysAgo(40));
  await reminder(jt2, 'FAILED', daysAgo(10));
  await reminder(jt3, 'SCHEDULED', daysAgo(40));
  await reminder(jt4, 'FAILED', at(-30 * DAY));

  const exportRow = (status: string, updatedAt: Date) =>
    db.insert(exports).values({
      id: randomUUID(), userId: o.userId, workspaceId: o.workspaceId, format: 'json',
      status, nextAttemptAt: updatedAt, updatedAt,
    });
  await exportRow('FAILED', daysAgo(40));
  await exportRow('FAILED', daysAgo(10));
  await exportRow('FAILED', at(-30 * DAY));

  const mail = (createdAt: Date) =>
    db.insert(mailDeliveries).values({
      id: randomUUID(), userId: o.userId, kind: 'EXPORT_READY', encryptedMessage: 'enc',
      status: 'FAILED', expiresAt: daysAgo(35), createdAt,
    });
  await mail(daysAgo(40));
  await mail(daysAgo(10));
  await mail(at(-30 * DAY));

  const result = await runRetentionPurge(db, { now: NOW });

  expect(result.failedJobsPurged).toEqual({ trackingJobs: 2, reminders: 2, exports: 2, mailDeliveries: 2 });
  expect(result.tasksPurged).toBe(0);
  expect(result.failures).toEqual([]);

  const survivors = await db
    .select({ taskId: trackingJobs.taskId })
    .from(trackingJobs)
    .where(eq(trackingJobs.workspaceId, o.workspaceId));
  expect(survivors.map((r) => r.taskId).sort()).toEqual([jt2, jt3, jt5].sort());

  const reminderRows = await db
    .select({ status: reminders.status })
    .from(reminders)
    .where(eq(reminders.workspaceId, o.workspaceId));
  expect(reminderRows.map((r) => r.status).sort()).toEqual(['FAILED', 'SCHEDULED']);

  const exportRows = await db
    .select({ status: exports.status, updatedAt: exports.updatedAt })
    .from(exports)
    .where(eq(exports.userId, o.userId));
  expect(exportRows).toHaveLength(1);
  expect(exportRows[0]!.status).toBe('FAILED');
  expect(exportRows[0]!.updatedAt.getTime()).toBe(daysAgo(10).getTime());

  const mailRows = await db
    .select({ createdAt: mailDeliveries.createdAt })
    .from(mailDeliveries)
    .where(eq(mailDeliveries.userId, o.userId));
  expect(mailRows).toHaveLength(1);
  expect(mailRows[0]!.createdAt.getTime()).toBe(daysAgo(10).getTime());
});

it('drains bounded passes across runs (crash/restart safety) and is idempotent on rerun', async () => {
  const o = await makeOwner('FREE');

  const eligible: string[] = [];
  for (let i = 0; i < 5; i += 1) eligible.push(await insertDeletedTask(o.workspaceId, daysAgo(31)));

  const tombstones: string[] = [];
  for (let i = 0; i < 7; i += 1) {
    const id = randomUUID();
    tombstones.push(id);
    await db.insert(syncTombstones).values({
      id: randomUUID(), workspaceId: o.workspaceId, entityType: 'project', entityId: id,
      deletedAt: daysAgo(40), purgeAfter: at(-3_600_000 * (i + 1)),
    });
  }

  // 1500 expired rows: more than one bounded audit batch of 1000.
  await db.insert(auditLogs).values(
    Array.from({ length: 1500 }, () => ({
      id: randomUUID(),
      workspaceId: o.workspaceId,
      actorId: o.userId,
      action: NON_SEC,
      targetType: 'task',
      targetId: randomUUID(),
      createdAt: daysAgo(40),
    })),
  );

  const limit = { tasks: 2, tombstones: 3, auditBatchesPerWorkspace: 1 };
  const runs: RetentionPurgeResult[] = [];
  for (let i = 0; i < 4; i += 1) runs.push(await runRetentionPurge(db, { now: NOW, limit }));

  // Tasks are paged (2 at a time) and drained within a run while progress is
  // made; tombstones and audit batches are capped per run and drain across
  // runs — the exact shape a crash/restart would leave behind.
  expect(runs[0]!.tasksPurged).toBe(5);
  expect(runs[0]!.syncTombstonesPurged).toBe(5 + 3); // 5 due task tombstones + 3 of the 7
  expect(runs[0]!.auditLogsPurged).toBe(1000);
  expect(runs[1]!.tasksPurged).toBe(0);
  expect(runs[1]!.syncTombstonesPurged).toBe(3);
  expect(runs[1]!.auditLogsPurged).toBe(500);
  expect(runs[2]!.tasksPurged).toBe(0);
  expect(runs[2]!.syncTombstonesPurged).toBe(1);
  expect(runs[2]!.auditLogsPurged).toBe(0);
  // Fully drained: a rerun is a no-op.
  expect(runs[3]!.tasksPurged).toBe(0);
  expect(runs[3]!.syncTombstonesPurged).toBe(0);
  expect(runs[3]!.auditLogsPurged).toBe(0);
  expect(runs[3]!.failures).toEqual([]);

  expect(await exists(tasks, eq(tasks.id, eligible[0]!))).toBe(false);
  expect(await rowCount(tasks, eq(tasks.workspaceId, o.workspaceId))).toBe(0);
  expect(await rowCount(syncTombstones, eq(syncTombstones.workspaceId, o.workspaceId))).toBe(0);
  expect(await rowCount(auditLogs, and(eq(auditLogs.workspaceId, o.workspaceId), eq(auditLogs.action, NON_SEC)))).toBe(0);
});

it('reports a failing attachment file without un-deleting the task', async () => {
  const o = await makeOwner('FREE');
  const t = await insertDeletedTask(o.workspaceId, daysAgo(31));
  const bad = `attach-${randomUUID()}/${randomUUID()}.txt`;
  const good = `attach-${randomUUID()}/${randomUUID()}.txt`;
  const { store } = fakeStore(new Set([bad]));
  await db.insert(attachments).values([
    { id: randomUUID(), workspaceId: o.workspaceId, taskId: t, uploaderId: o.userId, objectKey: bad, fileName: 'bad.txt', contentType: 'text/plain', sizeBytes: 1 },
    { id: randomUUID(), workspaceId: o.workspaceId, taskId: t, uploaderId: o.userId, objectKey: good, fileName: 'good.txt', contentType: 'text/plain', sizeBytes: 1 },
  ]);

  const result = await runRetentionPurge(db, { now: NOW, attachmentStore: store });

  expect(result.tasksPurged).toBe(1);
  expect(result.attachmentFilesRemoved).toBe(1); // the good one
  expect(result.failures).toEqual([{ kind: 'attachment_file', id: bad, error: 'simulated object-store outage' }]);
  // The task row is gone; the bad file is reported for operations, not hidden.
  expect(await exists(tasks, eq(tasks.id, t))).toBe(false);
  expect(await exists(attachments, eq(attachments.objectKey, bad))).toBe(false);
});
