import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { Database } from './client';
import { notifications, reminders } from './schema';

/** SENT for WEB means a durable in-app notification, never a claim of web push. */
export async function deliverDueReminders(db: Database, limit = 100) {
  return db.transaction(async (tx) => {
    const rows = await tx.execute(sql`select r.*, t.title, t.status as task_status
      from reminders r join tasks t on t.id=r.task_id
      where r.status='SCHEDULED' and r.scheduled_at <= now()
      order by r.scheduled_at, r.id limit ${limit} for update of r,t skip locked`);
    let sent = 0, expired = 0, failed = 0, canceled = 0;
    for (const r of rows) {
      const now = new Date();
      let status: 'SENT' | 'EXPIRED' | 'FAILED' | 'CANCELED';
      if (r.task_status !== 'ACTIVE') { status = 'CANCELED'; canceled++; }
      else if (new Date(r.scheduled_at as string).getTime() < Date.now() - 86400000) { status = 'EXPIRED'; expired++; }
      else if (r.channel !== 'WEB') { status = 'FAILED'; failed++; }
      else {
        await tx.insert(notifications).values({ id: randomUUID(), userId: String(r.user_id), workspaceId: String(r.workspace_id), taskId: String(r.task_id), type: 'reminder', title: String(r.title), body: 'This task is due.' });
        status = 'SENT'; sent++;
      }
      await tx.update(reminders).set({ status, updatedAt: now, sentAt: status === 'SENT' ? now : null,
        attempts: sql`${reminders.attempts} + 1`, lastError: status === 'FAILED' ? 'DELIVERY_PROVIDER_NOT_CONFIGURED' : null,
      }).where(eq(reminders.id, String(r.id)));
    }
    return { sent, expired, failed, canceled };
  });
}
