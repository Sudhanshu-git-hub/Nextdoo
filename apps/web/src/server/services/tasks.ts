import { createTag } from './projects';
import { and, desc, eq, gte, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import {
  AppError,
  type CreateTaskInput,
  type TaskQueryInput,
  type UpdateTaskInput,
  notFound,
  versionConflict,
} from '@nextdoo/contracts';
import { nextStatus } from '@nextdoo/core';
import { projects, tasks, taskTags, syncTombstones } from '@nextdoo/db';
import { getDb } from '../db';
import { newId } from '../ids';
import { appendTrackingEvent, publishEvent, recordSyncChange, writeAudit } from './events';
import { scheduleTrackingEvaluation } from './tracking';
import { assertTaskReferences } from './task-references';
import { withWorkspaceTransaction } from './transactions';
import { enforceTaskLimit } from './entitlements';

/**
 * Task domain service (PRD §6.3).
 *
 * Every mutation:
 *  - runs in a transaction with its tracking event, sync change and outbox entry
 *  - enforces optimistic locking via `version`
 *  - is scoped to a workspace the caller has already been authorised for
 */

export interface TaskActor {
  userId: string;
  workspaceId: string;
  requestId?: string;
  deviceId?: string | null;
}

export type TaskRow = typeof tasks.$inferSelect;

function serialise(task: TaskRow) {
  return {
    id: task.id,
    workspaceId: task.workspaceId,
    projectId: task.projectId,
    sectionId: task.sectionId,
    parentTaskId: task.parentTaskId,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    dueAt: task.dueAt?.toISOString() ?? null,
    timeZone: task.timeZone,
    estimateMinutes: task.estimateMinutes,
    actualMinutes: task.actualMinutes,
    actualSeconds: task.actualMinutes * 60 + task.actualSecondsRemainder,
    position: Number(task.position),
    rescheduleCount: task.rescheduleCount,
    version: task.version,
    completedAt: task.completedAt?.toISOString() ?? null,
    archivedAt: task.archivedAt?.toISOString() ?? null,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  };
}

export type SerialisedTask = ReturnType<typeof serialise>;

/** Loads a task, enforcing workspace scope. Never leaks cross-workspace rows. */
export async function loadTask(workspaceId: string, taskId: string): Promise<TaskRow> {
  const db = getDb();
  const rows = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, workspaceId)))
    .limit(1);
  const row = rows[0];
  if (!row || row.status === 'DELETED') throw notFound('task', taskId);
  return row;
}

export async function createTask(actor: TaskActor, input: CreateTaskInput, options: { id?: string } = {}): Promise<SerialisedTask> {
  const id = options.id ?? newId();
  const now = new Date();

  return withWorkspaceTransaction(actor.workspaceId, async (tx) => {
    if (input.recurrenceRule) throw new AppError('VALIDATION_FAILED', 'Recurring task creation is not implemented yet. No task was created.');
    await enforceTaskLimit(actor.userId, actor.workspaceId);
    if (input.projectName !== undefined) {
      if (input.projectId) throw new AppError('VALIDATION_FAILED', 'Choose a project ID or a project name, not both.');
      const matches = await tx.select({ id: projects.id }).from(projects).where(and(
        eq(projects.workspaceId, actor.workspaceId), eq(projects.status, 'ACTIVE'), isNull(projects.deletedAt),
        sql`lower(${projects.name}) = lower(${input.projectName})`,
      )).limit(2);
      if (matches.length !== 1) throw new AppError('VALIDATION_FAILED', 'Project name is missing or ambiguous. Create it in Projects, or remove +project and assign it with the task editor. No task was created.');
      input = { ...input, projectId: matches[0]!.id };
    }
    await assertTaskReferences(tx, actor.workspaceId, input);
    const tagIds = await resolveTags(actor.workspaceId, input.tagIds, input.tagNames);
    input = { ...input, tagIds };
    // Parent must live in the same workspace — prevents cross-tenant nesting.
    if (input.parentTaskId) {
      const parent = await tx
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.id, input.parentTaskId), eq(tasks.workspaceId, actor.workspaceId)))
        .limit(1);
      if (!parent[0]) throw notFound('task', input.parentTaskId);
    }

    const [created] = await tx
      .insert(tasks)
      .values({
        id,
        workspaceId: actor.workspaceId,
        projectId: input.projectId ?? null,
        sectionId: input.sectionId ?? null,
        parentTaskId: input.parentTaskId ?? null,
        title: input.title,
        description: input.description ?? null,
        priority: input.priority,
        dueAt: input.dueAt ? new Date(input.dueAt) : null,
        timeZone: input.timeZone ?? null,
        estimateMinutes: input.estimateMinutes ?? null,
        position: String(now.getTime()),
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    if (!created) throw new AppError('INTERNAL_ERROR', 'Task could not be created.');

    if (input.tagIds.length) {
      await tx.insert(taskTags).values(input.tagIds.map((tagId) => ({ taskId: id, tagId }))).onConflictDoNothing();
    }

    await appendTrackingEvent(tx, {
      workspaceId: actor.workspaceId,
      taskId: id,
      type: 'TASK_CREATED',
      actorId: actor.userId,
      occurredAt: now,
      deviceId: actor.deviceId ?? null,
      payload: { hasDueDate: Boolean(input.dueAt), hasEstimate: input.estimateMinutes != null },
    });

    // A task created with a due date is also "planned" — that distinction matters
    // for measuring whether users plan up front or retrofit dates later.
    if (input.dueAt) {
      await appendTrackingEvent(tx, {
        workspaceId: actor.workspaceId,
        taskId: id,
        type: 'TASK_PLANNED',
        actorId: actor.userId,
        occurredAt: now,
        payload: { dueAt: input.dueAt },
      });
    }

    await recordSyncChange(tx, {
      workspaceId: actor.workspaceId,
      entityType: 'task',
      entityId: id,
      operation: 'create',
      payload: { ...serialise(created), tagIds: input.tagIds },
      version: created.version,
      deviceId: actor.deviceId ?? null,
    });
    await publishEvent(tx, {
      eventType: 'task.created',
      workspaceId: actor.workspaceId,
      actorId: actor.userId,
      entityType: 'task',
      entityId: id,
      correlationId: actor.requestId ?? null,
    });
    await writeAudit(tx, {
      workspaceId: actor.workspaceId,
      actorId: actor.userId,
      action: 'task.created',
      targetType: 'task',
      targetId: id,
      requestId: actor.requestId ?? null,
    });

    return { ...serialise(created), tagIds: input.tagIds };
  });
}

export async function updateTask(
  actor: TaskActor,
  taskId: string,
  input: UpdateTaskInput,
): Promise<SerialisedTask> {

  return withWorkspaceTransaction(actor.workspaceId, async (tx) => {
    const rows = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, actor.workspaceId)))
      .limit(1);
    const current = rows[0];
    if (!current || current.status === 'DELETED') throw notFound('task', taskId);

    // Optimistic lock (PRD §6.3 acceptance criteria).
    if (current.version !== input.version) throw versionConflict('task', taskId);

    await assertTaskReferences(tx, actor.workspaceId, input, current.projectId);
    if (input.tagNames !== undefined) input = { ...input, tagIds: await resolveTags(actor.workspaceId, input.tagIds ?? [], input.tagNames) };
    const patch: Partial<typeof tasks.$inferInsert> = { updatedAt: new Date() };
    if (input.projectId !== undefined && input.projectId !== current.projectId && input.sectionId === undefined) patch.sectionId = null;
    if (input.title !== undefined) patch.title = input.title;
    if (input.description !== undefined) patch.description = input.description ?? null;
    if (input.projectId !== undefined) patch.projectId = input.projectId ?? null;
    if (input.sectionId !== undefined) patch.sectionId = input.sectionId ?? null;
    if (input.priority !== undefined) patch.priority = input.priority;
    if (input.timeZone !== undefined) patch.timeZone = input.timeZone ?? null;
    if (input.position !== undefined) patch.position = String(input.position);
    if (input.dueAt !== undefined) patch.dueAt = input.dueAt ? new Date(input.dueAt) : null;
    if (input.estimateMinutes !== undefined) patch.estimateMinutes = input.estimateMinutes ?? null;

    const dueChanged = input.dueAt !== undefined && (input.dueAt ?? null) !== (current.dueAt?.toISOString() ?? null);
    if (dueChanged && current.dueAt) patch.rescheduleCount = current.rescheduleCount + 1;
    const [updated] = await tx
      .update(tasks)
      .set({ ...patch, version: sql`${tasks.version} + 1` })
      .where(and(eq(tasks.id, taskId), eq(tasks.version, input.version)))
      .returning();

    // Lost the race between SELECT and UPDATE.
    if (!updated) throw versionConflict('task', taskId);

    if (input.tagIds) {
      await tx.delete(taskTags).where(eq(taskTags.taskId, taskId));
      if (input.tagIds.length) {
        await tx.insert(taskTags).values(input.tagIds.map((tagId) => ({ taskId, tagId }))).onConflictDoNothing();
      }
    }

    if (dueChanged) {
      await appendTrackingEvent(tx, { workspaceId: actor.workspaceId, taskId, actorId: actor.userId,
        type: current.dueAt ? 'TASK_RESCHEDULED' : 'TASK_PLANNED', payload: { from: current.dueAt?.toISOString() ?? null, to: input.dueAt ?? null } });
      await rescheduleRelativeReminders(taskId, updated.dueAt);
    }
    const estimateChanged =
      input.estimateMinutes !== undefined && input.estimateMinutes !== current.estimateMinutes;
    if (estimateChanged) {
      await appendTrackingEvent(tx, {
        workspaceId: actor.workspaceId,
        taskId,
        type: 'ESTIMATE_CHANGED',
        actorId: actor.userId,
        payload: { from: current.estimateMinutes, to: input.estimateMinutes },
      });
    }

    await recordSyncChange(tx, {
      workspaceId: actor.workspaceId,
      entityType: 'task',
      entityId: taskId,
      operation: 'update',
      payload: { ...serialise(updated), ...(input.tagIds !== undefined ? { tagIds: input.tagIds } : {}) } as unknown as Record<string, unknown>,
      version: updated.version,
      deviceId: actor.deviceId ?? null,
    });
    await publishEvent(tx, {
      eventType: 'task.updated',
      workspaceId: actor.workspaceId,
      actorId: actor.userId,
      entityType: 'task',
      entityId: taskId,
      correlationId: actor.requestId ?? null,
      payload: { fields: [...Object.keys(patch).filter((k) => k !== 'updatedAt'), ...(input.tagIds !== undefined ? ['tagIds'] : [])] },
    });

    await scheduleTrackingEvaluation(actor.workspaceId, taskId);
    return serialise(updated);
  });
}

export async function completeTask(
  actor: TaskActor,
  taskId: string,
  version: number,
  completedAt?: string,
): Promise<SerialisedTask> {
  const when = completedAt ? new Date(completedAt) : new Date();

  return withWorkspaceTransaction(actor.workspaceId, async (tx) => {
    const rows = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, actor.workspaceId)))
      .limit(1);
    const current = rows[0];
    if (!current || current.status === 'DELETED') throw notFound('task', taskId);
    if (current.version !== version) throw versionConflict('task', taskId);

    // Throws if the transition is not legal for the current status.
    const target = nextStatus(current.status, 'complete');

    const [updated] = await tx
      .update(tasks)
      .set({
        status: target as 'COMPLETED',
        completedAt: when,
        updatedAt: new Date(),
        version: sql`${tasks.version} + 1`,
      })
      .where(and(eq(tasks.id, taskId), eq(tasks.version, version)))
      .returning();
    if (!updated) throw versionConflict('task', taskId);

    await appendTrackingEvent(tx, {
      workspaceId: actor.workspaceId,
      taskId,
      type: 'TASK_COMPLETED',
      actorId: actor.userId,
      occurredAt: when,
      deviceId: actor.deviceId ?? null,
      payload: { dueAt: current.dueAt?.toISOString() ?? null },
      // Deterministic: replaying the same completion cannot create a second event.
      idempotencyKey: `complete:${taskId}:${when.toISOString()}`,
    });

    await recordSyncChange(tx, {
      workspaceId: actor.workspaceId,
      entityType: 'task',
      entityId: taskId,
      operation: 'update',
      payload: serialise(updated) as unknown as Record<string, unknown>,
      version: updated.version,
      deviceId: actor.deviceId ?? null,
    });
    await publishEvent(tx, {
      eventType: 'task.completed',
      workspaceId: actor.workspaceId,
      actorId: actor.userId,
      entityType: 'task',
      entityId: taskId,
      correlationId: actor.requestId ?? null,
    });
    await writeAudit(tx, {
      workspaceId: actor.workspaceId,
      actorId: actor.userId,
      action: 'task.completed',
      targetType: 'task',
      targetId: taskId,
      requestId: actor.requestId ?? null,
    });

    await cancelRemindersForTask(taskId);
    await scheduleTrackingEvaluation(actor.workspaceId, taskId);
    return serialise(updated);
  });

}

export async function reopenTask(actor: TaskActor, taskId: string, version: number): Promise<SerialisedTask> {
  return withWorkspaceTransaction(actor.workspaceId, async (tx) => {
    const rows = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, actor.workspaceId)))
      .limit(1);
    const current = rows[0];
    if (!current) throw notFound('task', taskId);
    if (current.version !== version) throw versionConflict('task', taskId);
    nextStatus(current.status, 'reopen');
    await enforceTaskLimit(actor.userId, actor.workspaceId);

    const [updated] = await tx
      .update(tasks)
      .set({ status: 'ACTIVE', completedAt: null, updatedAt: new Date(), version: sql`${tasks.version} + 1` })
      .where(and(eq(tasks.id, taskId), eq(tasks.version, version)))
      .returning();
    if (!updated) throw versionConflict('task', taskId);

    await appendTrackingEvent(tx, {
      workspaceId: actor.workspaceId,
      taskId,
      type: 'TASK_REOPENED',
      actorId: actor.userId,
    });
    await recordSyncChange(tx, {
      workspaceId: actor.workspaceId,
      entityType: 'task',
      entityId: taskId,
      operation: 'update',
      payload: serialise(updated) as unknown as Record<string, unknown>,
      version: updated.version,
    });
    await publishEvent(tx, {
      eventType: 'task.reopened',
      workspaceId: actor.workspaceId,
      actorId: actor.userId,
      entityType: 'task',
      entityId: taskId,
    });
    await scheduleTrackingEvaluation(actor.workspaceId, taskId);
    return serialise(updated);
  });
}

export async function rescheduleTask(
  actor: TaskActor,
  taskId: string,
  version: number,
  dueAt: string | null,
  reason?: string,
): Promise<SerialisedTask> {
  return withWorkspaceTransaction(actor.workspaceId, async (tx) => {
    const rows = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, actor.workspaceId)))
      .limit(1);
    const current = rows[0];
    if (!current || current.status === 'DELETED') throw notFound('task', taskId);
    if (current.version !== version) throw versionConflict('task', taskId);

    const [updated] = await tx
      .update(tasks)
      .set({
        dueAt: dueAt ? new Date(dueAt) : null,
        // Drives the RESCHEDULED outcome and the "frequently rescheduled" analytic.
        rescheduleCount: sql`${tasks.rescheduleCount} + 1`,
        updatedAt: new Date(),
        version: sql`${tasks.version} + 1`,
      })
      .where(and(eq(tasks.id, taskId), eq(tasks.version, version)))
      .returning();
    if (!updated) throw versionConflict('task', taskId);

    await appendTrackingEvent(tx, {
      workspaceId: actor.workspaceId,
      taskId,
      type: 'TASK_RESCHEDULED',
      actorId: actor.userId,
      payload: { from: current.dueAt?.toISOString() ?? null, to: dueAt, reason: reason ?? null },
    });
    await recordSyncChange(tx, {
      workspaceId: actor.workspaceId,
      entityType: 'task',
      entityId: taskId,
      operation: 'update',
      payload: serialise(updated) as unknown as Record<string, unknown>,
      version: updated.version,
    });
    await publishEvent(tx, {
      eventType: 'task.rescheduled',
      workspaceId: actor.workspaceId,
      actorId: actor.userId,
      entityType: 'task',
      entityId: taskId,
    });
    await rescheduleRelativeReminders(taskId, updated.dueAt);
    await scheduleTrackingEvaluation(actor.workspaceId, taskId);
    return serialise(updated);
  });
}

export async function archiveTask(actor: TaskActor, taskId: string, version: number): Promise<SerialisedTask> {
  return withWorkspaceTransaction(actor.workspaceId, async (tx) => {
    const rows = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, actor.workspaceId)))
      .limit(1);
    const current = rows[0];
    if (!current) throw notFound('task', taskId);
    if (current.version !== version) throw versionConflict('task', taskId);
    nextStatus(current.status, 'archive');

    const [updated] = await tx
      .update(tasks)
      .set({ status: 'ARCHIVED', archivedAt: new Date(), updatedAt: new Date(), version: sql`${tasks.version} + 1` })
      .where(and(eq(tasks.id, taskId), eq(tasks.version, version)))
      .returning();
    if (!updated) throw versionConflict('task', taskId);

    await appendTrackingEvent(tx, {
      workspaceId: actor.workspaceId,
      taskId,
      type: 'TASK_ARCHIVED',
      actorId: actor.userId,
    });
    await recordSyncChange(tx, {
      workspaceId: actor.workspaceId,
      entityType: 'task',
      entityId: taskId,
      operation: 'update',
      payload: serialise(updated) as unknown as Record<string, unknown>,
      version: updated.version,
    });
    await scheduleTrackingEvaluation(actor.workspaceId, taskId);
    return serialise(updated);
  });
}

/** Soft delete with a tombstone and a 30-day restore window (PRD §13.5). */
export async function deleteTask(actor: TaskActor, taskId: string): Promise<void> {
  await withWorkspaceTransaction(actor.workspaceId, async (tx) => {
    const rows = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, actor.workspaceId)))
      .limit(1);
    const current = rows[0];
    if (!current) throw notFound('task', taskId);
    if (current.status === 'DELETED') return;

    const now = new Date();
    await tx
      .update(tasks)
      .set({ status: 'DELETED', deletedAt: now, updatedAt: now, version: sql`${tasks.version} + 1` })
      .where(eq(tasks.id, taskId));

    await tx
      .insert(syncTombstones)
      .values({
        id: newId(),
        workspaceId: actor.workspaceId,
        entityType: 'task',
        entityId: taskId,
        deletedAt: now,
        purgeAfter: new Date(now.getTime() + 30 * 86_400_000),
      })
      .onConflictDoNothing();

    await recordSyncChange(tx, {
      workspaceId: actor.workspaceId,
      entityType: 'task',
      entityId: taskId,
      operation: 'delete',
      payload: { id: taskId },
      version: current.version + 1,
    });
    await publishEvent(tx, {
      eventType: 'task.deleted',
      workspaceId: actor.workspaceId,
      actorId: actor.userId,
      entityType: 'task',
      entityId: taskId,
    });
    await writeAudit(tx, {
      workspaceId: actor.workspaceId,
      actorId: actor.userId,
      action: 'task.deleted',
      targetType: 'task',
      targetId: taskId,
      requestId: actor.requestId ?? null,
    });
    await cancelRemindersForTask(taskId);
  });
}

export async function restoreTask(actor: TaskActor, taskId: string): Promise<SerialisedTask> {
  return withWorkspaceTransaction(actor.workspaceId, async (tx) => {
    const rows = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, actor.workspaceId)))
      .limit(1);
    const current = rows[0];
    if (!current) throw notFound('task', taskId);
    nextStatus(current.status, 'restore');
    if (current.status === 'DELETED' && (!current.deletedAt || current.deletedAt.getTime() <= Date.now() - 30 * 86400000)) throw new AppError('VALIDATION_FAILED', 'The restore window has expired.');
    await enforceTaskLimit(actor.userId, actor.workspaceId);

    const [updated] = await tx
      .update(tasks)
      .set({
        status: 'ACTIVE',
        completedAt: null,
        deletedAt: null,
        archivedAt: null,
        updatedAt: new Date(),
        version: sql`${tasks.version} + 1`,
      })
      .where(eq(tasks.id, taskId))
      .returning();
    if (!updated) throw notFound('task', taskId);

    await tx
      .delete(syncTombstones)
      .where(and(eq(syncTombstones.entityType, 'task'), eq(syncTombstones.entityId, taskId)));

    await recordSyncChange(tx, {
      workspaceId: actor.workspaceId,
      entityType: 'task',
      entityId: taskId,
      operation: 'update',
      payload: serialise(updated) as unknown as Record<string, unknown>,
      version: updated.version,
    });
    await publishEvent(tx, {
      eventType: 'task.restored',
      workspaceId: actor.workspaceId,
      actorId: actor.userId,
      entityType: 'task',
      entityId: taskId,
    });
    await scheduleTrackingEvaluation(actor.workspaceId, taskId);
    return serialise(updated);
  });
}

/** Cursor-paginated task query with full-text search (PRD §14.7). */
export async function queryTasks(
  workspaceId: string,
  query: TaskQueryInput,
): Promise<{ data: SerialisedTask[]; nextCursor: string | null; hasMore: boolean }> {
  const db = getDb();
  const conditions = [eq(tasks.workspaceId, workspaceId), isNull(tasks.deletedAt)];

  if (query.status) conditions.push(eq(tasks.status, query.status));
  else if (!query.includeArchived) conditions.push(inArray(tasks.status, ['ACTIVE', 'COMPLETED']));

  if (query.tagId) conditions.push(inArray(tasks.id, db.select({ id: taskTags.taskId }).from(taskTags).where(eq(taskTags.tagId, query.tagId))));
  if (query.unfiled && query.projectId) throw new AppError('VALIDATION_FAILED', 'Choose unfiled tasks or a project, not both.');
  if (query.unfiled) conditions.push(isNull(tasks.projectId));
  if (query.projectId) conditions.push(eq(tasks.projectId, query.projectId));
  if (query.dueBefore) conditions.push(lte(tasks.dueAt, new Date(query.dueBefore)));
  if (query.dueAfter) conditions.push(gte(tasks.dueAt, new Date(query.dueAfter)));
  if (query.q) {
    conditions.push(
      sql`to_tsvector('simple', coalesce(${tasks.title},'') || ' ' || coalesce(${tasks.description},'')) @@ plainto_tsquery('simple', ${query.q})`,
    );
  }

  // Keyset pagination on (createdAt, id) — stable under concurrent inserts.
  if (query.cursor) {
    try {
      const decoded = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')) as {
        c: string;
        i: string;
      };
      conditions.push(
        or(lt(tasks.createdAt, new Date(decoded.c)), and(eq(tasks.createdAt, new Date(decoded.c)), lt(tasks.id, decoded.i)))!,
      );
    } catch {
      throw new AppError('VALIDATION_FAILED', 'Malformed pagination cursor.');
    }
  }

  const rows = await db
    .select()
    .from(tasks)
    .where(and(...conditions))
    .orderBy(desc(tasks.createdAt), desc(tasks.id))
    .limit(query.limit + 1);

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last
      ? Buffer.from(JSON.stringify({ c: last.createdAt.toISOString(), i: last.id })).toString('base64url')
      : null;

  return { data: page.map(serialise), nextCursor, hasMore };
}

export { serialise as serialiseTask };

// Imported late to avoid a circular module reference at load time.
async function cancelRemindersForTask(taskId: string): Promise<void> {
  const { cancelRemindersForTask: cancel } = await import('./reminders');
  await cancel(taskId);
}

async function rescheduleRelativeReminders(taskId: string, dueAt: Date | null): Promise<void> {
  const { rescheduleRelativeReminders: reschedule } = await import('./reminders');
  await reschedule(taskId, dueAt);
}

/** Called only inside the enclosing workspace mutation transaction. */
async function resolveTags(workspaceId: string, ids: string[], names: string[] = []): Promise<string[]> {
  const result = new Set(ids);
  for (const name of new Set(names.map((n) => n.trim().toLowerCase()))) result.add((await createTag(workspaceId, name)).id);
  if (result.size > 50) throw new AppError('VALIDATION_FAILED', 'A task can have at most 50 tags.');
  return [...result];
}

/** One consistent editable snapshot: tags and version share the workspace lock. */
export async function getTaskDetails(workspaceId: string, taskId: string) {
  return withWorkspaceTransaction(workspaceId, async (db) => {
    const task = await loadTask(workspaceId, taskId);
    const links = await db.select({ id: taskTags.tagId }).from(taskTags).where(eq(taskTags.taskId, taskId));
    return { ...serialise(task), tagIds: links.map((l) => l.id) };
  });
}
