import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { deliverDueReminders, notifications, reminders, users } from '@nextdoo/db';
import { requireTestDatabase } from '../../../../../tests/database';
import { getDb } from '../db';
import { registerUser } from './accounts';
import { createTask, completeTask } from './tasks';
import { createReminder, snoozeReminder, cancelReminder } from './reminders';
await requireTestDatabase();
async function fixture(title = 'Reminder task') {
 const u = await registerUser({ email: `reminder-${randomUUID()}@test.local`, passwordHash: 'test', name: null, timeZone: 'UTC' }); const actor = { userId: u.id, workspaceId: u.workspaceId };
 return { actor, task: await createTask(actor, { workspaceId: actor.workspaceId, title, dueAt: new Date(Date.now()+86400000).toISOString(), priority: 'NONE', tagIds: [] }) };
}
it('delivers full-length task titles once, including concurrent dispatch', async () => {
 const { actor, task } = await fixture('x'.repeat(500)); const r = await createReminder(actor, { taskId: task.id, scheduledAt: new Date(Date.now()-1000).toISOString(), channel: 'WEB' });
 await Promise.all([deliverDueReminders(getDb()), deliverDueReminders(getDb())]);
 const rows = await getDb().select().from(notifications).where(eq(notifications.taskId, task.id)); expect(rows).toHaveLength(1); expect(rows[0]!.title).toBe(task.title);
 expect((await getDb().select().from(reminders).where(eq(reminders.id, r!.id)))[0]!.status).toBe('SENT');
});
it('snooze cannot rearm completed tasks or mutate another workspace through the same user id', async () => {
 const { actor, task } = await fixture(); const other = await fixture(); const r = await createReminder(actor, { taskId: task.id, minutesBeforeDue: 15, channel: 'WEB' });
 await expect(snoozeReminder({ ...actor, workspaceId: other.actor.workspaceId }, r!.id, 10)).rejects.toMatchObject({ code: 'NOT_FOUND' });
 await expect(cancelReminder({ ...actor, workspaceId: other.actor.workspaceId }, r!.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
 await completeTask(actor, task.id, task.version);
 await expect(snoozeReminder(actor, r!.id, 10)).rejects.toBeTruthy();
 await expect(createReminder(actor, { taskId: task.id, minutesBeforeDue: 10, channel: 'WEB' })).rejects.toBeTruthy();
 expect((await getDb().select().from(reminders).where(eq(reminders.id, r!.id)))[0]!.status).toBe('CANCELED');
});
it('snoozing a sent reminder creates a fresh delivery identity and preserves the original history', async () => {
 const { actor, task } = await fixture(); const r = await createReminder(actor, { taskId: task.id, scheduledAt: new Date(Date.now()-1000).toISOString(), channel: 'WEB' }); await deliverDueReminders(getDb());
 const next = await snoozeReminder(actor, r!.id, 10); expect(next.id).not.toBe(r!.id);
 expect((await getDb().select().from(reminders).where(eq(reminders.id, r!.id)))[0]!.status).toBe('SENT');
 await expect(snoozeReminder(actor, r!.id, 10)).rejects.toBeTruthy();
 expect(await getDb().select().from(notifications).where(eq(notifications.taskId, task.id))).toHaveLength(1);
});
it('dispatch suppresses pending-deletion recipients and forged cross-tenant references', async () => {
 const { actor, task } = await fixture(), other = await fixture();
 const ids = [randomUUID(), randomUUID()]; await getDb().insert(reminders).values([
  { id: ids[0]!, workspaceId: actor.workspaceId, taskId: task.id, userId: other.actor.userId, scheduledAt: new Date(0) },
  { id: ids[1]!, workspaceId: other.actor.workspaceId, taskId: task.id, userId: other.actor.userId, scheduledAt: new Date() },
 ]);
 await getDb().update(users).set({ deletionRequestedAt: new Date() }).where(eq(users.id, actor.userId));
 const own = randomUUID(); await getDb().insert(reminders).values({ id: own, workspaceId: actor.workspaceId, taskId: task.id, userId: actor.userId, scheduledAt: new Date() });
 await deliverDueReminders(getDb()); expect(await getDb().select().from(notifications).where(eq(notifications.taskId, task.id))).toHaveLength(0);
});
it('a poisoned delivery cannot block other reminders and fails after three bounded attempts', async () => {
 const bad = await fixture(), good = await fixture(); const when = new Date(Date.now()-1000).toISOString();
 const r = await createReminder(bad.actor, { taskId: bad.task.id, scheduledAt: when, channel: 'WEB' }); await createReminder(good.actor, { taskId: good.task.id, scheduledAt: when, channel: 'WEB' });
 const name = `notification_test_${randomUUID().replaceAll('-', '')}`;
 await getDb().execute(sql.raw(`ALTER TABLE notifications ADD CONSTRAINT ${name} CHECK (task_id <> '${bad.task.id}'::uuid) NOT VALID`));
 try {
  for (let attempt = 1; attempt <= 3; attempt++) {
   await deliverDueReminders(getDb());
   const [row] = await getDb().select().from(reminders).where(eq(reminders.id, r!.id)); expect(row!.attempts).toBe(attempt); expect(row!.status).toBe(attempt === 3 ? 'FAILED' : 'SCHEDULED');
   if (attempt < 3) await getDb().execute(sql`update reminders set next_attempt_at=now() where id=${r!.id}::uuid`);
  }
  await deliverDueReminders(getDb()); expect((await getDb().select().from(reminders).where(eq(reminders.id, r!.id)))[0]!.attempts).toBe(3);
 } finally { await getDb().execute(sql.raw(`ALTER TABLE notifications DROP CONSTRAINT ${name}`)); }
 expect(await getDb().select().from(notifications).where(eq(notifications.taskId, bad.task.id))).toHaveLength(0);
 expect(await getDb().select().from(notifications).where(eq(notifications.taskId, good.task.id))).toHaveLength(1);
 expect(await getDb().select().from(reminders).where(and(eq(reminders.taskId, bad.task.id), eq(reminders.status, 'FAILED')))).toHaveLength(1);
});
it('expiration boundary and normal task completion are enforced by dispatch under serialization', async () => {
 const a = await fixture(), b = await fixture(), now = new Date();
 const first = await createReminder(a.actor, { taskId: a.task.id, scheduledAt: new Date(now.getTime()-86400000).toISOString(), channel: 'WEB' });
 const second = await createReminder(b.actor, { taskId: b.task.id, scheduledAt: new Date(now.getTime()-86400001).toISOString(), channel: 'WEB' });
 await deliverDueReminders(getDb(), 100, new Date(now.getTime()+100));
 expect((await getDb().select().from(reminders).where(eq(reminders.id, second.id)))[0]!.status).toBe('EXPIRED');
 // Set the exact boundary with a due retry checkpoint, not the registration timestamp.
 await getDb().update(reminders).set({ status: 'SCHEDULED', scheduledAt: new Date(now.getTime()-86400000), nextAttemptAt: new Date(0) }).where(eq(reminders.id, first.id));
 await deliverDueReminders(getDb(), 100, now); expect((await getDb().select().from(reminders).where(eq(reminders.id, first.id)))[0]!.status).toBe('SENT');
 const c = await fixture(); const pending = await createReminder(c.actor, { taskId: c.task.id, scheduledAt: new Date(Date.now()-1000).toISOString(), channel: 'WEB' });
 await Promise.all([completeTask(c.actor, c.task.id, c.task.version), deliverDueReminders(getDb())]);
 const [result] = await getDb().select().from(reminders).where(eq(reminders.id, pending.id)); expect(['CANCELED','SENT']).toContain(result!.status);
 // Either legal serialization may win, but nothing pending can survive completion.
 expect(await getDb().select().from(reminders).where(and(eq(reminders.taskId, c.task.id), eq(reminders.status, 'SCHEDULED')))).toHaveLength(0);
});
it('history paginates exact microsecond ties and read acknowledgements are scoped and idempotent', async () => {
 const { actor, task } = await fixture(); const other = await fixture(); const { listNotifications, markNotificationRead } = await import('./notification-history');
 const ids = Array.from({ length: 55 }, () => randomUUID());
 await getDb().insert(notifications).values(ids.map((id) => ({ id, userId: actor.userId, workspaceId: actor.workspaceId, taskId: task.id, type: 'reminder', title: 'Original title' })));
 await getDb().execute(sql`update notifications set created_at='2026-09-09T00:00:00.123456Z'::timestamptz where task_id=${task.id}::uuid`);
 const first = await listNotifications(actor); expect(first.data).toHaveLength(50); const second = await listNotifications(actor, first.pagination.next_cursor!); expect(second.data).toHaveLength(5); expect(new Set([...first.data,...second.data].map((n) => n.id)).size).toBe(55);
 await expect(listNotifications(other.actor, first.pagination.next_cursor!)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
 await expect(markNotificationRead(other.actor, ids[0]!)).rejects.toMatchObject({ code: 'NOT_FOUND' });
 const read = await markNotificationRead(actor, ids[0]!); expect(await markNotificationRead(actor, ids[0]!)).toEqual(read);
 const { deleteTask } = await import('./tasks'); await deleteTask(actor, task.id, task.version); expect((await listNotifications(actor)).data.every((n) => n.task === null && n.title === 'Reminder for unavailable task')).toBe(true);
});
it('a failed snooze audit leaves neither a child nor a changed source version', async () => {
 const { actor, task } = await fixture(); const r = await createReminder(actor, { taskId: task.id, minutesBeforeDue: 10, channel: 'WEB' }); const name = `reminder_audit_${randomUUID().replaceAll('-', '')}`;
 await getDb().execute(sql.raw(`ALTER TABLE audit_logs ADD CONSTRAINT ${name} CHECK (workspace_id <> '${actor.workspaceId}'::uuid OR action <> 'reminder.snoozed') NOT VALID`));
 try { await expect(snoozeReminder(actor, r.id, 10, r.version)).rejects.toBeTruthy(); } finally { await getDb().execute(sql.raw(`ALTER TABLE audit_logs DROP CONSTRAINT ${name}`)); }
 const rows = await getDb().select().from(reminders).where(eq(reminders.taskId, task.id)); expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ version: r.version, supersededById: null, status: 'SCHEDULED' });
});
it('account export retains notification/read data but cannot reveal legacy cross-tenant notification snapshots', async () => {
 const a = await fixture('Private foreign source'), b = await fixture(); const { buildExport } = await import('./data-rights');
 const ids = [randomUUID(), randomUUID(), randomUUID()];
 await getDb().insert(notifications).values([
  { id: ids[0]!, userId: b.actor.userId, workspaceId: b.actor.workspaceId, taskId: b.task.id, title: 'Own reminder', type: 'reminder', readAt: new Date() },
  { id: ids[1]!, userId: b.actor.userId, workspaceId: a.actor.workspaceId, taskId: a.task.id, title: a.task.title, type: 'reminder' },
  { id: ids[2]!, userId: b.actor.userId, workspaceId: b.actor.workspaceId, taskId: a.task.id, title: a.task.title, body: 'Private foreign body', type: 'reminder' },
 ]);
 const bundle = await buildExport(b.actor.userId); expect(JSON.stringify(bundle.notifications)).not.toContain(a.task.title); expect(JSON.stringify(bundle.notifications)).not.toContain('Private foreign body'); expect(bundle.notifications).toContainEqual(expect.objectContaining({ id: ids[0], title: 'Own reminder', readAt: expect.any(Date) }));
});
it('account purge removes linked notifications, read state and reminders without orphaning the new delivery identity', async () => {
 const { actor, task } = await fixture(); const { purgeAccount } = await import('@nextdoo/db');
 await createReminder(actor, { taskId: task.id, scheduledAt: new Date(Date.now()-1000).toISOString(), channel: 'WEB' }); await deliverDueReminders(getDb());
 const [n] = await getDb().select().from(notifications).where(eq(notifications.taskId, task.id)); expect(n?.reminderId).toBeTruthy();
 const { markNotificationRead } = await import('./notification-history'); await markNotificationRead(actor, n!.id);
 await getDb().update(users).set({ deletionRequestedAt: new Date(Date.now()-31*86400000) }).where(eq(users.id, actor.userId));
 expect(await purgeAccount(getDb(), actor.userId, new Date(Date.now()-30*86400000))).toBe(true);
 expect(await getDb().select().from(notifications).where(eq(notifications.userId, actor.userId))).toHaveLength(0); expect(await getDb().select().from(reminders).where(eq(reminders.userId, actor.userId))).toHaveLength(0);
});
