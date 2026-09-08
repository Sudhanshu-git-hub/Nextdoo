import { AppError, type TaskStatus } from '@nextdoo/contracts';

/**
 * Task lifecycle state machine (PRD §6.3).
 *
 * Transitions are enumerated rather than inferred so that an unexpected
 * combination fails loudly instead of silently corrupting history.
 */

export type TaskAction = 'complete' | 'reopen' | 'archive' | 'restore' | 'delete' | 'purge';

interface Transition {
  from: TaskStatus;
  action: TaskAction;
  to: TaskStatus | 'PURGED';
}

const TRANSITIONS: Transition[] = [
  { from: 'ACTIVE', action: 'complete', to: 'COMPLETED' },
  { from: 'ACTIVE', action: 'archive', to: 'ARCHIVED' },
  { from: 'ACTIVE', action: 'delete', to: 'DELETED' },
  { from: 'COMPLETED', action: 'reopen', to: 'ACTIVE' },
  { from: 'COMPLETED', action: 'archive', to: 'ARCHIVED' },
  { from: 'COMPLETED', action: 'delete', to: 'DELETED' },
  { from: 'ARCHIVED', action: 'restore', to: 'ACTIVE' },
  { from: 'ARCHIVED', action: 'delete', to: 'DELETED' },
  { from: 'DELETED', action: 'restore', to: 'ACTIVE' },
  { from: 'DELETED', action: 'purge', to: 'PURGED' },
];

export function canTransition(from: TaskStatus, action: TaskAction): boolean {
  return TRANSITIONS.some((t) => t.from === from && t.action === action);
}

export function nextStatus(from: TaskStatus, action: TaskAction): TaskStatus | 'PURGED' {
  const match = TRANSITIONS.find((t) => t.from === from && t.action === action);
  if (!match) {
    throw new AppError('VALIDATION_FAILED', `Cannot ${action} a task that is ${from.toLowerCase()}.`);
  }
  return match.to;
}

export function allowedActions(from: TaskStatus): TaskAction[] {
  return TRANSITIONS.filter((t) => t.from === from).map((t) => t.action);
}

/**
 * PRD §6.3: a deleted task may only be purged once no immutable tracking record
 * still requires it. The caller supplies that fact; the rule lives here.
 */
export function canPurge(status: TaskStatus, hasRetainedTrackingHistory: boolean, retentionElapsed: boolean): boolean {
  if (status !== 'DELETED') return false;
  if (!retentionElapsed) return false;
  return !hasRetainedTrackingHistory;
}
