import { AppError, bulkTaskSchema, type BulkTaskInput } from '@nextdoo/contracts';
import { archiveTask, completeTask, rescheduleTask, type SerialisedTask, type TaskActor } from './tasks';
import { withWorkspaceTransaction } from './transactions';
import { writeAudit } from './events';

/** User-selected all-or-nothing policy. Nested services share the AsyncLocalStorage transaction. */
export async function bulkTasks(actor: TaskActor, raw: BulkTaskInput): Promise<{ data: SerialisedTask[] }> {
  const input = bulkTaskSchema.parse(raw);
  if (input.workspaceId !== actor.workspaceId) throw new AppError('FORBIDDEN', 'This workspace is not available.');
  return withWorkspaceTransaction(actor.workspaceId, async (db) => {
    const data: SerialisedTask[] = [];
    const completedAt = new Date().toISOString();
    for (const { id, version } of input.tasks) {
      // Do not catch per-row errors: every task, event, reminder, tracking result and sync change rolls back.
      data.push(input.operation === 'complete' ? await completeTask(actor, id, version, completedAt)
        : input.operation === 'archive' ? await archiveTask(actor, id, version)
        : await rescheduleTask(actor, id, version, input.dueAt, input.reason));
    }
    await writeAudit(db, { workspaceId: actor.workspaceId, actorId: actor.userId,
      action: `tasks.bulk.${input.operation}`, targetType: 'workspace', targetId: actor.workspaceId,
      requestId: actor.requestId, metadata: { count: data.length } });
    return { data };
  });
}
