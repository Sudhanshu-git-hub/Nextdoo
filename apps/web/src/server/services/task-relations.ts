import { and, eq, isNull, sql } from 'drizzle-orm';
import { AppError, createSubtaskSchema, updateTaskRelationsSchema, uuid, versionConflict, type CreateSubtaskInput, type UpdateTaskRelationsInput } from '@nextdoo/contracts';
import { tasks, taskDependencies, type Database } from '@nextdoo/db';
import { withWorkspaceTransaction } from './transactions';
import { createTask, loadTask, serialiseTask, type TaskActor } from './tasks';
import { publishEvent, recordSyncChange, writeAudit } from './events';

/** Ancestors/prerequisites include soft-deleted nodes so later restore cannot introduce a cycle. */
async function rejectCycle(db: Database, workspaceId: string, id: string, targetId: string, kind: 'parent' | 'dependency') {
  const reachable = kind === 'parent'
    ? await db.execute(sql`WITH RECURSIVE chain(id) AS (
        SELECT id FROM tasks WHERE id = ${targetId} AND workspace_id = ${workspaceId}
        UNION SELECT t.parent_task_id FROM tasks t JOIN chain c ON t.id = c.id
        WHERE t.workspace_id = ${workspaceId} AND t.parent_task_id IS NOT NULL
      ) SELECT id FROM chain WHERE id = ${id} LIMIT 1`)
    : await db.execute(sql`WITH RECURSIVE chain(id) AS (
        SELECT id FROM tasks WHERE id = ${targetId} AND workspace_id = ${workspaceId}
        UNION SELECT d.depends_on_task_id FROM task_dependencies d JOIN chain c ON d.task_id = c.id
        JOIN tasks t ON t.id = d.depends_on_task_id WHERE t.workspace_id = ${workspaceId}
      ) SELECT id FROM chain WHERE id = ${id} LIMIT 1`);
  if (reachable.length) throw new AppError('DEPENDENCY_CYCLE', kind === 'parent' ? 'A task cannot be its own ancestor.' : 'This prerequisite would create a dependency cycle.');
}

export async function createSubtask(actor: TaskActor, parentId: string, input: CreateSubtaskInput) {
  uuid.parse(parentId); input = createSubtaskSchema.parse(input);
  return withWorkspaceTransaction(actor.workspaceId, async () => {
    const parent = await loadTask(actor.workspaceId, parentId);
    if (parent.version !== input.version) throw versionConflict('task', parentId);
    // Initial organization only: later edits, dates and lifecycle remain independent.
    return createTask(actor, { workspaceId: actor.workspaceId, title: input.title, parentTaskId: parentId,
      projectId: parent.projectId, sectionId: parent.sectionId, priority: 'NONE', tagIds: [],
    });
  });
}

export async function updateTaskRelations(actor: TaskActor, id: string, input: UpdateTaskRelationsInput) {
  uuid.parse(id); input = updateTaskRelationsSchema.parse(input);
  return withWorkspaceTransaction(actor.workspaceId, async (db) => {
    const current = await loadTask(actor.workspaceId, id);
    if (current.version !== input.version) throw versionConflict('task', id);
    if (input.parentTaskId) {
      await loadTask(actor.workspaceId, input.parentTaskId);
      await rejectCycle(db, actor.workspaceId, id, input.parentTaskId, 'parent');
    }
    if (input.addDependencyId) {
      await loadTask(actor.workspaceId, input.addDependencyId);
      await rejectCycle(db, actor.workspaceId, id, input.addDependencyId, 'dependency');
    }
    // Removing an edge to a deleted/missing target must remain possible. The source
    // is authorized and the delete can touch only this source's own edge.
    if (input.removeDependencyId) await db.delete(taskDependencies).where(and(eq(taskDependencies.taskId, id), eq(taskDependencies.dependsOnTaskId, input.removeDependencyId)));
    if (input.addDependencyId) await db.insert(taskDependencies).values({ taskId: id, dependsOnTaskId: input.addDependencyId }).onConflictDoNothing();
    const [row] = await db.update(tasks).set({ ...(input.parentTaskId !== undefined ? { parentTaskId: input.parentTaskId } : {}), version: current.version + 1, updatedAt: new Date() })
      .where(and(eq(tasks.workspaceId, actor.workspaceId), eq(tasks.id, id), eq(tasks.version, input.version))).returning();
    if (!row) throw versionConflict('task', id);
    const changes = Object.fromEntries(Object.entries(input).filter(([field]) => field !== 'version'));
    const fields = Object.keys(changes);
    const result = serialiseTask(row);
    // A relationship update invalidates the paged relation reads. It is not a
    // complete offline graph snapshot, and omitted fields in other task deltas do not clear links.
    await recordSyncChange(db, { workspaceId: actor.workspaceId, entityType: 'task', entityId: id, operation: 'update', version: row.version, deviceId: actor.deviceId, payload: { ...result, relationsChanged: true, relationshipChanges: changes } });
    await publishEvent(db, { workspaceId: actor.workspaceId, actorId: actor.userId, entityType: 'task', entityId: id, eventType: 'task.updated', correlationId: actor.requestId, payload: { fields, version: row.version, changes } });
    await writeAudit(db, { workspaceId: actor.workspaceId, actorId: actor.userId, targetType: 'task', targetId: id, action: 'task.relationships_updated', requestId: actor.requestId, metadata: { fields, version: row.version, changes } });
    return result;
  });
}

export async function getTaskRelations(workspaceId: string, id: string) {
  uuid.parse(id);
  return withWorkspaceTransaction(workspaceId, async (db) => {
    const task = await loadTask(workspaceId, id);
    const [parent] = task.parentTaskId ? await db.select().from(tasks).where(and(eq(tasks.id, task.parentTaskId), eq(tasks.workspaceId, workspaceId), isNull(tasks.deletedAt))) : [];
    return { task: serialiseTask(task), parent: parent ? serialiseTask(parent) : null, parentUnavailable: !!task.parentTaskId && !parent };
  });
}
