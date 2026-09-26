import type { FocusSnapshot, QueuedMutation } from './offline-queue';
export function focusElapsed(timer: FocusSnapshot, now = Date.now()) {
  return Math.max(0, timer.elapsedSeconds + (timer.status === 'RUNNING' ? Math.floor((now - Date.parse(timer.observedAt)) / 1000) : 0));
}
/** Derive the local view from durable commands, never from a second timer database. */
export function projectFocus(base: FocusSnapshot | null, queued: QueuedMutation[]): FocusSnapshot | null {
  let current = base;
  for (const command of queued.filter(q => q.entityType === 'timer_session')) {
    if (command.payload.action === 'adjust') continue;
    if (command.operation === 'create') {
      current = { id: command.entityId, taskId: String(command.payload.taskId), status: 'RUNNING',
        startedAt: String(command.payload.startedAt), observedAt: String(command.payload.startedAt), elapsedSeconds: 0, version: 1 };
    } else if (current?.id === command.entityId) {
      const at = String(command.payload.at), action = command.payload.action;
      current = { ...current, elapsedSeconds: focusElapsed(current, Date.parse(at)), observedAt: at, version: current.version + 1,
        status: action === 'pause' ? 'PAUSED' : action === 'resume' ? 'RUNNING' : 'STOPPED' };
    }
  }
  return current && ['RUNNING','PAUSED'].includes(current.status) ? current : null;
}
