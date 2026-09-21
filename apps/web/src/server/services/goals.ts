import { and, asc, eq, gt, inArray, max, ne, sql } from 'drizzle-orm';
import {
  AppError, createGoalSchema, createMilestoneSchema, goalQuerySchema, goalStatusSchema,
  notFound, taskLinkSchema, updateGoalSchema, updateMilestoneSchema, uuid, versionConflict,
  type CreateGoalInput, type CreateMilestoneInput, type GoalTaskLinkInput,
  type UpdateGoalInput, type UpdateMilestoneInput,
} from '@nextdoo/contracts';
import { goalTasks, goals, milestoneTasks, milestones, tasks, type Database } from '@nextdoo/db';
import { getDb, withTransaction } from '../db';
import { newId } from '../ids';
import { withWorkspaceTransaction } from './transactions';
import { publishEvent, recordSyncChange, writeAudit } from './events';
import { loadTask } from './tasks';

export interface GoalActor { userId: string; workspaceId: string; requestId?: string; }
type GoalRow = typeof goals.$inferSelect;
type MilestoneRow = typeof milestones.$inferSelect;
type Status = GoalRow['status'];
type Action = 'created' | 'updated' | 'completed' | 'archived' | 'task_linked' | 'task_unlinked';
export interface GoalProgress { percent: number | null; completed: number; total: number; }

function serialise<T extends GoalRow | MilestoneRow>(row: T) {
  return { ...row, ...('startAt' in row ? { startAt: row.startAt?.toISOString() ?? null } : {}),
    dueAt: row.dueAt?.toISOString() ?? null, completedAt: row.completedAt?.toISOString() ?? null,
    archivedAt: row.archivedAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

export async function loadGoal(workspaceId: string, id: string): Promise<GoalRow> {
  uuid.parse(id);
  const [row] = await getDb().select().from(goals).where(and(eq(goals.id, id), eq(goals.workspaceId, workspaceId)));
  if (!row) throw notFound('goal', id);
  return row;
}

async function loadMilestone(workspaceId: string, id: string): Promise<MilestoneRow> {
  uuid.parse(id);
  const [row] = await getDb().select().from(milestones).where(and(eq(milestones.id, id), eq(milestones.workspaceId, workspaceId)));
  if (!row) throw notFound('milestone', id);
  return row;
}

/** Workspace lock covers both ancestor checks and the eventual parent write. */
async function validateParent(db: Database, workspaceId: string, id: string, parentId: string) {
  const parent = await loadGoal(workspaceId, parentId);
  if (parent.status === 'ARCHIVED') throw new AppError('VALIDATION_FAILED', 'Restore the parent goal before adding a sub-goal.');
  const ancestors = await db.execute(sql`WITH RECURSIVE chain(id, parent_goal_id, path) AS (
    SELECT id, parent_goal_id, ARRAY[id] FROM goals WHERE id = ${parentId} AND workspace_id = ${workspaceId}
    UNION ALL SELECT g.id, g.parent_goal_id, c.path || g.id FROM goals g JOIN chain c ON g.id = c.parent_goal_id
      WHERE g.workspace_id = ${workspaceId} AND NOT g.id = ANY(c.path)
  ) SELECT id, cardinality(path) AS depth FROM chain`);
  if (ancestors.some((row) => row.id === id)) throw new AppError('DEPENDENCY_CYCLE', 'A goal cannot be its own ancestor.');
  const descendants = await db.execute(sql`WITH RECURSIVE tree(id, path) AS (
    SELECT id, ARRAY[id] FROM goals WHERE id = ${id} AND workspace_id = ${workspaceId}
    UNION ALL SELECT g.id, t.path || g.id FROM goals g JOIN tree t ON g.parent_goal_id = t.id
      WHERE g.workspace_id = ${workspaceId} AND NOT g.id = ANY(t.path)
  ) SELECT coalesce(max(cardinality(path)), 1) AS depth FROM tree`);
  if (ancestors.length + Number(descendants[0]!.depth) > 20) throw new AppError('VALIDATION_FAILED', 'Goal hierarchies support up to 20 levels.');
}

export async function createGoal(actor: GoalActor, input: CreateGoalInput) {
  input = createGoalSchema.parse(input);
  if (input.workspaceId !== actor.workspaceId) throw new AppError('FORBIDDEN', 'Choose your current workspace.');
  return withWorkspaceTransaction(actor.workspaceId, async (db) => {
    const id = newId();
    if (input.parentGoalId) await validateParent(db, actor.workspaceId, id, input.parentGoalId);
    const [last] = await db.select({ value: max(goals.sequence) }).from(goals).where(eq(goals.workspaceId, actor.workspaceId));
    const sequence = (last?.value ?? 0) + 1;
    const [row] = await db.insert(goals).values({
      id, workspaceId: actor.workspaceId, sequence, identifier: `G${sequence}`,
      parentGoalId: input.parentGoalId ?? null, title: input.title, description: input.description ?? null,
      category: input.category ?? null, priority: input.priority,
      startAt: input.startAt ? new Date(input.startAt) : null, dueAt: input.dueAt ? new Date(input.dueAt) : null,
    }).returning();
    await recordChange(db, actor, 'goal', row!, 'created', ['title', 'description', 'category', 'priority', 'startAt', 'dueAt', 'parentGoalId']);
    return serialise(row!);
  });
}

export async function updateGoal(actor: GoalActor, id: string, input: UpdateGoalInput) {
  input = updateGoalSchema.parse(input);
  return withWorkspaceTransaction(actor.workspaceId, async (db) => {
    const current = await loadGoal(actor.workspaceId, id);
    if (current.version !== input.version) throw versionConflict('goal', id);
    if (input.parentGoalId && input.parentGoalId !== current.parentGoalId) await validateParent(db, actor.workspaceId, id, input.parentGoalId);
    const startAt = input.startAt === undefined ? current.startAt : input.startAt ? new Date(input.startAt) : null;
    const dueAt = input.dueAt === undefined ? current.dueAt : input.dueAt ? new Date(input.dueAt) : null;
    if (startAt && dueAt && startAt > dueAt) throw new AppError('VALIDATION_FAILED', 'Start date must not be after the target date.');
    const { version, ...fields } = input;
    const [row] = await db.update(goals).set({ ...fields, startAt, dueAt, version: version + 1, updatedAt: new Date() })
      .where(and(eq(goals.id, id), eq(goals.workspaceId, actor.workspaceId), eq(goals.version, version))).returning();
    if (!row) throw versionConflict('goal', id);
    await recordChange(db, actor, 'goal', row, 'updated', Object.keys(fields));
    return serialise(row);
  });
}

export async function setGoalStatus(actor: GoalActor, id: string, version: number, status: Status) {
  goalStatusSchema.parse({ version, status });
  return withWorkspaceTransaction(actor.workspaceId, async (db) => {
    const current = await loadGoal(actor.workspaceId, id);
    if (current.version !== version) throw versionConflict('goal', id);
    if (current.status === status) return serialise(current);
    const [row] = await db.update(goals).set(statusPatch(version, status)).where(and(eq(goals.id, id), eq(goals.workspaceId, actor.workspaceId))).returning();
    await recordChange(db, actor, 'goal', row!, status === 'ACTIVE' ? 'updated' : status === 'COMPLETED' ? 'completed' : 'archived', ['status']);
    return serialise(row!);
  });
}

export async function createMilestone(actor: GoalActor, goalId: string, input: CreateMilestoneInput) {
  input = createMilestoneSchema.parse(input);
  return withWorkspaceTransaction(actor.workspaceId, async (db) => {
    const goal = await loadGoal(actor.workspaceId, goalId);
    if (goal.status !== 'ACTIVE') throw new AppError('VALIDATION_FAILED', 'Reopen the goal before adding milestones.');
    const [last] = await db.select({ value: max(milestones.sequence) }).from(milestones).where(and(eq(milestones.goalId, goalId), eq(milestones.workspaceId, actor.workspaceId)));
    const sequence = (last?.value ?? 0) + 1;
    const [row] = await db.insert(milestones).values({ id: newId(), workspaceId: actor.workspaceId, goalId, sequence,
      identifier: `${goal.identifier}.M${sequence}`, title: input.title, description: input.description ?? null,
      dueAt: input.dueAt ? new Date(input.dueAt) : null }).returning();
    await recordChange(db, actor, 'milestone', row!, 'created', ['title', 'description', 'dueAt']);
    return serialise(row!);
  });
}

export async function updateMilestone(actor: GoalActor, id: string, input: UpdateMilestoneInput) {
  input = updateMilestoneSchema.parse(input);
  return withWorkspaceTransaction(actor.workspaceId, async (db) => {
    const current = await loadMilestone(actor.workspaceId, id);
    if (current.version !== input.version) throw versionConflict('milestone', id);
    const { version, dueAt, ...fields } = input;
    const [row] = await db.update(milestones).set({ ...fields, ...(dueAt !== undefined ? { dueAt: dueAt ? new Date(dueAt) : null } : {}), version: version + 1, updatedAt: new Date() })
      .where(and(eq(milestones.id, id), eq(milestones.workspaceId, actor.workspaceId))).returning();
    await recordChange(db, actor, 'milestone', row!, 'updated', Object.keys(input).filter((key) => key !== 'version'));
    return serialise(row!);
  });
}

export async function setMilestoneStatus(actor: GoalActor, id: string, version: number, status: Status) {
  goalStatusSchema.parse({ version, status });
  return withWorkspaceTransaction(actor.workspaceId, async (db) => {
    const current = await loadMilestone(actor.workspaceId, id);
    if (current.version !== version) throw versionConflict('milestone', id);
    if (current.status === status) return serialise(current);
    const [row] = await db.update(milestones).set(statusPatch(version, status)).where(and(eq(milestones.id, id), eq(milestones.workspaceId, actor.workspaceId))).returning();
    await recordChange(db, actor, 'milestone', row!, status === 'ACTIVE' ? 'updated' : status === 'COMPLETED' ? 'completed' : 'archived', ['status']);
    return serialise(row!);
  });
}

function statusPatch(version: number, status: Status) {
  const now = new Date();
  return { status, completedAt: status === 'COMPLETED' ? now : null, archivedAt: status === 'ARCHIVED' ? now : null, version: version + 1, updatedAt: now };
}

/** Links are explicit online commands; no task lifecycle or scoring history is changed. */
export async function linkGoalTask(actor: GoalActor, id: string, input: GoalTaskLinkInput) {
  input = taskLinkSchema.parse(input);
  return withWorkspaceTransaction(actor.workspaceId, async (db) => {
    const current = await loadGoal(actor.workspaceId, id);
    if (current.version !== input.version) throw versionConflict('goal', id);
    if (input.linked) {
      if (current.status !== 'ACTIVE') throw new AppError('VALIDATION_FAILED', 'Reopen the goal before linking tasks.');
      await loadTask(actor.workspaceId, input.taskId);
    }
    const changed = input.linked
      ? await db.insert(goalTasks).values({ workspaceId: actor.workspaceId, goalId: id, taskId: input.taskId }).onConflictDoNothing().returning()
      : await db.delete(goalTasks).where(and(eq(goalTasks.workspaceId, actor.workspaceId), eq(goalTasks.goalId, id), eq(goalTasks.taskId, input.taskId))).returning();
    if (!changed.length) return serialise(current);
    const [row] = await db.update(goals).set({ version: current.version + 1, updatedAt: new Date() }).where(eq(goals.id, id)).returning();
    await recordChange(db, actor, 'goal', row!, input.linked ? 'task_linked' : 'task_unlinked', ['taskId'], { taskId: input.taskId, linked: input.linked });
    return serialise(row!);
  });
}

export async function linkMilestoneTask(actor: GoalActor, id: string, input: GoalTaskLinkInput) {
  input = taskLinkSchema.parse(input);
  return withWorkspaceTransaction(actor.workspaceId, async (db) => {
    const current = await loadMilestone(actor.workspaceId, id);
    if (current.version !== input.version) throw versionConflict('milestone', id);
    if (input.linked) {
      const goal = await loadGoal(actor.workspaceId, current.goalId);
      if (current.status !== 'ACTIVE' || goal.status !== 'ACTIVE') throw new AppError('VALIDATION_FAILED', 'Reopen the goal and milestone before linking tasks.');
      await loadTask(actor.workspaceId, input.taskId);
    }
    const changed = input.linked
      ? await db.insert(milestoneTasks).values({ workspaceId: actor.workspaceId, milestoneId: id, taskId: input.taskId }).onConflictDoNothing().returning()
      : await db.delete(milestoneTasks).where(and(eq(milestoneTasks.workspaceId, actor.workspaceId), eq(milestoneTasks.milestoneId, id), eq(milestoneTasks.taskId, input.taskId))).returning();
    if (!changed.length) return serialise(current);
    const [row] = await db.update(milestones).set({ version: current.version + 1, updatedAt: new Date() }).where(eq(milestones.id, id)).returning();
    await recordChange(db, actor, 'milestone', row!, input.linked ? 'task_linked' : 'task_unlinked', ['taskId'], { taskId: input.taskId, linked: input.linked });
    return serialise(row!);
  });
}

/** Each task counts once across the subtree; empty milestones use manual completion.
 * Manual goal completion never fabricates measured progress. */
async function progressFor(db: Database, workspaceId: string, ids: string[]): Promise<Map<string, GoalProgress>> {
  if (!ids.length) return new Map();
  const roots = sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
  const rows = await db.execute(sql`WITH RECURSIVE tree(root, id, path) AS (
    SELECT id, id, ARRAY[id] FROM goals WHERE workspace_id = ${workspaceId} AND id IN (${roots})
    UNION ALL SELECT t.root, g.id, t.path || g.id FROM goals g JOIN tree t ON g.parent_goal_id = t.id
      WHERE g.workspace_id = ${workspaceId} AND g.status <> 'ARCHIVED' AND NOT g.id = ANY(t.path)
  ), active_milestones AS (
    SELECT t.root, m.id, m.status FROM tree t JOIN milestones m ON m.goal_id = t.id
      WHERE m.workspace_id = ${workspaceId} AND m.status <> 'ARCHIVED'
  ), task_units AS (
    SELECT t.root, task.id, (task.completed_at IS NOT NULL) AS done FROM tree t
      JOIN goal_tasks l ON l.goal_id = t.id AND l.workspace_id = ${workspaceId}
      JOIN tasks task ON task.id = l.task_id AND task.workspace_id = ${workspaceId} AND task.status <> 'DELETED'
    UNION
    SELECT m.root, task.id, (task.completed_at IS NOT NULL) AS done FROM active_milestones m
      JOIN milestone_tasks l ON l.milestone_id = m.id AND l.workspace_id = ${workspaceId}
      JOIN tasks task ON task.id = l.task_id AND task.workspace_id = ${workspaceId} AND task.status <> 'DELETED'
  ), units AS (
    SELECT root, id, done FROM task_units
    UNION ALL SELECT m.root, m.id, m.status = 'COMPLETED' FROM active_milestones m WHERE NOT EXISTS (
      SELECT 1 FROM milestone_tasks l JOIN tasks task ON task.id = l.task_id AND task.workspace_id = ${workspaceId}
        WHERE l.milestone_id = m.id AND l.workspace_id = ${workspaceId} AND task.status <> 'DELETED'
    )
  ) SELECT root, count(*) AS total, count(*) FILTER (WHERE done) AS completed FROM units GROUP BY root`);
  return new Map(ids.map((id) => {
    const row = rows.find((r) => r.root === id);
    const total = Number(row?.total ?? 0), completed = Number(row?.completed ?? 0);
    return [id, { total, completed, percent: total ? Math.round(100 * completed / total) : null }];
  }));
}

export async function listGoals(workspaceId: string, query: { includeArchived?: boolean; limit?: number; after?: string } = {}) {
  const input = goalQuerySchema.parse(query);
  return withTransaction(async (db) => {
    const rows = await db.select().from(goals).where(and(eq(goals.workspaceId, workspaceId),
      input.includeArchived ? undefined : ne(goals.status, 'ARCHIVED'), input.after ? gt(goals.id, input.after) : undefined))
      .orderBy(asc(goals.id)).limit(input.limit + 1);
    const visible = rows.slice(0, input.limit);
    const progress = await progressFor(db, workspaceId, visible.map((g) => g.id));
    return { data: visible.map((goal) => ({ goal: serialise(goal), progress: progress.get(goal.id)! })),
      nextCursor: rows.length > input.limit ? visible.at(-1)!.id : null };
  }, { isolationLevel: 'repeatable read' });
}

export async function goalDetail(workspaceId: string, id: string) {
  return withTransaction(async (db) => {
    const goal = await loadGoal(workspaceId, id);
    const milestoneRows = await db.select().from(milestones).where(and(eq(milestones.goalId, id), eq(milestones.workspaceId, workspaceId))).orderBy(asc(milestones.sequence));
    const children = await db.select().from(goals).where(and(eq(goals.parentGoalId, id), eq(goals.workspaceId, workspaceId))).orderBy(asc(goals.sequence));
    const direct = await db.select().from(goalTasks).where(and(eq(goalTasks.goalId, id), eq(goalTasks.workspaceId, workspaceId)));
    const links = milestoneRows.length ? await db.select().from(milestoneTasks).where(and(eq(milestoneTasks.workspaceId, workspaceId), inArray(milestoneTasks.milestoneId, milestoneRows.map((m) => m.id)))) : [];
    const taskIds = [...new Set([...direct, ...links].map((l) => l.taskId))];
    const linkedTasks = taskIds.length ? await db.select({ id: tasks.id, title: tasks.title, status: tasks.status, completedAt: tasks.completedAt }).from(tasks)
      .where(and(eq(tasks.workspaceId, workspaceId), inArray(tasks.id, taskIds))) : [];
    const progress = await progressFor(db, workspaceId, [id]);
    return { goal: serialise(goal), progress: progress.get(id)!, parent: goal.parentGoalId ? serialise(await loadGoal(workspaceId, goal.parentGoalId)) : null,
      children: children.map(serialise), taskIds: direct.map((l) => l.taskId),
      linkedTasks: linkedTasks.map((t) => ({ ...t, title: t.status === 'DELETED' ? 'Deleted task' : t.title, completedAt: t.completedAt?.toISOString() ?? null })),
      milestones: milestoneRows.map((m) => {
        const taskIds = links.filter((l) => l.milestoneId === m.id).map((l) => l.taskId);
        const visible = linkedTasks.filter((t) => taskIds.includes(t.id) && t.status !== 'DELETED');
        const total = visible.length || 1, completed = visible.length ? visible.filter((t) => t.completedAt !== null).length : Number(m.status === 'COMPLETED');
        return { ...serialise(m), taskIds, progress: { total, completed, percent: Math.round(100 * completed / total) } };
      }) };
  }, { isolationLevel: 'repeatable read' });
}

async function recordChange(db: Database, actor: GoalActor, kind: 'goal' | 'milestone', row: GoalRow | MilestoneRow, action: Action, fields: string[], relation?: { taskId: string; linked: boolean }) {
  const metadata = { fields, version: row.version, ...(relation ? { relation } : {}) };
  await recordSyncChange(db, { workspaceId: actor.workspaceId, entityType: kind, entityId: row.id, operation: action === 'created' ? 'create' : 'update', version: row.version, payload: { ...serialise(row), ...(relation ? { relation } : {}) } });
  await publishEvent(db, { workspaceId: actor.workspaceId, actorId: actor.userId, entityType: kind, entityId: row.id, eventType: `${kind}.${action}`, correlationId: actor.requestId, payload: metadata });
  await writeAudit(db, { workspaceId: actor.workspaceId, actorId: actor.userId, targetType: kind, targetId: row.id, action: `${kind}.${action}`, requestId: actor.requestId, metadata });
}
