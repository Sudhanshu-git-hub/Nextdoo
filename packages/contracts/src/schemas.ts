import { z } from 'zod';
import {
  MUTATION_RESULT_STATUS,
  RECURRENCE_FREQ,
  REMINDER_CHANNEL,
  SYNC_ENTITY_TYPE,
  SYNC_OPERATION,
  TASK_PRIORITY,
  TASK_STATUS,
} from './enums';

/**
 * Server-side validation schemas. Every mutating route must parse its body
 * through one of these before touching domain logic (PRD §11.5).
 */

export const uuid = z.string().uuid();
export const isoDateTime = z.string().datetime({ offset: true });

/** IANA time zone, validated against the host ICU database. */
export const timeZone = z.string().min(1).max(64).refine(
  (tz) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  },
  { message: 'Unknown IANA time zone' },
);

// ---------------------------------------------------------------- auth

export const emailSchema = z.string().trim().toLowerCase().email().max(254);

/**
 * Minimum 12 characters per PRD §11.2. Length is favoured over composition
 * rules, which push users toward predictable substitutions.
 */
export const passwordSchema = z.string().min(12, 'Use at least 12 characters').max(200);

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: z.string().trim().min(1).max(120).optional(),
  timeZone: timeZone.default('UTC'),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
  /**
   * Second factor: a 6-digit TOTP code, or a recovery code. Recovery codes must
   * be accepted here — a user locked out of their authenticator has nowhere
   * else to use them.
   */
  totp: z
    .string()
    .trim()
    .regex(/^(\d{6}|[A-Za-z2-9]{5}-?[A-Za-z2-9]{5})$/, 'Enter a 6-digit code or a recovery code')
    .optional(),
});

export const passwordResetRequestSchema = z.object({ email: emailSchema });

export const passwordResetConfirmSchema = z.object({
  token: z.string().min(20).max(200),
  password: passwordSchema,
});

export const mfaVerifySchema = z.object({ code: z.string().regex(/^\d{6}$/) });

/**
 * Accepts either a 6-digit TOTP code or a formatted recovery code, since a user
 * locked out of their authenticator must be able to use either wherever a
 * second factor is demanded.
 */
export const mfaCodeSchema = z.object({
  code: z
    .string()
    .trim()
    .min(6)
    .max(20)
    .regex(/^(\d{6}|[A-Za-z2-9]{5}-?[A-Za-z2-9]{5})$/, 'Enter a 6-digit code or a recovery code'),
});

export const emailVerificationSchema = z.object({ token: z.string().min(20).max(200) });

export const accountDeletionSchema = z.object({
  password: z.string().min(1).max(200),
  /** Typed confirmation, so deletion cannot happen through a single stray click. */
  confirm: z.literal('DELETE'),
});

// ---------------------------------------------------------------- recurrence

export const recurrenceRuleSchema = z
  .object({
    freq: z.enum(RECURRENCE_FREQ),
    interval: z.number().int().min(1).max(365).default(1),
    /** 0 = Sunday … 6 = Saturday. Only meaningful for WEEKLY. */
    byWeekday: z.array(z.number().int().min(0).max(6)).max(7).optional(),
    /** Day of month for MONTHLY; clamped to the last valid day of short months. */
    byMonthDay: z.number().int().min(1).max(31).optional(),
    until: isoDateTime.optional(),
    count: z.number().int().min(1).max(1000).optional(),
    timeZone,
  })
  .refine((r) => !(r.until && r.count), { message: 'Use either `until` or `count`, not both' })
  .refine((r) => r.freq !== 'WEEKLY' || !r.byWeekday || r.byWeekday.length > 0, {
    message: 'Weekly recurrence needs at least one weekday',
  });

export type RecurrenceRuleInput = z.infer<typeof recurrenceRuleSchema>;

// ---------------------------------------------------------------- tasks

export const createTaskSchema = z.object({
  workspaceId: uuid,
  title: z.string().trim().min(1, 'Title is required').max(500),
  description: z.string().max(20_000).nullish(),
  projectId: uuid.nullish(),
  sectionId: uuid.nullish(),
  parentTaskId: uuid.nullish(),
  priority: z.enum(TASK_PRIORITY).default('NONE'),
  dueAt: isoDateTime.nullish(),
  timeZone: timeZone.nullish(),
  estimateMinutes: z.number().int().min(0).max(60 * 24 * 31).nullish(),
  tagIds: z.array(uuid).max(50).default([]),
  tagNames: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
  projectName: z.string().trim().min(1).max(200).optional(),
  recurrenceRule: recurrenceRuleSchema.nullish(),
  clientMutationId: uuid.optional(),
});

export const updateTaskSchema = z
  .object({
    title: z.string().trim().min(1).max(500).optional(),
    description: z.string().max(20_000).nullish(),
    projectId: uuid.nullish(),
    sectionId: uuid.nullish(),
    priority: z.enum(TASK_PRIORITY).optional(),
    dueAt: isoDateTime.nullish(),
    timeZone: timeZone.nullish(),
    estimateMinutes: z.number().int().min(0).max(60 * 24 * 31).nullish(),
    position: z.number().optional(),
    tagIds: z.array(uuid).max(50).optional(),
    tagNames: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
    /** Optimistic lock. Required so a stale client cannot clobber newer state. */
    version: z.number().int().min(1),
  })
  .refine((v) => Object.keys(v).length > 1, { message: 'No fields to update' });

export const completeTaskSchema = z.object({
  version: z.number().int().min(1),
  completedAt: isoDateTime.optional(),
  note: z.string().max(2000).optional(),
});

export const rescheduleTaskSchema = z.object({
  version: z.number().int().min(1),
  dueAt: isoDateTime.nullable(),
  reason: z.string().max(500).optional(),
});

export const taskQuerySchema = z.object({
  workspaceId: uuid,
  status: z.enum(TASK_STATUS).optional(),
  projectId: uuid.optional(),
  tagId: uuid.optional(),
  unfiled: z.preprocess((v) => v === 'true' ? true : v === 'false' ? false : v, z.boolean()).optional(),
  q: z.string().trim().max(200).optional(),
  dueBefore: isoDateTime.optional(),
  dueAfter: isoDateTime.optional(),
  includeArchived: z.preprocess((v) => v === 'true' ? true : v === 'false' ? false : v, z.boolean()).default(false),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(500).optional(),
});

// ---------------------------------------------------------------- projects, sections, tags

export const createProjectSchema = z.object({
  workspaceId: uuid,
  name: z.string().trim().min(1).max(200),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  description: z.string().max(2000).nullish(),
});

/** Project metadata and lifecycle writes use optimistic versions like task edits. */
export const projectVersionSchema = z.object({ version: z.number().int().min(1) });
export const updateProjectSchema = z.object({
  version: z.number().int().min(1),
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
}).refine((v) => Object.entries(v).some(([key, value]) => key !== 'version' && value !== undefined), { message: 'No fields to update' });
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

const sectionPosition = z.number().finite().min(-1e12).max(1e12);
export const createSectionSchema = z.object({
  projectId: uuid,
  name: z.string().trim().min(1).max(200),
  position: sectionPosition.optional(),
});
export const sectionQuerySchema = z.object({ projectId: uuid });
export const updateSectionSchema = z.object({
  version: z.number().int().min(1),
  name: z.string().trim().min(1).max(200).optional(),
  position: sectionPosition.optional(),
  beforeId: uuid.nullable().optional(),
}).refine((v) => v.name !== undefined || v.position !== undefined || v.beforeId !== undefined, { message: 'No fields to update' })
  .refine((v) => v.position === undefined || v.beforeId === undefined, { message: 'Choose a position or a beforeId, not both' });
export type CreateSectionInput = z.infer<typeof createSectionSchema>;
export type UpdateSectionInput = z.infer<typeof updateSectionSchema>;

export const createTagSchema = z.object({
  workspaceId: uuid,
  name: z.string().trim().min(1).max(60),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

// ---------------------------------------------------------------- timers

export const startTimerSchema = z.object({
  taskId: uuid,
  deviceId: z.string().min(1).max(100),
  startedAt: isoDateTime.optional(),
});

export const updateTimerSchema = z.object({
  action: z.enum(['pause', 'resume', 'stop']),
  at: isoDateTime.optional(),
});

export const logTimeSchema = z.object({
  taskId: uuid,
  minutes: z.number().int().min(1).max(60 * 24),
  note: z.string().max(500).optional(),
});

// ---------------------------------------------------------------- reminders

export const createReminderSchema = z
  .object({
    taskId: uuid,
    scheduledAt: isoDateTime.optional(),
    /** Relative reminders resolve against the task due date at schedule time. */
    minutesBeforeDue: z.number().int().min(0).max(60 * 24 * 30).optional(),
    channel: z.enum(REMINDER_CHANNEL).default('WEB'),
  })
  .refine((r) => Boolean(r.scheduledAt) !== (r.minutesBeforeDue !== undefined), {
    message: 'Provide exactly one of `scheduledAt` or `minutesBeforeDue`',
  });

export const snoozeReminderSchema = z.object({ minutes: z.number().int().min(1).max(60 * 24 * 7) });

// ---------------------------------------------------------------- sync

export const mutationSchema = z.object({
  mutationId: uuid,
  entityType: z.enum(SYNC_ENTITY_TYPE),
  entityId: uuid,
  operation: z.enum(SYNC_OPERATION),
  baseVersion: z.number().int().min(0).nullable(),
  payload: z.record(z.unknown()),
  createdAt: isoDateTime,
});

export const syncPushSchema = z.object({
  workspaceId: uuid.optional(),
  deviceId: z.string().min(1).max(100),
  mutations: z.array(mutationSchema).min(1).max(200),
});

export const syncPullSchema = z.object({
  workspaceId: uuid,
  cursor: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export const mutationResultSchema = z.object({
  mutationId: uuid,
  status: z.enum(MUTATION_RESULT_STATUS),
  entity: z.record(z.unknown()).optional(),
  serverEntity: z.record(z.unknown()).optional(),
  error: z.object({ code: z.string(), detail: z.string() }).optional(),
});

// ---------------------------------------------------------------- natural language

export const parseTextSchema = z.object({
  text: z.string().trim().min(1).max(2000),
  timeZone: timeZone.default('UTC'),
  /** Reference instant for relative phrases; injected by tests for determinism. */
  now: isoDateTime.optional(),
});

// ---------------------------------------------------------------- analytics

export const summaryQuerySchema = z.object({
  workspaceId: uuid,
  period: z.enum(['day', 'week']).default('day'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;
export type TaskQueryInput = z.infer<typeof taskQuerySchema>;
export type SyncPushInput = z.infer<typeof syncPushSchema>;
export type MutationInput = z.infer<typeof mutationSchema>;
