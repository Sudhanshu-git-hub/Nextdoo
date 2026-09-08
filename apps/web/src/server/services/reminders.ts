import { and, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import { AppError, notFound } from '@nextdoo/contracts';
import { deliverDueReminders, reminders, tasks } from '@nextdoo/db';
import { getDb } from '../db';
import { newId } from '../ids';
import { logger } from '../observability';

/**
 * Reminder lifecycle (PRD §6.6).
 *
 * States: SCHEDULED → PROCESSING → SENT | FAILED | CANCELED | EXPIRED
 * Two guarantees enforced here:
 *  - Completing or deleting a task cancels its pending reminders.
 *  - A reminder more than 24h overdue expires instead of firing late.
 */


export interface ReminderActor {
  userId: string;
  workspaceId: string;
}

export async function createReminder(
  actor: ReminderActor,
  input: { taskId: string; scheduledAt?: string; minutesBeforeDue?: number; channel: 'WEB' | 'DESKTOP' | 'EMAIL' },
) {
  const db = getDb();
  const rows = await db
    .select({ id: tasks.id, dueAt: tasks.dueAt, status: tasks.status })
    .from(tasks)
    .where(and(eq(tasks.id, input.taskId), eq(tasks.workspaceId, actor.workspaceId)))
    .limit(1);
  const task = rows[0];
  if (!task || task.status === 'DELETED') throw notFound('task', input.taskId);

  let scheduledAt: Date;
  if (input.scheduledAt) {
    scheduledAt = new Date(input.scheduledAt);
  } else {
    if (!task.dueAt) {
      throw new AppError('VALIDATION_FAILED', 'A relative reminder needs the task to have a due date.');
    }
    scheduledAt = new Date(task.dueAt.getTime() - (input.minutesBeforeDue ?? 0) * 60_000);
  }

  const [created] = await db
    .insert(reminders)
    .values({
      id: newId(),
      workspaceId: actor.workspaceId,
      taskId: input.taskId,
      userId: actor.userId,
      scheduledAt,
      minutesBeforeDue: input.minutesBeforeDue ?? null,
      channel: input.channel,
      status: 'SCHEDULED',
    })
    .returning();

  return created
    ? {
        id: created.id,
        taskId: created.taskId,
        scheduledAt: created.scheduledAt.toISOString(),
        channel: created.channel,
        status: created.status,
      }
    : null;
}

/** Invoked on completion and deletion. Idempotent by design. */
export async function cancelRemindersForTask(taskId: string): Promise<number> {
  const db = getDb();
  const updated = await db
    .update(reminders)
    .set({ status: 'CANCELED', updatedAt: new Date() })
    .where(and(eq(reminders.taskId, taskId), inArray(reminders.status, ['SCHEDULED', 'PROCESSING'])))
    .returning({ id: reminders.id });
  if (updated.length) logger.info('reminders.canceled', { taskId, count: updated.length });
  return updated.length;
}

export async function snoozeReminder(actor: ReminderActor, reminderId: string, minutes: number) {
  const db = getDb();
  const [updated] = await db
    .update(reminders)
    .set({
      scheduledAt: sql`now() + (${minutes} || ' minutes')::interval`,
      status: 'SCHEDULED',
      updatedAt: new Date(),
    })
    .where(and(eq(reminders.id, reminderId), eq(reminders.userId, actor.userId)))
    .returning();
  if (!updated) throw notFound('reminder', reminderId);
  return { id: updated.id, scheduledAt: updated.scheduledAt.toISOString(), status: updated.status };
}

export async function cancelReminder(actor: ReminderActor, reminderId: string): Promise<void> {
  const db = getDb();
  const result = await db
    .update(reminders)
    .set({ status: 'CANCELED', updatedAt: new Date() })
    .where(and(eq(reminders.id, reminderId), eq(reminders.userId, actor.userId)))
    .returning({ id: reminders.id });
  if (!result.length) throw notFound('reminder', reminderId);
}

export async function listDueReminders(userId: string) {
  const db = getDb();
  return db
    .select({
      id: reminders.id,
      taskId: reminders.taskId,
      scheduledAt: reminders.scheduledAt,
      channel: reminders.channel,
      status: reminders.status,
      title: tasks.title,
    })
    .from(reminders)
    .innerJoin(tasks, eq(tasks.id, reminders.taskId))
    .where(and(eq(reminders.userId, userId), eq(reminders.status, 'SCHEDULED'), lte(reminders.scheduledAt, new Date())))
    .limit(50);
}

/**
 * Dispatch pass, run by the worker.
 * Claims rows with FOR UPDATE SKIP LOCKED so concurrent workers never
 * double-deliver the same reminder.
 */
export async function dispatchDueReminders(limit = 100): Promise<{ sent: number; expired: number }> {
  return deliverDueReminders(getDb(), limit);
}

/** Relative reminders follow due-date changes in the caller's task transaction. */
export async function rescheduleRelativeReminders(taskId: string, dueAt: Date | null): Promise<void> {
  await getDb().update(reminders).set(dueAt ? {
    scheduledAt: sql`${dueAt.toISOString()}::timestamptz - ${reminders.minutesBeforeDue} * interval '1 minute'`,
    status: 'SCHEDULED', updatedAt: new Date(),
  } : { status: 'CANCELED', updatedAt: new Date() }).where(and(
    eq(reminders.taskId, taskId), isNotNull(reminders.minutesBeforeDue), inArray(reminders.status, ['SCHEDULED', 'PROCESSING']),
  ));
}
