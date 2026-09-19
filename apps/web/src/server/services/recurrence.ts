import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import { AppError, attachRecurrenceSchema, changeRecurrenceSchema, createTaskSchema, notFound, taskVersionSchema, versionConflict, type AttachRecurrenceInput, type ChangeRecurrenceInput } from '@nextdoo/contracts';
import { daysInMonth, localDateKey, localParts } from '@nextdoo/core';
import { recurrenceRules, taskOccurrences, taskTags, tasks, generateRecurrenceInTransaction } from '@nextdoo/db';
import { getDb } from '../db';
import { newId } from '../ids';
import { withWorkspaceTransaction } from './transactions';
import { loadTask, serialiseTask, type TaskActor } from './tasks';
import { appendTrackingEvent, publishEvent, recordSyncChange, writeAudit } from './events';
import { cancelRemindersForTask } from './reminders';
import { scheduleTrackingEvaluation } from './tracking';

async function loadSeries(workspaceId: string, id: string) {
  const [row] = await getDb().select().from(recurrenceRules).where(and(eq(recurrenceRules.id, id), eq(recurrenceRules.workspaceId, workspaceId)));
  if (!row || !row.templateSnapshot) throw notFound('recurrence', id); return row;
}
export async function getRecurrence(workspaceId: string, id: string, cursor?: string) {
  const row = await loadSeries(workspaceId, id); id = row.id;
  if (cursor && (!cursor.startsWith(`${id}:`) || !/^.{36}:\d{4}-\d{2}-\d{2}$/.test(cursor))) throw new AppError('VALIDATION_FAILED', 'Invalid occurrence cursor');
  const result = await getDb().select({ occurrence: taskOccurrences, task: tasks }).from(taskOccurrences).leftJoin(tasks, and(eq(tasks.id, taskOccurrences.taskId), eq(tasks.workspaceId, workspaceId), isNull(tasks.deletedAt))).where(and(eq(taskOccurrences.recurrenceRuleId, id), cursor ? gt(taskOccurrences.occurrenceKey, cursor) : undefined)).orderBy(asc(taskOccurrences.occurrenceKey)).limit(101);
  const [latest] = await getDb().select({ key: sql<string>`max(${taskOccurrences.occurrenceKey})`, due: sql<string>`max(${taskOccurrences.dueAt})` }).from(taskOccurrences).where(eq(taskOccurrences.recurrenceRuleId, id));
  return { id: row.id, templateTaskId: row.templateTaskId, rule: row.rule as AttachRecurrenceInput['rule'], active: row.active, version: row.version,
    startsAt: row.seriesStart.toISOString(), generationError: row.generationError, failureCount: row.failureCount,
    effectiveAfter: new Date(Math.max(Date.now(), latest?.due ? new Date(latest.due).getTime() : 0)).toISOString(),
    lastPlannedDate: latest?.key?.slice(37) ?? null,
    occurrences: result.slice(0, 100).map(({ occurrence: o, task }) => ({ ...o, task: task ? serialiseTask(task) : null, dueAt: o.dueAt.toISOString(), createdAt: o.createdAt.toISOString(), updatedAt: o.updatedAt.toISOString() })),
    nextCursor: result.length > 100 ? result[99]!.occurrence.occurrenceKey : null };
}
export async function attachRecurrence(actor: TaskActor, taskId: string, raw: AttachRecurrenceInput) {
  const input = attachRecurrenceSchema.parse(raw);
  return withWorkspaceTransaction(actor.workspaceId, async (db) => {
    const task = await loadTask(actor.workspaceId, taskId);
    if (task.version !== input.version) throw versionConflict('task', taskId);
    if (task.status !== 'ACTIVE' || task.recurrenceRuleId || !task.dueAt) throw new AppError('VALIDATION_FAILED', 'Start recurrence on an active, scheduled task that is not already in a series.');
    const local = localParts(task.dueAt, input.rule.timeZone);
    if (input.rule.freq === 'WEEKLY' && input.rule.byWeekday && !input.rule.byWeekday.includes(local.weekday)) throw new AppError('VALIDATION_FAILED', 'The first task date must be one of the selected weekdays.');
    if (input.rule.until && new Date(input.rule.until) < task.dueAt) throw new AppError('VALIDATION_FAILED', 'The recurrence end must not precede the first task.');
    if (input.rule.freq === 'MONTHLY' && input.rule.byMonthDay && Math.min(input.rule.byMonthDay, daysInMonth(local.year, local.month)) !== local.day) throw new AppError('VALIDATION_FAILED', 'The first task day must match the selected monthly day.');
    const links = await db.select({ id: taskTags.tagId }).from(taskTags).where(eq(taskTags.taskId, task.id));
    const snapshot = createTaskSchema.parse({ ...serialiseTask(task), tagIds: links.map((r) => r.id), recurrenceRule: null });
    const id = newId(), occurrenceKey = `${id}:${localDateKey(task.dueAt, input.rule.timeZone)}`;
    await db.insert(recurrenceRules).values({ id, workspaceId: actor.workspaceId, templateTaskId: taskId, rule: input.rule, timeZone: input.rule.timeZone, seriesStart: task.dueAt, lastGeneratedAt: task.dueAt, templateSnapshot: snapshot });
    await db.insert(taskOccurrences).values({ id: newId(), recurrenceRuleId: id, occurrenceKey, taskId, dueAt: task.dueAt });
    const [updated] = await db.update(tasks).set({ recurrenceRuleId: id, timeZone: input.rule.timeZone, version: sql`${tasks.version} + 1`, updatedAt: new Date() }).where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, actor.workspaceId), eq(tasks.version, input.version))).returning();
    if (!updated) throw versionConflict('task', taskId);
    await recordSyncChange(db, { workspaceId: actor.workspaceId, entityType: 'task', entityId: taskId, operation: 'update', version: updated.version, payload: serialiseTask(updated) });
    await writeAudit(db, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'recurrence.created', targetType: 'recurrence', targetId: id, requestId: actor.requestId });
    await publishEvent(db, { workspaceId: actor.workspaceId, actorId: actor.userId, entityType: 'recurrence', entityId: id, eventType: 'recurrence.created', payload: { version: 1 } });
    await appendTrackingEvent(db, { workspaceId: actor.workspaceId, actorId: actor.userId, taskId, type: 'RECURRENCE_GENERATED', occurrenceKey, idempotencyKey: `${occurrenceKey}:RECURRENCE_GENERATED` });
    await generateRecurrenceInTransaction(db, id);
    return getRecurrence(actor.workspaceId, id);
  });
}
export async function changeRecurrence(actor: TaskActor, id: string, raw: ChangeRecurrenceInput) {
  const input = changeRecurrenceSchema.parse(raw);
  return withWorkspaceTransaction(actor.workspaceId, async (db) => {
    const current = await loadSeries(actor.workspaceId, id);
    if (current.version !== input.version) throw versionConflict('recurrence', id);
    if (input.rule) {
      const detail = await getRecurrence(actor.workspaceId, id), start = new Date(input.startsAt!);
      if (start <= new Date(detail.effectiveAfter) || detail.lastPlannedDate && localDateKey(start, input.rule.timeZone) <= detail.lastPlannedDate) throw new AppError('VALIDATION_FAILED', 'Choose a new start strictly after the generated range and today. Existing occurrences will not be changed.');
      if (input.rule.until && new Date(input.rule.until) < start) throw new AppError('VALIDATION_FAILED', 'The end must not precede the new start.');
    }
    await db.update(recurrenceRules).set({ ...(input.rule ? { rule: input.rule, timeZone: input.rule.timeZone, seriesStart: new Date(input.startsAt!), lastGeneratedAt: null } : { active: input.active }),
      generationError: null, failureCount: 0, nextRunAt: new Date(), version: current.version + 1, updatedAt: new Date() }).where(and(eq(recurrenceRules.id, id), eq(recurrenceRules.workspaceId, actor.workspaceId), eq(recurrenceRules.version, input.version)));
    await writeAudit(db, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'recurrence.updated', targetType: 'recurrence', targetId: id, requestId: actor.requestId, metadata: { version: current.version + 1, scheduleChanged: !!input.rule, active: input.active ?? current.active } });
    await publishEvent(db, { workspaceId: actor.workspaceId, actorId: actor.userId, entityType: 'recurrence', entityId: id, eventType: 'recurrence.updated', payload: { version: current.version + 1 } });
    await generateRecurrenceInTransaction(db, id);
    return getRecurrence(actor.workspaceId, id);
  });
}
export async function skipOccurrence(actor: TaskActor, taskId: string, raw: { version: number }) {
  const input = taskVersionSchema.parse(raw);
  return withWorkspaceTransaction(actor.workspaceId, async (db) => {
    const task = await loadTask(actor.workspaceId, taskId);
    if (task.version !== input.version) throw versionConflict('task', taskId);
    const [occurrence] = task.recurrenceRuleId ? await db.select().from(taskOccurrences).where(and(eq(taskOccurrences.taskId, taskId), eq(taskOccurrences.recurrenceRuleId, task.recurrenceRuleId))) : [];
    if (!occurrence || occurrence.status !== 'PENDING' || task.status !== 'ACTIVE') throw new AppError('VALIDATION_FAILED', 'Only an active pending occurrence can be skipped.');
    const [updated] = await db.update(tasks).set({ status: 'ARCHIVED', archivedAt: new Date(), version: task.version + 1, updatedAt: new Date() }).where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, actor.workspaceId), eq(tasks.version, task.version))).returning();
    if (!updated) throw versionConflict('task', taskId);
    await db.update(taskOccurrences).set({ status: 'SKIPPED', updatedAt: new Date() }).where(eq(taskOccurrences.id, occurrence.id));
    await appendTrackingEvent(db, { workspaceId: actor.workspaceId, taskId, actorId: actor.userId, type: 'TASK_SKIPPED', occurrenceKey: occurrence.occurrenceKey, idempotencyKey: `skip:${taskId}:${task.version}` });
    await recordSyncChange(db, { workspaceId: actor.workspaceId, entityId: taskId, entityType: 'task', operation: 'update', version: updated.version, payload: serialiseTask(updated) });
    await publishEvent(db, { workspaceId: actor.workspaceId, actorId: actor.userId, eventType: 'task.updated', entityType: 'task', entityId: taskId, payload: { skipped: true } });
    await writeAudit(db, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'recurrence.skipped', targetType: 'task', targetId: taskId, requestId: actor.requestId });
    await cancelRemindersForTask(taskId); await scheduleTrackingEvaluation(actor.workspaceId, taskId);
    return serialiseTask(updated);
  });
}
