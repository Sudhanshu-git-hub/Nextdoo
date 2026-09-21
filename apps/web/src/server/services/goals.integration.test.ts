import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { goals, milestones, goalTasks, milestoneTasks, outbox, syncChanges, auditLogs, users, purgeAccount } from '@nextdoo/db';
import { requireTestDatabase } from '../../../../../tests/database';
import { getDb } from '../db';
import { registerUser } from './accounts';
import { createTask, completeTask, reopenTask, deleteTask } from './tasks';
import { buildExport } from './data-rights';
import * as events from './events';
import * as service from './goals';

await requireTestDatabase();
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const user = await registerUser({ email: `goals-${randomUUID()}@test.local`, passwordHash: 'test', name: null, timeZone: 'UTC' });
  const actor = { userId: user.id, workspaceId: user.workspaceId };
  const goal = await service.createGoal(actor, { workspaceId: user.workspaceId, title: 'Learn Python', priority: 'HIGH' });
  return { actor, goal };
}
const taskFor = (actor: service.GoalActor) => createTask(actor, { workspaceId: actor.workspaceId, title: 'Study', priority: 'NONE', tagIds: [] });

it('allocates stable identifiers concurrently and never reuses archived identifiers', async () => {
  const { actor, goal } = await fixture();
  const created = await Promise.all(Array.from({ length: 4 }, (_, i) => service.createGoal(actor, { workspaceId: actor.workspaceId, title: `Goal ${i}`, priority: 'NONE' })));
  expect(new Set([goal.identifier, ...created.map((g) => g.identifier)])).toHaveLength(5);
  const ms = await Promise.all([1, 2].map((i) => service.createMilestone(actor, goal.id, { title: `Module ${i}` })));
  expect(ms.map((m) => m.identifier).sort()).toEqual(['G1.M1', 'G1.M2']);
  await service.setMilestoneStatus(actor, ms[0]!.id, 1, 'ARCHIVED');
  expect((await service.createMilestone(actor, goal.id, { title: 'Next module' })).identifier).toBe('G1.M3');
  const parent = created[0]!;
  const moved = await service.updateGoal(actor, goal.id, { version: 1, parentGoalId: parent.id });
  expect(moved.identifier).toBe('G1');
});

it('rejects cross-tenant reads, parents and task links, including direct database inserts', async () => {
  const a = await fixture(), b = await fixture();
  const task = await taskFor(b.actor);
  const milestone = await service.createMilestone(a.actor, a.goal.id, { title: 'Module' });
  await expect(service.goalDetail(a.actor.workspaceId, b.goal.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(service.createGoal(a.actor, { workspaceId: b.actor.workspaceId, title: 'No', priority: 'NONE' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(service.updateGoal(a.actor, a.goal.id, { version: 1, parentGoalId: b.goal.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(service.linkGoalTask(a.actor, a.goal.id, { version: 1, taskId: task.id, linked: true })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(service.linkMilestoneTask(a.actor, milestone.id, { version: 1, taskId: task.id, linked: true })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(getDb().insert(goalTasks).values({ workspaceId: a.actor.workspaceId, goalId: a.goal.id, taskId: task.id })).rejects.toThrow();
  await expect(getDb().update(goals).set({ parentGoalId: b.goal.id }).where(eq(goals.id, a.goal.id))).rejects.toThrow();
  await expect(getDb().insert(milestoneTasks).values({ workspaceId: b.actor.workspaceId, milestoneId: milestone.id, taskId: task.id })).rejects.toThrow();
});

it('rejects hierarchy cycles and concurrent opposing reparent operations', async () => {
  const { actor, goal } = await fixture();
  const child = await service.createGoal(actor, { workspaceId: actor.workspaceId, parentGoalId: goal.id, title: 'Child', priority: 'NONE' });
  await expect(service.updateGoal(actor, goal.id, { version: 1, parentGoalId: child.id })).rejects.toMatchObject({ code: 'DEPENDENCY_CYCLE' });
  await expect(service.updateGoal(actor, goal.id, { version: 1, parentGoalId: goal.id })).rejects.toMatchObject({ code: 'DEPENDENCY_CYCLE' });
  const other = await service.createGoal(actor, { workspaceId: actor.workspaceId, title: 'Other', priority: 'NONE' });
  const results = await Promise.allSettled([
    service.updateGoal(actor, goal.id, { version: 1, parentGoalId: other.id }),
    service.updateGoal(actor, other.id, { version: 1, parentGoalId: goal.id }),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'DEPENDENCY_CYCLE' } });
});

it('validates partial date edits against stored dates and clears dates explicitly', async () => {
  const { actor, goal } = await fixture();
  const dated = await service.updateGoal(actor, goal.id, { version: 1, startAt: '2026-01-10T00:00:00Z', dueAt: '2026-02-10T00:00:00Z' });
  await expect(service.updateGoal(actor, goal.id, { version: dated.version, dueAt: '2026-01-01T00:00:00Z' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  expect(await service.updateGoal(actor, goal.id, { version: dated.version, startAt: null })).toMatchObject({ startAt: null, dueAt: '2026-02-10T00:00:00.000Z' });
  const m = await service.createMilestone(actor, goal.id, { title: 'Test' });
  expect(await service.updateMilestone(actor, m.id, { version: 1, dueAt: '2026-01-10T00:00:00Z' })).toMatchObject({ dueAt: '2026-01-10T00:00:00.000Z' });
});

it('bounds hierarchy depth for new goals and for moving an existing subtree', async () => {
  const { actor, goal } = await fixture();
  let parent = goal;
  for (let depth = 2; depth <= 20; depth++) parent = await service.createGoal(actor, {
    workspaceId: actor.workspaceId, title: `Level ${depth}`, priority: 'NONE', parentGoalId: parent.id,
  });
  await expect(service.createGoal(actor, { workspaceId: actor.workspaceId, title: 'Too deep', priority: 'NONE', parentGoalId: parent.id })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  const root = await service.createGoal(actor, { workspaceId: actor.workspaceId, title: 'Another root', priority: 'NONE' });
  await expect(service.updateGoal(actor, goal.id, { version: 1, parentGoalId: root.id })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  expect((await service.loadGoal(actor.workspaceId, goal.id)).parentGoalId).toBeNull();
});

it('progress derives from deduplicated tasks across descendants and milestones, including reopen', async () => {
  const { actor, goal } = await fixture();
  expect((await service.goalDetail(actor.workspaceId, goal.id)).progress.percent).toBeNull();
  const child = await service.createGoal(actor, { workspaceId: actor.workspaceId, parentGoalId: goal.id, title: 'Child', priority: 'NONE' });
  const task = await taskFor(actor), other = await taskFor(actor);
  const m = await service.createMilestone(actor, child.id, { title: 'Module' });
  await service.linkMilestoneTask(actor, m.id, { version: 1, taskId: task.id, linked: true });
  await service.linkGoalTask(actor, goal.id, { version: 1, taskId: task.id, linked: true });
  await service.linkGoalTask(actor, child.id, { version: 1, taskId: other.id, linked: true });
  const done = await completeTask(actor, task.id, task.version);
  const detail = await service.goalDetail(actor.workspaceId, goal.id);
  expect(detail.progress).toEqual({ total: 2, completed: 1, percent: 50 });
  expect((await service.listGoals(actor.workspaceId)).data.find((r) => r.goal.id === goal.id)?.progress).toEqual(detail.progress);
  expect((await service.goalDetail(actor.workspaceId, child.id)).milestones[0]?.progress.percent).toBe(100);
  await reopenTask(actor, task.id, done.version);
  expect((await service.goalDetail(actor.workspaceId, goal.id)).progress.percent).toBe(0);
});

it('manual milestones count once; manual goal status does not fabricate measured work', async () => {
  const { actor, goal } = await fixture();
  const completedGoal = await service.setGoalStatus(actor, goal.id, 1, 'COMPLETED');
  expect((await service.goalDetail(actor.workspaceId, goal.id)).progress.percent).toBeNull();
  await service.setGoalStatus(actor, goal.id, completedGoal.version, 'ACTIVE');
  const a = await service.createMilestone(actor, goal.id, { title: 'Exam' });
  const b = await service.createMilestone(actor, goal.id, { title: 'Project' });
  await service.setMilestoneStatus(actor, a.id, 1, 'COMPLETED');
  expect((await service.goalDetail(actor.workspaceId, goal.id)).progress).toEqual({ total: 2, completed: 1, percent: 50 });
  await service.setMilestoneStatus(actor, b.id, 1, 'ARCHIVED');
  expect((await service.goalDetail(actor.workspaceId, goal.id)).progress.percent).toBe(100);
});

it('versioned links avoid duplicate events and deleted task links can be removed', async () => {
  const { actor, goal } = await fixture();
  const task = await taskFor(actor);
  const linked = await service.linkGoalTask(actor, goal.id, { version: 1, taskId: task.id, linked: true });
  await expect(service.linkGoalTask(actor, goal.id, { version: 1, taskId: task.id, linked: false })).rejects.toMatchObject({ code: 'RESOURCE_VERSION_CONFLICT' });
  expect((await service.linkGoalTask(actor, goal.id, { version: linked.version, taskId: task.id, linked: true })).version).toBe(linked.version);
  expect(await getDb().select().from(outbox).where(and(eq(outbox.entityId, goal.id), eq(outbox.eventType, 'goal.task_linked')))).toHaveLength(1);
  await deleteTask(actor, task.id);
  const detail = await service.goalDetail(actor.workspaceId, goal.id);
  expect(detail.progress.percent).toBeNull();
  expect(detail.linkedTasks[0]?.title).toBe('Deleted task');
  await service.linkGoalTask(actor, goal.id, { version: linked.version, taskId: task.id, linked: false });
  expect((await service.goalDetail(actor.workspaceId, goal.id)).linkedTasks).toHaveLength(0);
});

it('metadata changes use compare-and-swap and roll back if event/audit writes fail', async () => {
  const { actor, goal } = await fixture();
  const outcomes = await Promise.allSettled(['A', 'B'].map((title) => service.updateGoal(actor, goal.id, { version: 1, title })));
  expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'RESOURCE_VERSION_CONFLICT' } });
  vi.spyOn(events, 'writeAudit').mockRejectedValueOnce(new Error('injected'));
  await expect(service.setGoalStatus(actor, goal.id, 2, 'ARCHIVED')).rejects.toThrow('injected');
  expect(await service.loadGoal(actor.workspaceId, goal.id)).toMatchObject({ status: 'ACTIVE', version: 2 });
  expect(await getDb().select().from(syncChanges).where(and(eq(syncChanges.entityId, goal.id), eq(syncChanges.version, 3)))).toHaveLength(0);
  const audit = await getDb().select().from(auditLogs).where(eq(auditLogs.targetId, goal.id));
  expect(JSON.stringify(audit)).not.toContain('Learn Python');
});

it('archives without changing task work and excludes archived descendants from parent progress', async () => {
  const { actor, goal } = await fixture();
  const child = await service.createGoal(actor, { workspaceId: actor.workspaceId, title: 'Child', priority: 'NONE', parentGoalId: goal.id });
  const task = await taskFor(actor);
  const linked = await service.linkGoalTask(actor, child.id, { taskId: task.id, version: 1, linked: true });
  await service.setGoalStatus(actor, child.id, linked.version, 'ARCHIVED');
  expect((await service.goalDetail(actor.workspaceId, goal.id)).progress.percent).toBeNull();
  expect((await service.listGoals(actor.workspaceId)).data).toHaveLength(1);
  expect((await service.listGoals(actor.workspaceId, { includeArchived: true })).data).toHaveLength(2);
  await expect(service.createMilestone(actor, child.id, { title: 'No' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
});

it('paginates stable goal IDs without dropping or repeating records', async () => {
  const { actor, goal } = await fixture();
  await service.createGoal(actor, { workspaceId: actor.workspaceId, title: 'Second', priority: 'NONE' });
  const first = await service.listGoals(actor.workspaceId, { limit: 1 });
  expect(first.data).toHaveLength(1); expect(first.nextCursor).toBeTruthy();
  const second = await service.listGoals(actor.workspaceId, { limit: 1, after: first.nextCursor! });
  expect(second.data).toHaveLength(1); expect(second.nextCursor).toBeNull();
  expect(new Set([...first.data, ...second.data].map((r) => r.goal.id)).size).toBe(2);
  expect([...first.data, ...second.data].some((r) => r.goal.id === goal.id)).toBe(true);
});

it('account export includes owned hierarchy and links; account purge removes the full graph', async () => {
  const { actor, goal } = await fixture();
  const foreign = await fixture();
  const child = await service.createGoal(actor, { workspaceId: actor.workspaceId, title: 'Child', priority: 'NONE', parentGoalId: goal.id });
  const m = await service.createMilestone(actor, child.id, { title: 'Milestone' });
  const task = await taskFor(actor);
  await service.linkGoalTask(actor, goal.id, { taskId: task.id, version: 1, linked: true });
  await service.linkMilestoneTask(actor, m.id, { taskId: task.id, version: 1, linked: true });
  const bundle = await buildExport(actor.userId);
  expect(bundle.goals).toHaveLength(2); expect(bundle.milestones).toHaveLength(1);
  expect(bundle.goalTasks).toHaveLength(1); expect(bundle.milestoneTasks).toHaveLength(1);
  expect(JSON.stringify(bundle.goals)).not.toContain(foreign.goal.id);
  const cutoff = new Date(Date.now() - 31 * 86400000);
  await getDb().update(users).set({ deletionRequestedAt: cutoff }).where(eq(users.id, actor.userId));
  expect(await purgeAccount(getDb(), actor.userId, cutoff)).toBe(true);
  for (const table of [goals, milestones, goalTasks, milestoneTasks]) expect(await getDb().select().from(table).where(eq(table.workspaceId, actor.workspaceId))).toHaveLength(0);
  expect(await service.loadGoal(foreign.actor.workspaceId, foreign.goal.id)).toBeTruthy();
});
