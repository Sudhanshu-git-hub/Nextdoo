import { randomUUID } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Database } from './client';
import { notifications, reminders, tasks, users, workspaces, auditLogs } from './schema';

/** SENT for WEB means a durable in-app notification, never a claim of OS/web push. */
export async function deliverDueReminders(db: Database, limit = 100, clock?: Date) {
 // Use PostgreSQL's full-precision clock for due selection. A freshly committed
 // retry checkpoint can be later than JavaScript's truncated millisecond clock.
 const [dbClock] = await db.execute<{ value: string }>(sql`select to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as value`);
 const instant = clock?.toISOString() ?? dbClock!.value, now = new Date(instant);
 const candidates = await db.select().from(reminders).where(and(eq(reminders.status, 'SCHEDULED'), sql`${reminders.scheduledAt} <= ${instant}::timestamptz`, sql`${reminders.nextAttemptAt} <= ${instant}::timestamptz`)).orderBy(asc(reminders.scheduledAt), asc(reminders.id)).limit(Math.max(0, Math.min(100, Math.floor(limit))));
 const result = { sent: 0, expired: 0, failed: 0, canceled: 0, retrying: 0 };
 for (const candidate of candidates) {
  try {
   const outcome = await db.transaction(async (tx) => {
    await tx.execute(sql`set local lock_timeout='5s'`); await tx.execute(sql`set local statement_timeout='10s'`);
    // Same lock order as task mutations; do not claim all recipients in one transaction.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'workspace:' + candidate.workspaceId}, 0))`);
    const [owner] = await tx.select().from(users).where(eq(users.id, candidate.userId)).for('share');
    const [workspace] = await tx.select().from(workspaces).where(eq(workspaces.id, candidate.workspaceId));
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, candidate.taskId)).for('update');
    const [r] = await tx.select().from(reminders).where(eq(reminders.id, candidate.id)).for('update');
    if (!r || r.status !== 'SCHEDULED' || r.version !== candidate.version || r.nextAttemptAt > now || r.scheduledAt > now) return null;
    let status: 'SENT' | 'EXPIRED' | 'FAILED' | 'CANCELED';
    if (!task || task.workspaceId !== r.workspaceId || task.status !== 'ACTIVE' || task.deletedAt || !workspace || workspace.deletedAt || workspace.ownerId !== r.userId || !owner || owner.status !== 'ACTIVE' || owner.deletedAt || owner.deletionRequestedAt) status = 'CANCELED';
    else if (r.scheduledAt.getTime() < now.getTime() - 86400000) status = 'EXPIRED';
    else if (r.channel !== 'WEB' || r.attempts >= 3) status = 'FAILED';
    else {
     await tx.insert(notifications).values({ id: randomUUID(), reminderId: r.id, userId: r.userId, workspaceId: r.workspaceId, taskId: r.taskId, type: 'reminder', title: task.title, body: 'Your scheduled reminder is ready.' }).onConflictDoNothing({ target: notifications.reminderId });
     status = 'SENT';
    }
    await tx.update(reminders).set({ status, updatedAt: now, version: r.version + 1, sentAt: status === 'SENT' ? now : null, attempts: Math.max(r.attempts, Math.min(3, r.attempts + 1)), lastError: status === 'FAILED' ? (r.channel === 'WEB' ? 'DELIVERY_FAILED' : 'DELIVERY_PROVIDER_NOT_CONFIGURED') : null }).where(eq(reminders.id, r.id));
    await tx.insert(auditLogs).values({ id: randomUUID(), workspaceId: r.workspaceId, actorId: null, action: 'reminder.dispatch', targetType: 'reminder', targetId: r.id, metadata: { status, version: r.version + 1 } });
    return status;
   });
   if (outcome === 'SENT') result.sent++; else if (outcome === 'EXPIRED') result.expired++; else if (outcome === 'FAILED') result.failed++; else if (outcome === 'CANCELED') result.canceled++;
  } catch {
   // The notification, status and audit were rolled back. Record only a generic code;
   // a stale candidate must not undo completion, snooze, cancellation or another worker.
   const attempts = Math.max(candidate.attempts, Math.min(3, candidate.attempts + 1)), status = attempts >= 3 ? 'FAILED' : 'SCHEDULED';
   const rows = await db.update(reminders).set({ attempts, status, version: candidate.version + 1, updatedAt: now, lastError: 'DELIVERY_FAILED', nextAttemptAt: new Date(now.getTime() + 60000 * 2 ** (attempts - 1)) }).where(and(eq(reminders.id, candidate.id), eq(reminders.version, candidate.version), eq(reminders.attempts, candidate.attempts), eq(reminders.status, 'SCHEDULED'))).returning({ id: reminders.id });
   if (rows.length) { if (status === 'FAILED') result.failed++; else result.retrying++; }
  }
 }
 return result;
}
