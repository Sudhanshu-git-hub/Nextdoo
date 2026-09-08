/** Shared domain enums. Values are persisted, so they must never be renamed without a migration. */

export const TASK_STATUS = ['ACTIVE', 'COMPLETED', 'ARCHIVED', 'DELETED'] as const;
export type TaskStatus = (typeof TASK_STATUS)[number];

export const TASK_PRIORITY = ['NONE', 'LOW', 'MEDIUM', 'HIGH'] as const;
export type TaskPriority = (typeof TASK_PRIORITY)[number];

/** Numeric ordering for sorting; keeps SQL ORDER BY simple and index-friendly. */
export const PRIORITY_RANK: Record<TaskPriority, number> = { NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3 };

export const PROJECT_STATUS = ['ACTIVE', 'ARCHIVED'] as const;
export type ProjectStatus = (typeof PROJECT_STATUS)[number];

/** PRD §7.2 — append-only execution history. */
export const TRACKING_EVENT_TYPE = [
  'TASK_CREATED',
  'TASK_PLANNED',
  'TASK_STARTED',
  'TASK_PAUSED',
  'TASK_COMPLETED',
  'TASK_RESCHEDULED',
  'TASK_SKIPPED',
  'TASK_REOPENED',
  'TASK_ARCHIVED',
  'TIME_LOGGED',
  'ESTIMATE_CHANGED',
  'RECURRENCE_GENERATED',
] as const;
export type TrackingEventType = (typeof TRACKING_EVENT_TYPE)[number];

/** PRD §7.3 — `UNMEASURED` is required rather than fabricating a score. */
export const EXECUTION_OUTCOME = [
  'ON_TIME',
  'LATE',
  'EARLY',
  'RESCHEDULED',
  'SKIPPED',
  'INCOMPLETE',
  'UNMEASURED',
] as const;
export type ExecutionOutcome = (typeof EXECUTION_OUTCOME)[number];

export const REMINDER_STATUS = ['SCHEDULED', 'PROCESSING', 'SENT', 'FAILED', 'CANCELED', 'EXPIRED'] as const;
export type ReminderStatus = (typeof REMINDER_STATUS)[number];

export const REMINDER_CHANNEL = ['WEB', 'DESKTOP', 'EMAIL'] as const;
export type ReminderChannel = (typeof REMINDER_CHANNEL)[number];

export const TIMER_STATUS = ['RUNNING', 'PAUSED', 'STOPPED', 'OVERLAPPED'] as const;
export type TimerStatus = (typeof TIMER_STATUS)[number];

export const SUBSCRIPTION_STATUS = [
  'TRIALING',
  'ACTIVE',
  'PAST_DUE',
  'GRACE_PERIOD',
  'CANCELED',
  'EXPIRED',
  'PAUSED',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUS)[number];

export const PLAN = ['FREE', 'PRO', 'TEAM', 'ENTERPRISE'] as const;
export type Plan = (typeof PLAN)[number];

export const SYNC_OPERATION = ['create', 'update', 'delete'] as const;
export type SyncOperation = (typeof SYNC_OPERATION)[number];

export const SYNC_ENTITY_TYPE = ['task', 'project', 'section', 'tag', 'timer_session'] as const;
export type SyncEntityType = (typeof SYNC_ENTITY_TYPE)[number];

export const MUTATION_RESULT_STATUS = ['applied', 'duplicate', 'conflict', 'rejected'] as const;
export type MutationResultStatus = (typeof MUTATION_RESULT_STATUS)[number];

export const RECURRENCE_FREQ = ['DAILY', 'WEEKLY', 'MONTHLY'] as const;
export type RecurrenceFreq = (typeof RECURRENCE_FREQ)[number];

export const ATTACHMENT_SCAN_STATUS = ['PENDING', 'CLEAN', 'INFECTED', 'FAILED'] as const;
export type AttachmentScanStatus = (typeof ATTACHMENT_SCAN_STATUS)[number];
