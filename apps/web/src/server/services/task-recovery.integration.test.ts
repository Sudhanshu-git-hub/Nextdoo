import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditLogs, outbox, reminders, syncChanges, syncTombstones, taskDependencies, tasks, taskTags } from '@nextdoo/db';
import { limitsFor, taskQuerySchema } from '@nextdoo/contracts';
import { requireTestDatabase } from '../../../../../tests/database';
import { getDb } from '../db';
import { registerUser } from './accounts';
import { createProject, createTag, setProjectArchived } from './projects';
import { archiveTask, createTask, deleteTask, loadTask, queryTasks, restoreTask, updateTask } from './tasks';
import { createSubtask, updateTaskRelations } from './task-relations';
import { createReminder } from './reminders';
import * as events from './events';
await requireTestDatabase();
const remove = deleteTask, restore = restoreTask;
async function fixture() {
 const u = await registerUser({ email: `recovery-${randomUUID()}@test.local`, passwordHash: 'test', name: null, timeZone: 'UTC' });
 const actor = { userId: u.id, workspaceId: u.workspaceId };
 const task = await createTask(actor, { workspaceId: u.workspaceId, title: 'Recoverable', tagIds: [], priority: 'NONE' });
 return { actor, task };
}
it('archive and restore commit versions, sync, outbox and content-free audit together', async () => {
 const { actor, task } = await fixture();
 const archived = await archiveTask(actor, task.id, task.version);
 const active = await restore(actor, task.id, archived.version);
 expect(active).toMatchObject({ status: 'ACTIVE', version: 3, archivedAt: null });
 expect(await getDb().select().from(syncChanges).where(eq(syncChanges.entityId, task.id))).toHaveLength(3);
 expect(await getDb().select().from(outbox).where(eq(outbox.entityId, task.id))).toHaveLength(3);
 const audit = await getDb().select().from(auditLogs).where(eq(auditLogs.targetId, task.id));
 expect(audit).toHaveLength(3); expect(JSON.stringify(audit)).not.toContain('Recoverable');
});
it('stale delete and restore requests cannot mutate a task changed elsewhere', async () => {
 const { actor, task } = await fixture();
 const updated = await updateTask(actor, task.id, { version: 1, title: 'Newer edit' });
 await expect(remove(actor, task.id, 1)).rejects.toMatchObject({ code: 'RESOURCE_VERSION_CONFLICT' });
 await remove(actor, task.id, updated.version);
 await expect(restore(actor, task.id, updated.version)).rejects.toMatchObject({ code: 'RESOURCE_VERSION_CONFLICT' });
 const active = await restore(actor, task.id, updated.version + 1);
 expect(active).toMatchObject({ title: 'Newer edit', version: 4, status: 'ACTIVE' });
 await expect(remove(actor, task.id, 1)).rejects.toMatchObject({ code: 'RESOURCE_VERSION_CONFLICT' });
});
it('explicit Trash queries return only this workspace’s recoverable tasks; ordinary reads still hide them', async () => {
 const a = await fixture(), b = await fixture();
 await remove(a.actor, a.task.id, 1); await remove(b.actor, b.task.id, 1);
 const query = taskQuerySchema.parse({ workspaceId: a.actor.workspaceId, status: 'DELETED' });
 const trash = await queryTasks(a.actor.workspaceId, query);
 expect(trash.data).toHaveLength(1);
 expect(trash.data[0]).toMatchObject({ id: a.task.id, status: 'DELETED', version: 2 });
 expect(trash.data[0]).toHaveProperty('restoreUntil'); expect(trash.data[0]).toHaveProperty('deletedAt');
 expect((await queryTasks(a.actor.workspaceId, taskQuerySchema.parse({ workspaceId: a.actor.workspaceId, includeArchived: true }))).data).toHaveLength(0);
 await expect(loadTask(a.actor.workspaceId, a.task.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
 await expect(restore(a.actor, b.task.id, 2)).rejects.toMatchObject({ code: 'NOT_FOUND' });
 await getDb().update(tasks).set({ deletedAt: new Date(Date.now() - 31 * 86400000) }).where(eq(tasks.id, a.task.id));
 expect((await queryTasks(a.actor.workspaceId, query)).data).toHaveLength(0);
 await expect(restore(a.actor, a.task.id, 2)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
});
it('deletion and recovery preserve relationships and tags without reviving canceled reminders or moving projects', async () => {
 const { actor, task } = await fixture();
 const project = await createProject(actor, { name: 'Preserved project' });
 const tag = await createTag(actor.workspaceId, 'keep');
 const parent = await updateTask(actor, task.id, { version: 1, projectId: project.id, tagIds: [tag.id], dueAt: '2026-09-09T12:00:00Z', estimateMinutes: 12 });
 const child = await createSubtask(actor, task.id, { version: parent.version, title: 'Independent child' });
 await updateTaskRelations(actor, child.id, { version: 1, addDependencyId: task.id });
 const reminder = await createReminder(actor, { taskId: task.id, minutesBeforeDue: 5, channel: 'WEB' });
 await remove(actor, task.id, parent.version);
 await setProjectArchived(actor, project.id, 1, true);
 const restored = await restore(actor, task.id, parent.version + 1);
 expect(restored).toMatchObject({ status: 'ACTIVE', projectId: project.id, estimateMinutes: 12, dueAt: '2026-09-09T12:00:00.000Z' });
 expect(await getDb().select().from(taskTags).where(eq(taskTags.taskId, task.id))).toHaveLength(1);
 expect(await getDb().select().from(taskDependencies).where(eq(taskDependencies.taskId, child.id))).toHaveLength(1);
 expect(await loadTask(actor.workspaceId, child.id)).toMatchObject({ status: 'ACTIVE', parentTaskId: task.id, version: 2 });
 expect((await getDb().select().from(reminders).where(eq(reminders.id, reminder!.id)))[0]?.status).toBe('CANCELED');
 expect(await getDb().select().from(syncTombstones).where(eq(syncTombstones.entityId, task.id))).toHaveLength(0);
});
it('concurrent restores honor the active-task limit and stale concurrent deletes return a conflict', async () => {
 const { actor, task } = await fixture();
 const other = await createTask(actor, { workspaceId: actor.workspaceId, title: 'Other', priority: 'NONE', tagIds: [] });
 await archiveTask(actor, task.id, 1); await archiveTask(actor, other.id, 1);
 await getDb().insert(tasks).values(Array.from({ length: limitsFor('FREE').activeTasks! - 1 }, () => ({ id: randomUUID(), workspaceId: actor.workspaceId, title: 'Capacity' })));
 const results = await Promise.allSettled([restore(actor, task.id, 2), restore(actor, other.id, 2)]);
 expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
 expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'ENTITLEMENT_LIMIT_REACHED' } });
 const currentVersion = (await getDb().select().from(tasks).where(eq(tasks.id, task.id)))[0]!.version;
 const deletes = await Promise.allSettled([remove(actor, task.id, currentVersion), remove(actor, task.id, currentVersion)]);
 expect(deletes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
 expect(deletes.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'RESOURCE_VERSION_CONFLICT' } });
});
it('archive and restore audit failures roll back every state change and emitted event', async () => {
 const { actor, task } = await fixture();
 let spy = vi.spyOn(events, 'writeAudit').mockRejectedValueOnce(new Error('audit failure'));
 try { await expect(archiveTask(actor, task.id, 1)).rejects.toThrow('audit failure'); } finally { spy.mockRestore(); }
 expect((await loadTask(actor.workspaceId, task.id)).status).toBe('ACTIVE');
 await archiveTask(actor, task.id, 1);
 spy = vi.spyOn(events, 'writeAudit').mockRejectedValueOnce(new Error('audit failure'));
 try { await expect(restore(actor, task.id, 2)).rejects.toThrow('audit failure'); } finally { spy.mockRestore(); }
 expect(await loadTask(actor.workspaceId, task.id)).toMatchObject({ status: 'ARCHIVED', version: 2 });
 expect(await getDb().select().from(outbox).where(and(eq(outbox.entityId, task.id), eq(outbox.eventType, 'task.restored')))).toHaveLength(0);
});
it('the recovery cutoff is exclusive and Trash pagination preserves all recoverable rows with precise timestamps', async () => {
 const { actor } = await fixture();
 const now = Date.now(), window = 30 * 86400000;
 vi.useFakeTimers({ toFake: ['Date'] });
 try {
  vi.setSystemTime(now);
  const ids = Array.from({ length: 52 }, () => randomUUID());
  await getDb().insert(tasks).values(ids.map((id) => ({ id, workspaceId: actor.workspaceId, title: 'Trash page', status: 'DELETED' as const, deletedAt: new Date(now - window + 1) })));
  const boundary = randomUUID();
  await getDb().insert(tasks).values({ id: boundary, workspaceId: actor.workspaceId, title: 'At cutoff', status: 'DELETED', deletedAt: new Date(now - window) });
  const query = taskQuerySchema.parse({ workspaceId: actor.workspaceId, status: 'DELETED', limit: 50 });
  const first = await queryTasks(actor.workspaceId, query);
  const second = await queryTasks(actor.workspaceId, { ...query, cursor: first.nextCursor! });
  expect(first.data).toHaveLength(50); expect(second.data).toHaveLength(2);
  expect(new Set([...first.data, ...second.data].map((t) => t.id))).toEqual(new Set(ids));
  await expect(restore(actor, boundary, 1)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  vi.setSystemTime(now + 1);
  expect((await queryTasks(actor.workspaceId, query)).data).toHaveLength(0);
 } finally { vi.useRealTimers(); }
});
