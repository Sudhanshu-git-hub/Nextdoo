import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { and, asc, eq, sql } from 'drizzle-orm';
import { auditLogs, outbox, syncChanges, taskDependencies, tasks, users } from '@nextdoo/db';
import { taskQuerySchema } from '@nextdoo/contracts';
import { requireTestDatabase } from '../../../../../tests/database';
import { getDb } from '../db';
import { registerUser } from './accounts';
import { createTask, queryTasks, loadTask, deleteTask, completeTask } from './tasks';
import { createProject, setProjectArchived } from './projects';
import * as relations from './task-relations';
import * as events from './events';
await requireTestDatabase();
async function fixture() {
 const u = await registerUser({ email: `relations-${randomUUID()}@test.local`, passwordHash: 'test', name: null, timeZone: 'UTC' });
 const actor = { workspaceId: u.workspaceId, userId: u.id };
 const task = await createTask(actor, { workspaceId: actor.workspaceId, title: 'Parent', priority: 'NONE', tagIds: [] });
 return { actor, task };
}
it('creates a real subtask in the parent project without copying dates or changing parent status', async () => {
 const { actor } = await fixture(); const project = await createProject(actor, { name: 'Work' });
 const parent = await createTask(actor, { workspaceId: actor.workspaceId, projectId: project.id, title: 'Dated parent', dueAt: '2026-09-08T12:00:00Z', priority: 'HIGH', tagIds: [] });
 const child = await relations.createSubtask(actor, parent.id, { version: parent.version, title: 'Child' });
 expect(child).toMatchObject({ parentTaskId: parent.id, projectId: project.id, dueAt: null, status: 'ACTIVE' });
 expect(await loadTask(actor.workspaceId, parent.id)).toMatchObject({ version: 1, status: 'ACTIVE' });
 const found = await queryTasks(actor.workspaceId, taskQuerySchema.parse({ workspaceId: actor.workspaceId, parentTaskId: parent.id }));
 expect(found.data.map((t) => t.id)).toEqual([child.id]);
 expect((await relations.getTaskRelations(actor.workspaceId, child.id)).parent?.id).toBe(parent.id);
 await setProjectArchived(actor, project.id, 1, true);
 await expect(relations.createSubtask(actor, parent.id, { version: 1, title: 'Archived project child' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
});
it('reparenting and dependency updates are versioned, atomic and auditable without task text', async () => {
 const { actor, task } = await fixture();
 const child = await relations.createSubtask(actor, task.id, { version: 1, title: 'Private child' });
 const updated = await relations.updateTaskRelations(actor, child.id, { version: 1, parentTaskId: null, addDependencyId: task.id });
 expect(updated).toMatchObject({ parentTaskId: null, version: 2 });
 expect(await getDb().select().from(taskDependencies).where(eq(taskDependencies.taskId, child.id))).toHaveLength(1);
 const changes = await getDb().select().from(syncChanges).where(eq(syncChanges.entityId, child.id)).orderBy(asc(syncChanges.sequence));
 expect(changes).toHaveLength(2); expect(changes[1]?.payload).toMatchObject({ version: 2, parentTaskId: null, relationsChanged: true });
 expect(await getDb().select().from(outbox).where(eq(outbox.entityId, child.id))).toHaveLength(2);
 const audit = await getDb().select().from(auditLogs).where(eq(auditLogs.targetId, child.id));
 expect(audit).toHaveLength(2); expect(JSON.stringify(audit)).not.toContain('Private child');
 await expect(relations.updateTaskRelations(actor, child.id, { version: 1, removeDependencyId: task.id })).rejects.toMatchObject({ code: 'RESOURCE_VERSION_CONFLICT' });
 await relations.updateTaskRelations(actor, child.id, { version: 2, removeDependencyId: task.id });
 expect(await getDb().select().from(taskDependencies).where(eq(taskDependencies.taskId, child.id))).toHaveLength(0);
});
it('rejects parent and dependency cycles, including simultaneous opposing edits', async () => {
 const { actor, task: a } = await fixture();
 const b = await relations.createSubtask(actor, a.id, { version: 1, title: 'B' });
 await expect(relations.updateTaskRelations(actor, a.id, { version: 1, parentTaskId: b.id })).rejects.toMatchObject({ code: 'DEPENDENCY_CYCLE' });
 await expect(relations.updateTaskRelations(actor, a.id, { version: 1, parentTaskId: a.id })).rejects.toMatchObject({ code: 'DEPENDENCY_CYCLE' });
 const results = await Promise.allSettled([
  relations.updateTaskRelations(actor, a.id, { version: 1, addDependencyId: b.id }),
  relations.updateTaskRelations(actor, b.id, { version: 1, addDependencyId: a.id }),
 ]);
 expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
 expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'DEPENDENCY_CYCLE' } });
});
it('foreign/deleted targets cannot be attached and relation reads and filters are tenant-scoped', async () => {
 const a = await fixture(), b = await fixture();
 await expect(relations.getTaskRelations(a.actor.workspaceId, b.task.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
 for (const patch of [{ parentTaskId: b.task.id }, { addDependencyId: b.task.id }]) await expect(relations.updateTaskRelations(a.actor, a.task.id, { version: 1, ...patch })).rejects.toMatchObject({ code: 'NOT_FOUND' });
 await expect(queryTasks(a.actor.workspaceId, taskQuerySchema.parse({ workspaceId: a.actor.workspaceId, parentTaskId: b.task.id }))).rejects.toMatchObject({ code: 'NOT_FOUND' });
 await expect(queryTasks(a.actor.workspaceId, taskQuerySchema.parse({ workspaceId: a.actor.workspaceId, dependencyOfTaskId: b.task.id }))).rejects.toMatchObject({ code: 'NOT_FOUND' });
 await deleteTask(b.actor, b.task.id);
 await expect(relations.createSubtask(b.actor, b.task.id, { version: 2, title: 'No' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
});
it('audit failure rolls back the edge, task version, sync and outbox', async () => {
 const { actor, task } = await fixture(); const child = await relations.createSubtask(actor, task.id, { version: 1, title: 'Child' });
 const spy = vi.spyOn(events, 'writeAudit').mockRejectedValueOnce(new Error('audit down'));
 try { await expect(relations.updateTaskRelations(actor, child.id, { version: 1, addDependencyId: task.id })).rejects.toThrow('audit down'); }
 finally { spy.mockRestore(); }
 expect((await loadTask(actor.workspaceId, child.id)).version).toBe(1);
 expect(await getDb().select().from(taskDependencies).where(eq(taskDependencies.taskId, child.id))).toHaveLength(0);
 expect(await getDb().select().from(syncChanges).where(eq(syncChanges.entityId, child.id))).toHaveLength(1);
 expect(await getDb().select().from(outbox).where(eq(outbox.entityId, child.id))).toHaveLength(1);
});
it('completion and soft deletion do not cascade; a child can detach from an unavailable parent', async () => {
 const { actor, task } = await fixture(); const child = await relations.createSubtask(actor, task.id, { version: 1, title: 'Child' });
 await completeTask(actor, task.id, 1);
 expect((await loadTask(actor.workspaceId, child.id)).status).toBe('ACTIVE');
 await deleteTask(actor, task.id);
 expect(await relations.getTaskRelations(actor.workspaceId, child.id)).toMatchObject({ parent: null, parentUnavailable: true });
 await relations.updateTaskRelations(actor, child.id, { version: 1, parentTaskId: null });
 expect((await loadTask(actor.workspaceId, child.id)).parentTaskId).toBeNull();
});
it('permanent deletion of a referenced parent cannot silently cascade-delete its live child', async () => {
 const { actor, task } = await fixture();
 const child = await createTask(actor, { workspaceId: actor.workspaceId, title: 'Survives', parentTaskId: task.id, priority: 'NONE', tagIds: [] });
 await expect(getDb().delete(tasks).where(and(eq(tasks.id, task.id), eq(tasks.workspaceId, actor.workspaceId)))).rejects.toThrow();
 expect((await loadTask(actor.workspaceId, child.id)).status).toBe('ACTIVE');
});
it('unsupported offline relationship commands are rejected rather than falsely acknowledged', async () => {
 const { actor, task } = await fixture();
 const child = await relations.createSubtask(actor, task.id, { version: 1, title: 'Child' });
 const { pushMutations } = await import('./sync');
 const input = { deviceId: 'relation-test', mutations: [{ mutationId: randomUUID(), entityId: task.id, entityType: 'task' as const, operation: 'update' as const, baseVersion: 1, payload: { addDependencyId: child.id }, createdAt: new Date().toISOString() }] };
 expect((await pushMutations(actor, input)).results[0]).toMatchObject({ status: 'rejected', error: { code: 'VALIDATION_FAILED' } });
 expect((await loadTask(actor.workspaceId, task.id)).version).toBe(1);
});

it('long parent/dependency cycles through deleted nodes are rejected and deleted targets cannot receive new links', async () => {
 const { actor, task: a } = await fixture();
 const b = await relations.createSubtask(actor, a.id, { version: 1, title: 'B' });
 const c = await relations.createSubtask(actor, b.id, { version: 1, title: 'C' });
 await relations.updateTaskRelations(actor, a.id, { version: 1, addDependencyId: b.id });
 await relations.updateTaskRelations(actor, b.id, { version: 1, addDependencyId: c.id });
 await deleteTask(actor, b.id);
 await expect(relations.updateTaskRelations(actor, c.id, { version: 1, addDependencyId: a.id })).rejects.toMatchObject({ code: 'DEPENDENCY_CYCLE' });
 await expect(relations.updateTaskRelations(actor, a.id, { version: 2, parentTaskId: c.id })).rejects.toMatchObject({ code: 'DEPENDENCY_CYCLE' });
 for (const patch of [{ addDependencyId: b.id }, { parentTaskId: b.id }]) await expect(relations.updateTaskRelations(actor, c.id, { version: 1, ...patch })).rejects.toMatchObject({ code: 'NOT_FOUND' });
 // Removing a retained edge is allowed even though the prerequisite is deleted.
 await relations.updateTaskRelations(actor, a.id, { version: 2, removeDependencyId: b.id });
 expect(await getDb().select().from(taskDependencies).where(eq(taskDependencies.taskId, a.id))).toHaveLength(0);
});
it('simultaneous edits of the same source task cannot overwrite a newer relationship', async () => {
 const { actor, task } = await fixture();
 const child = await relations.createSubtask(actor, task.id, { version: 1, title: 'Child' });
 const results = await Promise.allSettled([
  relations.updateTaskRelations(actor, child.id, { version: 1, parentTaskId: null }),
  relations.updateTaskRelations(actor, child.id, { version: 1, addDependencyId: task.id }),
 ]);
 expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
 expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'RESOURCE_VERSION_CONFLICT' } });
});
it('subtask filtering happens before bounded pagination and prerequisite filtering returns only linked tasks', async () => {
 const { actor, task } = await fixture();
 const ids = Array.from({ length: 52 }, () => randomUUID());
 await getDb().insert(tasks).values(ids.map((id) => ({ id, workspaceId: actor.workspaceId, parentTaskId: task.id, title: 'Paged child', createdAt: sql`'2026-09-08T12:00:00.123456Z'::timestamptz` })));
 const query = taskQuerySchema.parse({ workspaceId: actor.workspaceId, parentTaskId: task.id, limit: 50 });
 const first = await queryTasks(actor.workspaceId, query);
 const second = await queryTasks(actor.workspaceId, { ...query, cursor: first.nextCursor! });
 expect(first.data).toHaveLength(50); expect(first.hasMore).toBe(true);
 expect(second.data).toHaveLength(2); expect(second.hasMore).toBe(false);
 expect(new Set([...first.data, ...second.data].map((t) => t.id))).toEqual(new Set(ids));
 for (const payload of [{ c: 'not-a-date', i: ids[0] }, { c: '2026-09-08T12:00:00Z', i: 'bad-id' }]) {
  await expect(queryTasks(actor.workspaceId, { ...query, cursor: Buffer.from(JSON.stringify(payload)).toString('base64url') })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
 }
 await relations.updateTaskRelations(actor, task.id, { version: 1, addDependencyId: ids[0]! });
 const dependencies = await queryTasks(actor.workspaceId, taskQuerySchema.parse({ workspaceId: actor.workspaceId, dependencyOfTaskId: task.id }));
 expect(dependencies.data.map((t) => t.id)).toEqual([ids[0]]);
});
it('the non-cascading parent constraint still permits authorized account purge of an entire hierarchy', async () => {
 const { actor, task } = await fixture();
 const child = await relations.createSubtask(actor, task.id, { version: 1, title: 'Child' });
 await relations.updateTaskRelations(actor, child.id, { version: 1, addDependencyId: task.id });
 await getDb().update(users).set({ deletionRequestedAt: new Date(Date.now() - 31 * 86400000) }).where(eq(users.id, actor.userId));
 const { purgeDueAccounts } = await import('./data-rights');
 expect(await purgeDueAccounts()).toContain(actor.userId);
 expect(await getDb().select().from(tasks).where(eq(tasks.workspaceId, actor.workspaceId))).toHaveLength(0);
 expect(await getDb().select().from(taskDependencies).where(eq(taskDependencies.taskId, child.id))).toHaveLength(0);
});
