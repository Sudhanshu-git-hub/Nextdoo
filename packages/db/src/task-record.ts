import { tasks } from './schema';
const TASK_RESTORE_WINDOW_MS = 30 * 86_400_000;
export function serialiseTaskRecord(task: typeof tasks.$inferSelect) {
  return {
    id: task.id,
    workspaceId: task.workspaceId,
    projectId: task.projectId,
    sectionId: task.sectionId,
    parentTaskId: task.parentTaskId,
    recurrenceRuleId: task.recurrenceRuleId,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    dueAt: task.dueAt?.toISOString() ?? null,
    timeZone: task.timeZone,
    estimateMinutes: task.estimateMinutes,
    actualMinutes: task.actualMinutes,
    actualSeconds: task.actualMinutes * 60 + task.actualSecondsRemainder,
    position: Number(task.position),
    rescheduleCount: task.rescheduleCount,
    version: task.version,
    completedAt: task.completedAt?.toISOString() ?? null,
    archivedAt: task.archivedAt?.toISOString() ?? null,
    deletedAt: task.deletedAt?.toISOString() ?? null,
    restoreUntil: task.status === 'DELETED' && task.deletedAt ? new Date(task.deletedAt.getTime() + TASK_RESTORE_WINDOW_MS).toISOString() : null,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  };
}

