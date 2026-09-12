import { and, eq, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { AppError, createReminderSchema, notFound, versionConflict } from '@nextdoo/contracts';
import { deliverDueReminders, reminders, tasks, workspaces } from '@nextdoo/db';
import { getDb } from '../db';
import { newId } from '../ids';
import { logger } from '../observability';
import { withWorkspaceTransaction } from './transactions';
import { writeAudit } from './events';
export interface ReminderActor { userId: string; workspaceId: string; requestId?: string }
export const serialiseReminder = (r: typeof reminders.$inferSelect) => ({ id: r.id, taskId: r.taskId, scheduledAt: r.scheduledAt.toISOString(), minutesBeforeDue: r.minutesBeforeDue, channel: r.channel, status: r.status, version: r.version, attempts: r.attempts, sentAt: r.sentAt?.toISOString() ?? null, lastError: r.lastError, nextAttemptAt: r.nextAttemptAt.toISOString(), supersededById: r.supersededById, createdAt: r.createdAt.toISOString() });
async function activeTask(actor: ReminderActor, id: string) {
 const [row] = await getDb().select({ task: tasks }).from(tasks).innerJoin(workspaces, and(eq(workspaces.id, tasks.workspaceId), eq(workspaces.ownerId, actor.userId), isNull(workspaces.deletedAt))).where(and(eq(tasks.id, id), eq(tasks.workspaceId, actor.workspaceId), isNull(tasks.deletedAt)));
 if (!row) throw notFound('task', id);
 if (row.task.status !== 'ACTIVE') throw new AppError('VALIDATION_FAILED', 'Reminders require an active task.'); return row.task;
}
async function load(actor: ReminderActor, id: string, version?: number) {
 const [r] = await getDb().select().from(reminders).where(and(eq(reminders.id, id), eq(reminders.userId, actor.userId), eq(reminders.workspaceId, actor.workspaceId)));
 if (!r) throw notFound('reminder', id); if (version !== undefined && r.version !== version) throw versionConflict('reminder', id); return r;
}
export async function createReminder(actor: ReminderActor, raw: { taskId: string; scheduledAt?: string; minutesBeforeDue?: number; channel: 'WEB' | 'DESKTOP' | 'EMAIL'; taskVersion?: number }) {
 const input = createReminderSchema.parse(raw);
 return withWorkspaceTransaction(actor.workspaceId, async (db) => {
  const task = await activeTask(actor, input.taskId);
  if (input.taskVersion !== undefined && task.version !== input.taskVersion) throw versionConflict('task', task.id);
  if (input.channel !== 'WEB') throw new AppError('VALIDATION_FAILED', 'Only durable in-app reminders are enabled. External delivery is not configured.');
  if (input.minutesBeforeDue !== undefined && !task.dueAt) throw new AppError('VALIDATION_FAILED', 'A relative reminder needs the task to have a due date.');
  const scheduledAt = input.scheduledAt ? new Date(input.scheduledAt) : new Date(task.dueAt!.getTime() - input.minutesBeforeDue! * 60000);
  const [r] = await db.insert(reminders).values({ id: newId(), workspaceId: actor.workspaceId, userId: actor.userId, taskId: task.id, channel: input.channel, scheduledAt, minutesBeforeDue: input.minutesBeforeDue ?? null }).returning();
  if (!r) throw new Error('Reminder was not created');
  await writeAudit(db, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'reminder.created', targetType: 'reminder', targetId: r.id, requestId: actor.requestId, metadata: { taskId: task.id, version: 1 } }); return serialiseReminder(r);
 });
}
export async function snoozeReminder(actor: ReminderActor, id: string, minutes: number, version?: number) {
 if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10080) throw new AppError('VALIDATION_FAILED', 'Snooze must be between 1 minute and 7 days.');
 return withWorkspaceTransaction(actor.workspaceId, async (db) => {
  const r = await load(actor, id, version); await activeTask(actor, r.taskId);
  if (r.supersededById || !['SCHEDULED','SENT','FAILED'].includes(r.status)) throw new AppError('VALIDATION_FAILED', 'This reminder cannot be snoozed. Refresh its history.');
  if (r.channel !== 'WEB') throw new AppError('VALIDATION_FAILED', 'External reminder delivery is not enabled.');
  const newIdValue = newId(), now = new Date();
  const [next] = await db.insert(reminders).values({ id: newIdValue, workspaceId: actor.workspaceId, userId: actor.userId, taskId: r.taskId, channel: r.channel, scheduledAt: new Date(now.getTime() + minutes * 60000) }).returning();
  const [source] = await db.update(reminders).set({ supersededById: newIdValue, status: r.status === 'SENT' ? 'SENT' : 'CANCELED', version: r.version + 1, updatedAt: now }).where(and(eq(reminders.id, id), eq(reminders.version, r.version))).returning();
  if (!source) throw versionConflict('reminder', id);
  await writeAudit(db, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'reminder.snoozed', targetType: 'reminder', targetId: id, requestId: actor.requestId, metadata: { nextReminderId: newIdValue, minutes, version: r.version + 1 } });
  return serialiseReminder(next!);
 });
}
export async function cancelReminder(actor: ReminderActor, id: string, version?: number) {
 return withWorkspaceTransaction(actor.workspaceId, async (db) => {
  const r = await load(actor, id, version);
  if (r.status === 'CANCELED') return serialiseReminder(r);
  if (!['SCHEDULED','PROCESSING','FAILED'].includes(r.status)) throw new AppError('VALIDATION_FAILED', 'A delivered or expired reminder cannot be recalled.');
  const [row] = await db.update(reminders).set({ status: 'CANCELED', version: r.version + 1, updatedAt: new Date() }).where(and(eq(reminders.id, id), eq(reminders.version, r.version))).returning();
  if (!row) throw versionConflict('reminder', id);
  await writeAudit(db, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'reminder.canceled', targetType: 'reminder', targetId: id, requestId: actor.requestId, metadata: { version: r.version + 1 } }); return serialiseReminder(row!);
 });
}
/** Legacy GET remains a bounded due list; the new history mode is cursor-paginated. */
export async function listDueReminders(userId: string, workspaceId?: string) {
 return getDb().select({ id: reminders.id, taskId: reminders.taskId, scheduledAt: reminders.scheduledAt, channel: reminders.channel, status: reminders.status, title: tasks.title }).from(reminders).innerJoin(tasks, and(eq(tasks.id, reminders.taskId), eq(tasks.workspaceId, reminders.workspaceId), isNull(tasks.deletedAt))).where(and(eq(reminders.userId, userId), workspaceId ? eq(reminders.workspaceId, workspaceId) : undefined, eq(reminders.status, 'SCHEDULED'), lte(reminders.scheduledAt, new Date()))).limit(50);
}
export async function dispatchDueReminders(limit = 100): Promise<{ sent: number; expired: number }> { return deliverDueReminders(getDb(), limit); }
/** Invoked on completion and deletion. Idempotent by design. */
export async function cancelRemindersForTask(taskId: string): Promise<number> {
  const db = getDb();
  const updated = await db
    .update(reminders)
    .set({ status: 'CANCELED', updatedAt: new Date(), version: sql`${reminders.version} + 1` })
    .where(and(eq(reminders.taskId, taskId), inArray(reminders.status, ['SCHEDULED', 'PROCESSING'])))
    .returning({ id: reminders.id });
  if (updated.length) logger.info('reminders.canceled', { taskId, count: updated.length });
  return updated.length;
}


/** Relative reminders follow due-date changes in the caller's task transaction. */
export async function rescheduleRelativeReminders(taskId: string, dueAt: Date | null): Promise<void> {
  await getDb().update(reminders).set(dueAt ? {
    scheduledAt: sql`${dueAt.toISOString()}::timestamptz - ${reminders.minutesBeforeDue} * interval '1 minute'`,
    status: 'SCHEDULED', updatedAt: new Date(), nextAttemptAt: new Date(), attempts: 0, lastError: null, version: sql`${reminders.version} + 1`,
  } : { status: 'CANCELED', updatedAt: new Date(), version: sql`${reminders.version} + 1` }).where(and(
    eq(reminders.taskId, taskId), isNotNull(reminders.minutesBeforeDue), inArray(reminders.status, ['SCHEDULED', 'PROCESSING']),
  ));
}
