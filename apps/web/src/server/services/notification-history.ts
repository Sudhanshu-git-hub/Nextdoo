import { and, desc, eq, isNull, sql, type AnyColumn } from 'drizzle-orm';
import { AppError, isoDateTime, notFound, uuid } from '@nextdoo/contracts';
import { notifications, reminders, tasks, serialiseTaskRecord } from '@nextdoo/db';
import { getDb } from '../db';
import { withWorkspaceTransaction } from './transactions';
import { writeAudit } from './events';
import { serialiseReminder, type ReminderActor } from './reminders';
function order(date: AnyColumn, id: AnyColumn, scope: string, cursor?: string) {
 const key = sql<string>`to_char(${date} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
 let after;
 if (cursor) {
  try {
   if (cursor.length > 1500) throw new Error('length');
   const token = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
   if (token.s !== scope) throw new Error('scope'); const time = isoDateTime.parse(token.k), value = uuid.parse(token.i);
   if (time.startsWith('0000-')) throw new Error('year'); after = sql`(${date}, ${id}) < (${time}::timestamptz, ${value}::uuid)`;
  } catch { throw new AppError('VALIDATION_FAILED', 'Invalid history cursor. Refresh the list.'); }
 }
 return { key, after, sorting: [desc(date), desc(id)], cursor: (i: string, k: string) => Buffer.from(JSON.stringify({ s: scope, i, k })).toString('base64url') };
}
export async function listReminderHistory(actor: ReminderActor, taskId?: string, cursor?: string) {
 if (taskId) {
  const [task] = await getDb().select({ id: tasks.id }).from(tasks).where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, actor.workspaceId), isNull(tasks.deletedAt)));
  if (!task) throw notFound('task', taskId);
 }
 const o = order(reminders.createdAt, reminders.id, `reminders:${actor.workspaceId}:${actor.userId}:${taskId ?? ''}`, cursor);
 const rows = await getDb().select({ reminder: reminders, task: tasks, cursorKey: o.key }).from(reminders).leftJoin(tasks, and(eq(tasks.id, reminders.taskId), eq(tasks.workspaceId, actor.workspaceId), isNull(tasks.deletedAt))).where(and(eq(reminders.workspaceId, actor.workspaceId), eq(reminders.userId, actor.userId), taskId ? eq(reminders.taskId, taskId) : undefined, o.after)).orderBy(...o.sorting).limit(51);
 const last = rows[49]; return { data: rows.slice(0,50).map(({ reminder, task }) => ({ ...serialiseReminder(reminder), task: task ? serialiseTaskRecord(task) : null })), pagination: { has_more: rows.length > 50, next_cursor: rows.length > 50 && last ? o.cursor(last.reminder.id, last.cursorKey) : null } };
}
export async function listNotifications(actor: ReminderActor, cursor?: string) {
 const o = order(notifications.createdAt, notifications.id, `notifications:${actor.workspaceId}:${actor.userId}`, cursor);
 const rows = await getDb().select({ notification: notifications, task: tasks, cursorKey: o.key }).from(notifications).leftJoin(tasks, and(eq(tasks.id, notifications.taskId), eq(tasks.workspaceId, actor.workspaceId), isNull(tasks.deletedAt))).where(and(eq(notifications.userId, actor.userId), eq(notifications.workspaceId, actor.workspaceId), o.after)).orderBy(...o.sorting).limit(51);
 const last = rows[49]; return { data: rows.slice(0,50).map(({ notification: n, task }) => ({ id: n.id, title: task ? n.title : 'Reminder for unavailable task', body: task ? n.body : null, reminderId: n.reminderId, readAt: n.readAt?.toISOString() ?? null, createdAt: n.createdAt.toISOString(), task: task ? serialiseTaskRecord(task) : null })), pagination: { has_more: rows.length > 50, next_cursor: rows.length > 50 && last ? o.cursor(last.notification.id, last.cursorKey) : null } };
}
export async function markNotificationRead(actor: ReminderActor, id: string) {
 return withWorkspaceTransaction(actor.workspaceId, async (db) => {
  const [n] = await db.select().from(notifications).where(and(eq(notifications.id, id), eq(notifications.workspaceId, actor.workspaceId), eq(notifications.userId, actor.userId)));
  if (!n) throw notFound('notification', id);
  if (n.readAt) return { id: n.id, readAt: n.readAt.toISOString() };
  const now = new Date(); await db.update(notifications).set({ readAt: now }).where(eq(notifications.id, id));
  await writeAudit(db, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'notification.read', targetType: 'notification', targetId: id, requestId: actor.requestId }); return { id, readAt: now.toISOString() };
 });
}
