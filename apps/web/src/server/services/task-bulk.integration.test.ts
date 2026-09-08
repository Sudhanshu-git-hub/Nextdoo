import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { tasks, trackingEvents, syncChanges, outbox, auditLogs, reminders, trackingResults } from '@nextdoo/db';
import { bulkTaskSchema } from '@nextdoo/contracts';
import { requireTestDatabase } from '../../../../../tests/database';
import { getDb } from '../db';
import { registerUser } from './accounts';
import { createTask, loadTask, updateTask, archiveTask } from './tasks';
import { bulkTasks } from './task-bulk';
import { createReminder } from './reminders';
import * as events from './events';
await requireTestDatabase();
async function fixture() {
 const user = await registerUser({ email: `bulk-${randomUUID()}@test.local`, passwordHash: 'test', name: null, timeZone: 'UTC' });
 const actor = { userId: user.id, workspaceId: user.workspaceId };
 const rows = [];
 for (const title of ['First', 'Second']) rows.push(await createTask(actor, { workspaceId: actor.workspaceId, title, priority: 'HIGH', tagIds: [], dueAt: '2026-09-12T12:00:00Z' }));
 return { actor, rows, input: { workspaceId: actor.workspaceId, tasks: rows.map(({ id, version }) => ({ id, version })) } };
}
async function snapshot(workspaceId: string) {
 return Promise.all([getDb().select().from(tasks).where(eq(tasks.workspaceId, workspaceId)), getDb().select().from(trackingEvents).where(eq(trackingEvents.workspaceId, workspaceId)), getDb().select().from(syncChanges).where(eq(syncChanges.workspaceId, workspaceId)), getDb().select().from(outbox).where(eq(outbox.workspaceId, workspaceId)), getDb().select().from(auditLogs).where(eq(auditLogs.workspaceId, workspaceId)), getDb().select().from(reminders).where(eq(reminders.workspaceId, workspaceId)), getDb().select().from(trackingResults).where(eq(trackingResults.workspaceId, workspaceId))]);
}
for (const operation of ['complete', 'archive', 'reschedule'] as const) it(`atomic ${operation} uses existing events, versions and reminder semantics`, async () => {
 const { actor, rows, input } = await fixture();
 for (const row of rows) await createReminder(actor, { taskId: row.id, minutesBeforeDue: 5, channel: 'WEB' });
 const trackingBefore = (await snapshot(actor.workspaceId))[1].length;
 const result = await bulkTasks(actor, bulkTaskSchema.parse({ ...input, operation, ...(operation === 'reschedule' ? { dueAt: '2026-09-14T14:00:00Z', reason: 'Review' } : {}) }));
 expect(result.data).toHaveLength(2);
 for (const row of result.data) {
  expect(row.version).toBe(2); expect(row.status).toBe(operation === 'complete' ? 'COMPLETED' : operation === 'archive' ? 'ARCHIVED' : 'ACTIVE');
  if (operation === 'reschedule') expect(row).toMatchObject({ dueAt: '2026-09-14T14:00:00.000Z', rescheduleCount: 1 });
 }
 const [state, tracking, sync, published, audit, pending] = await snapshot(actor.workspaceId);
 expect(state).toHaveLength(2); expect(tracking).toHaveLength(trackingBefore + 2); expect(tracking.filter((r) => r.type === (operation === 'complete' ? 'TASK_COMPLETED' : operation === 'archive' ? 'TASK_ARCHIVED' : 'TASK_RESCHEDULED'))).toHaveLength(2); expect(sync.filter((r) => r.entityType === 'task')).toHaveLength(4); expect(published.filter((r) => r.entityType === 'task')).toHaveLength(4);
 expect(audit.some((r) => r.action === `tasks.bulk.${operation}`)).toBe(true);
 for (const reminder of pending) {
  expect(reminder.status).toBe(operation === 'complete' ? 'CANCELED' : 'SCHEDULED');
  if (operation === 'reschedule') expect(reminder.scheduledAt.toISOString()).toBe('2026-09-14T13:55:00.000Z');
 }
});
for (const operation of ['complete', 'archive', 'reschedule'] as const) it(`${operation} rolls back earlier tasks and every side effect on a later stale version`, async () => {
 const { actor, rows, input } = await fixture();
 await createReminder(actor, { taskId: rows[0]!.id, minutesBeforeDue: 5, channel: 'WEB' });
 await updateTask(actor, rows[1]!.id, { version: 1, title: 'Changed elsewhere' });
 const before = await snapshot(actor.workspaceId);
 await expect(bulkTasks(actor, bulkTaskSchema.parse({ ...input, operation, ...(operation === 'reschedule' ? { dueAt: null } : {}) }))).rejects.toMatchObject({ code: 'RESOURCE_VERSION_CONFLICT' });
 expect(await snapshot(actor.workspaceId)).toEqual(before);
});
it('foreign/missing/deleted selections cannot partially update this workspace', async () => {
 const a = await fixture(), b = await fixture();
 for (const id of [b.rows[0]!.id, randomUUID()]) {
  const before = await snapshot(a.actor.workspaceId);
  await expect(bulkTasks(a.actor, bulkTaskSchema.parse({ ...a.input, operation: 'complete', tasks: [a.input.tasks[0], { id, version: 1 }] }))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(await snapshot(a.actor.workspaceId)).toEqual(before);
 }
 await expect(bulkTasks(a.actor, bulkTaskSchema.parse({ ...a.input, workspaceId: b.actor.workspaceId, operation: 'complete' }))).rejects.toMatchObject({ code: 'FORBIDDEN' });
 await getDb().update(tasks).set({ status: 'DELETED', deletedAt: new Date() }).where(eq(tasks.id, a.rows[1]!.id));
 await expect(bulkTasks(a.actor, bulkTaskSchema.parse({ ...a.input, operation: 'reschedule', dueAt: null }))).rejects.toMatchObject({ code: 'NOT_FOUND' });
 expect((await loadTask(a.actor.workspaceId, a.rows[0]!.id)).version).toBe(1);
});
it('illegal transition in any row aborts the whole selection', async () => {
 const { actor, rows, input } = await fixture(); await archiveTask(actor, rows[1]!.id, 1);
 const before = await snapshot(actor.workspaceId);
 await expect(bulkTasks(actor, bulkTaskSchema.parse({ ...input, operation: 'complete', tasks: [input.tasks[0], { id: rows[1]!.id, version: 2 }] }))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
 expect(await snapshot(actor.workspaceId)).toEqual(before);
});
it('concurrent overlapping batches commit once, while the stale batch fails atomically', async () => {
 const { actor, input } = await fixture(); const request = bulkTaskSchema.parse({ ...input, operation: 'complete' });
 const outcomes = await Promise.allSettled([bulkTasks(actor, request), bulkTasks(actor, { ...request, tasks: [...request.tasks].reverse() })]);
 expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
 expect(outcomes.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'RESOURCE_VERSION_CONFLICT' } });
 expect((await snapshot(actor.workspaceId))[1].filter((r) => r.type === 'TASK_COMPLETED')).toHaveLength(2);
});
it('an aggregate audit failure rolls back all nested changes', async () => {
 const { actor, input } = await fixture(); const before = await snapshot(actor.workspaceId);
 const original = events.writeAudit; const spy = vi.spyOn(events, 'writeAudit').mockImplementation(async (db, event) => {
  if (event.action.startsWith('tasks.bulk.')) throw new Error('injected audit failure'); return original(db, event);
 });
 try { await expect(bulkTasks(actor, bulkTaskSchema.parse({ ...input, operation: 'complete' }))).rejects.toThrow('injected audit failure'); }
 finally { spy.mockRestore(); }
 expect(await snapshot(actor.workspaceId)).toEqual(before);
});
it('rejects duplicates, empty/oversized batches and unsupported or ambiguous commands', () => {
 const base = { workspaceId: randomUUID(), operation: 'complete', tasks: [{ id: randomUUID(), version: 1 }] };
 for (const extra of [{ tasks: [] }, { tasks: [base.tasks[0], base.tasks[0]] }, { tasks: Array.from({ length: 101 }, () => ({ id: randomUUID(), version: 1 })) }, { tasks: [{ id: randomUUID(), version: 0 }] }, { operation: 'delete' }, { operation: 'reschedule' }, { dueAt: null }, { selectAll: true }]) expect(bulkTaskSchema.safeParse({ ...base, ...extra }).success).toBe(false);
 expect(bulkTaskSchema.safeParse({ ...base, operation: 'reschedule', dueAt: null }).success).toBe(true);
});
it('accepts exactly 100 explicit tasks and leaves an unselected task untouched', async () => {
 const { actor, input, rows } = await fixture();
 const ids = Array.from({ length: 99 }, () => randomUUID());
 await getDb().insert(tasks).values(ids.map((id) => ({ id, workspaceId: actor.workspaceId, title: 'Bounded bulk task' })));
 const result = await bulkTasks(actor, bulkTaskSchema.parse({ workspaceId: actor.workspaceId, operation: 'complete', tasks: [input.tasks[0], ...ids.map((id) => ({ id, version: 1 }))] }));
 expect(result.data).toHaveLength(100); expect(result.data.every((r) => r.version === 2 && r.status === 'COMPLETED')).toBe(true);
 expect(await loadTask(actor.workspaceId, rows[1]!.id)).toMatchObject({ version: 1, status: 'ACTIVE' });
});
it('removing due dates cancels relative reminders but preserves absolute reminders and task metadata', async () => {
 const { actor, rows, input } = await fixture();
 const relative = await createReminder(actor, { taskId: rows[0]!.id, minutesBeforeDue: 5, channel: 'WEB' });
 const absolute = await createReminder(actor, { taskId: rows[0]!.id, scheduledAt: '2026-09-15T10:00:00Z', channel: 'WEB' });
 if (!relative || !absolute) throw new Error('Reminder fixture creation failed');
 await bulkTasks(actor, bulkTaskSchema.parse({ ...input, operation: 'reschedule', dueAt: null, reason: 'Remove schedule' }));
 for (const row of rows) expect(await loadTask(actor.workspaceId, row.id)).toMatchObject({ dueAt: null, priority: 'HIGH', title: row.title, version: 2, rescheduleCount: 1 });
 const saved = (await snapshot(actor.workspaceId))[5];
 expect(saved.find((r) => r.id === relative.id)?.status).toBe('CANCELED'); expect(saved.find((r) => r.id === absolute.id)?.status).toBe('SCHEDULED');
});

it('UUID case differences cannot select the same database task twice', () => {
 const id = 'aaaaaaaa-1111-4111-8111-111111111111';
 expect(bulkTaskSchema.safeParse({ workspaceId: randomUUID(), operation: 'reschedule', dueAt: null, tasks: [{ id, version: 1 }, { id: id.toUpperCase(), version: 2 }] }).success).toBe(false);
});
