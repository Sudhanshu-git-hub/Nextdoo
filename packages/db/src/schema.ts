import { relations, sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

/**
 * NEXTDOO schema (PRD §13).
 *
 * Conventions:
 *  - UUID primary keys, generated server-side (uuidv7-compatible ordering via app layer).
 *  - Every mutable entity carries `version` for optimistic locking.
 *  - Workspace-scoped tables carry `workspaceId` and index it — authorization always
 *    filters on it, so it must never be optional.
 *  - Soft delete via `deletedAt`; tracking events are append-only and never updated.
 */

// ----------------------------------------------------------------- enums

export const taskStatusEnum = pgEnum('task_status', ['ACTIVE', 'COMPLETED', 'ARCHIVED', 'DELETED']);
export const taskPriorityEnum = pgEnum('task_priority', ['NONE', 'LOW', 'MEDIUM', 'HIGH']);
export const projectStatusEnum = pgEnum('project_status', ['ACTIVE', 'ARCHIVED']);
export const reminderStatusEnum = pgEnum('reminder_status', [
  'SCHEDULED', 'PROCESSING', 'SENT', 'FAILED', 'CANCELED', 'EXPIRED',
]);
export const reminderChannelEnum = pgEnum('reminder_channel', ['WEB', 'DESKTOP', 'EMAIL']);
export const timerStatusEnum = pgEnum('timer_status', ['RUNNING', 'PAUSED', 'STOPPED', 'OVERLAPPED']);
export const trackingEventTypeEnum = pgEnum('tracking_event_type', [
  'TASK_CREATED', 'TASK_PLANNED', 'TASK_STARTED', 'TASK_PAUSED', 'TASK_COMPLETED',
  'TASK_RESCHEDULED', 'TASK_SKIPPED', 'TASK_REOPENED', 'TASK_ARCHIVED',
  'TIME_LOGGED', 'ESTIMATE_CHANGED', 'RECURRENCE_GENERATED',
]);
export const executionOutcomeEnum = pgEnum('execution_outcome', [
  'ON_TIME', 'LATE', 'EARLY', 'RESCHEDULED', 'SKIPPED', 'INCOMPLETE', 'UNMEASURED',
]);
export const subscriptionStatusEnum = pgEnum('subscription_status', [
  'TRIALING', 'ACTIVE', 'PAST_DUE', 'GRACE_PERIOD', 'CANCELED', 'EXPIRED', 'PAUSED',
]);
export const planEnum = pgEnum('plan', ['FREE', 'PRO', 'TEAM', 'ENTERPRISE']);
export const syncOperationEnum = pgEnum('sync_operation', ['create', 'update', 'delete']);
export const scanStatusEnum = pgEnum('scan_status', ['PENDING', 'CLEAN', 'INFECTED', 'FAILED']);
export const occurrenceStatusEnum = pgEnum('occurrence_status', ['PENDING', 'COMPLETED', 'SKIPPED']);

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

// ----------------------------------------------------------------- identity

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    email: varchar('email', { length: 254 }).notNull(),
    /** Argon2id hash. Never a plaintext password (PRD §11.4). */
    passwordHash: text('password_hash').notNull(),
    name: varchar('name', { length: 120 }),
    timeZone: varchar('time_zone', { length: 64 }).notNull().default('UTC'),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    /** Encrypted TOTP secret; null when MFA is off. */
    mfaSecretEncrypted: text('mfa_secret_encrypted'),
    mfaEnabledAt: timestamp('mfa_enabled_at', { withTimezone: true }),
    status: varchar('status', { length: 20 }).notNull().default('ACTIVE'),
    deletionRequestedAt: timestamp('deletion_requested_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex('users_email_unique').on(t.email)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 of the session token; the raw token never touches the database. */
    tokenHash: text('token_hash').notNull(),
    deviceLabel: varchar('device_label', { length: 200 }),
    ipHash: varchar('ip_hash', { length: 64 }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('sessions_token_hash_unique').on(t.tokenHash),
    index('sessions_user_idx').on(t.userId, t.expiresAt),
  ],
);

/** Single-use, hashed tokens for verification and password reset. */
export const authTokens = pgTable(
  'auth_tokens',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    purpose: varchar('purpose', { length: 32 }).notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('auth_tokens_hash_unique').on(t.tokenHash),
    index('auth_tokens_user_purpose_idx').on(t.userId, t.purpose),
  ],
);

export const recoveryCodes = pgTable(
  'recovery_codes',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('recovery_codes_user_idx').on(t.userId)],
);

// ----------------------------------------------------------------- workspace

export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 200 }).notNull(),
    timeZone: varchar('time_zone', { length: 64 }).notNull().default('UTC'),
    weekStart: integer('week_start').notNull().default(1),
    workdayStartMinute: integer('workday_start_minute').notNull().default(9 * 60),
    workdayEndMinute: integer('workday_end_minute').notNull().default(17 * 60),
    version: integer('version').notNull().default(1),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('workspaces_owner_idx').on(t.ownerId)],
);

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    role: varchar('role', { length: 20 }).notNull().default('OWNER'),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] }), index('workspace_members_user_idx').on(t.userId)],
);

// ----------------------------------------------------------------- projects

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 200 }).notNull(),
    description: text('description'),
    color: varchar('color', { length: 7 }),
    status: projectStatusEnum('status').notNull().default('ACTIVE'),
    position: numeric('position', { precision: 30, scale: 10 }).notNull().default('0'),
    version: integer('version').notNull().default(1),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('projects_workspace_status_idx').on(t.workspaceId, t.status)],
);

export const sections = pgTable(
  'sections',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 200 }).notNull(),
    position: numeric('position', { precision: 30, scale: 10 }).notNull().default('0'),
    version: integer('version').notNull().default(1),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('sections_project_position_idx').on(t.projectId, t.position)],
);

export const tags = pgTable(
  'tags',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 60 }).notNull(),
    color: varchar('color', { length: 7 }),
    ...timestamps,
  },
  (t) => [uniqueIndex('tags_workspace_name_unique').on(t.workspaceId, t.name)],
);

// ----------------------------------------------------------------- tasks

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    sectionId: uuid('section_id').references(() => sections.id, { onDelete: 'set null' }),
    parentTaskId: uuid('parent_task_id'),
    title: varchar('title', { length: 500 }).notNull(),
    description: text('description'),
    status: taskStatusEnum('status').notNull().default('ACTIVE'),
    priority: taskPriorityEnum('priority').notNull().default('NONE'),
    dueAt: timestamp('due_at', { withTimezone: true }),
    timeZone: varchar('time_zone', { length: 64 }),
    estimateMinutes: integer('estimate_minutes'),
    /** Derived from timer sessions plus audited manual adjustments. */
    actualMinutes: integer('actual_minutes').notNull().default(0),
    actualSecondsRemainder: integer('actual_seconds_remainder').notNull().default(0),
    position: numeric('position', { precision: 30, scale: 10 }).notNull().default('0'),
    /** Counter feeding the RESCHEDULED outcome. */
    rescheduleCount: integer('reschedule_count').notNull().default(0),
    recurrenceRuleId: uuid('recurrence_rule_id'),
    occurrenceKey: varchar('occurrence_key', { length: 120 }),
    version: integer('version').notNull().default(1),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('tasks_id_workspace_unique').on(t.id,t.workspaceId),
    index('tasks_ws_status_due_idx').on(t.workspaceId, t.status, t.dueAt),
    index('tasks_project_idx').on(t.projectId),
    index('tasks_parent_idx').on(t.parentTaskId),
    uniqueIndex('tasks_occurrence_unique').on(t.recurrenceRuleId, t.occurrenceKey),
    foreignKey({ name: 'tasks_parent_task_id_fkey', columns: [t.parentTaskId], foreignColumns: [t.id] }).onDelete('no action'),
    check('tasks_no_self_parent', sql`${t.parentTaskId} IS DISTINCT FROM ${t.id}`),
    check('tasks_estimate_nonneg', sql`${t.estimateMinutes} IS NULL OR ${t.estimateMinutes} >= 0`),
    check('tasks_actual_seconds_remainder_check', sql`${t.actualSecondsRemainder} >= 0 AND ${t.actualSecondsRemainder} < 60`),
    check('tasks_actual_nonneg', sql`${t.actualMinutes} >= 0`),
    check('tasks_title_len', sql`char_length(${t.title}) BETWEEN 1 AND 500`),
  ],
);

export const taskTags = pgTable(
  'task_tags',
  {
    taskId: uuid('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id').notNull().references(() => tags.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.tagId] }), index('task_tags_tag_idx').on(t.tagId)],
);

export const taskDependencies = pgTable(
  'task_dependencies',
  {
    taskId: uuid('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
    dependsOnTaskId: uuid('depends_on_task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
    ...timestamps,
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.dependsOnTaskId] }),
    check('task_deps_no_self', sql`${t.taskId} <> ${t.dependsOnTaskId}`),
  ],
);

// ----------------------------------------------------------------- recurrence

export const recurrenceRules = pgTable(
  'recurrence_rules',
  {
    id: uuid('id').primaryKey(),
    trackingRevision: integer('tracking_revision').notNull().default(0),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    /** The template task this series belongs to. */
    templateTaskId: uuid('template_task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
    rule: jsonb('rule').notNull(),
    timeZone: varchar('time_zone', { length: 64 }).notNull(),
    seriesStart: timestamp('series_start', { withTimezone: true }).notNull(),
    lastGeneratedAt: timestamp('last_generated_at', { withTimezone: true }),
    templateSnapshot: jsonb('template_snapshot'),
    generationError: varchar('generation_error', { length: 100 }),
    failureCount: integer('failure_count').notNull().default(0),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }).notNull().defaultNow(),
    active: boolean('active').notNull().default(true),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (t) => [index('recurrence_rules_ws_active_idx').on(t.workspaceId, t.active), index('recurrence_rules_due_idx').on(t.nextRunAt, t.id).where(sql`${t.active} AND ${t.templateSnapshot} IS NOT NULL`)],
);

export const taskOccurrences = pgTable(
  'task_occurrences',
  {
    id: uuid('id').primaryKey(),
    recurrenceRuleId: uuid('recurrence_rule_id').notNull().references(() => recurrenceRules.id, { onDelete: 'cascade' }),
    /** `${ruleId}:${localDate}` — the idempotency key that prevents duplicates. */
    occurrenceKey: varchar('occurrence_key', { length: 120 }).notNull(),
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    status: occurrenceStatusEnum('status').notNull().default('PENDING'),
    ...timestamps,
  },
  (t) => [uniqueIndex('task_occurrences_key_unique').on(t.recurrenceRuleId, t.occurrenceKey), uniqueIndex('task_occurrences_task_unique').on(t.taskId).where(sql`${t.taskId} IS NOT NULL`)],
);

// ----------------------------------------------------------------- reminders & timers

export const reminders = pgTable(
  'reminders',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
    minutesBeforeDue: integer('minutes_before_due'),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    supersededById: uuid('superseded_by_id'),
    channel: reminderChannelEnum('channel').notNull().default('WEB'),
    status: reminderStatusEnum('status').notNull().default('SCHEDULED'),
    attempts: integer('attempts').notNull().default(0),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    lastError: varchar('last_error', { length: 200 }),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (t) => [
    index('reminders_due_idx').on(t.status, t.scheduledAt),
    index('reminders_task_idx').on(t.taskId),
    index('reminders_history_idx').on(t.userId, t.workspaceId, t.createdAt, t.id),
    /** Guarantees at-most-once delivery per channel (PRD §6.6). */
    uniqueIndex('reminders_dispatch_unique').on(t.id, t.channel),
  ],
);

export const timerSessions = pgTable(
  'timer_sessions',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    deviceId: varchar('device_id', { length: 100 }).notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    /** Accumulated across pause/resume cycles. */
    accumulatedSeconds: integer('accumulated_seconds').notNull().default(0),
    lastResumedAt: timestamp('last_resumed_at', { withTimezone: true }),
    lastTransitionAt: timestamp('last_transition_at', { withTimezone: true }).notNull().defaultNow(),
    status: timerStatusEnum('status').notNull().default('RUNNING'),
    manualAdjustmentSeconds: integer('manual_adjustment_seconds').notNull().default(0),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (t) => [
    index('timer_sessions_task_idx').on(t.taskId, t.startedAt),
    index('timer_sessions_user_status_idx').on(t.userId, t.status),
  ],
);

// ----------------------------------------------------------------- tracking (append-only)

export const trackingEvents = pgTable(
  'tracking_events',
  {
    id: uuid('id').primaryKey(),
    sequence: bigserial('sequence', { mode: 'number' }).notNull(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id').notNull(),
    occurrenceKey: varchar('occurrence_key', { length: 120 }),
    type: trackingEventTypeEnum('type').notNull(),
    actorId: uuid('actor_id'),
    actorKind: varchar('actor_kind', { length: 16 }).notNull().default('USER'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    clientTimestamp: timestamp('client_timestamp', { withTimezone: true }),
    deviceId: varchar('device_id', { length: 100 }),
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
    /** Replaying the same event is a no-op (PRD §10.7). */
    idempotencyKey: varchar('idempotency_key', { length: 200 }).notNull(),
    schemaVersion: integer('schema_version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('tracking_events_sequence_unique').on(t.sequence),
    index('tracking_events_stream_idx').on(t.workspaceId,t.taskId,t.sequence),
    uniqueIndex('tracking_events_idem_unique').on(t.idempotencyKey),
    index('tracking_events_task_time_idx').on(t.taskId, t.occurredAt),
    index('tracking_events_ws_time_idx').on(t.workspaceId, t.occurredAt),
  ],
);

export const trackingResults = pgTable(
  'tracking_results',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id').notNull(),
    occurrenceKey: varchar('occurrence_key', { length: 120 }),
    /** Null is legitimate: it means UNMEASURED (PRD §7.3). */
    score: numeric('score', { precision: 5, scale: 1 }),
    outcome: executionOutcomeEnum('outcome').notNull(),
    components: jsonb('components').notNull(),
    explanation: text('explanation').notNull(),
    measuredWeight: numeric('measured_weight', { precision: 4, scale: 2 }).notNull(),
    calculationVersion: integer('calculation_version').notNull().default(1),
    /** Hash of inputs; unchanged ACTIVE inputs are a no-op, history is retained. */
    inputHash: varchar('input_hash', { length: 64 }).notNull(),
    inputSnapshot: jsonb('input_snapshot').$type<Record<string, unknown>>(),
    recalculated: boolean('recalculated').notNull().default(false),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('tracking_results_unique').on(t.taskId, sql`coalesce(${t.occurrenceKey}, '')`).where(sql`${t.supersededAt} IS NULL`),
    index('tracking_results_ws_created_idx').on(t.workspaceId, t.createdAt),
  ],
);

export const trackingCorrections = pgTable(
  'tracking_corrections',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id').notNull(),
    actorId: uuid('actor_id').notNull(),
    kind: varchar('kind', { length: 40 }).notNull(),
    reason: varchar('reason', { length: 500 }),
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('tracking_corrections_task_idx').on(t.taskId)],
);

// ----------------------------------------------------------------- sync

export const syncChanges = pgTable(
  'sync_changes',
  {
    sequence: bigserial('sequence', { mode: 'number' }).primaryKey(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    entityType: varchar('entity_type', { length: 40 }).notNull(),
    entityId: uuid('entity_id').notNull(),
    operation: syncOperationEnum('operation').notNull(),
    payload: jsonb('payload').notNull(),
    version: integer('version').notNull(),
    deviceId: varchar('device_id', { length: 100 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sync_changes_ws_seq_idx').on(t.workspaceId, t.sequence)],
);

export const syncTombstones = pgTable(
  'sync_tombstones',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    entityType: varchar('entity_type', { length: 40 }).notNull(),
    entityId: uuid('entity_id').notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }).notNull().defaultNow(),
    purgeAfter: timestamp('purge_after', { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex('sync_tombstones_entity_unique').on(t.entityType, t.entityId)],
);

/** Applied mutations, so a retry returns the original result instead of duplicating. */
export const syncMutations = pgTable(
  'sync_mutations',
  {
    mutationId: uuid('mutation_id').primaryKey(),
    requestHash: varchar('request_hash', { length: 64 }),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    deviceId: varchar('device_id', { length: 100 }).notNull(),
    entityType: varchar('entity_type', { length: 40 }).notNull(),
    entityId: uuid('entity_id').notNull(),
    status: varchar('status', { length: 20 }).notNull(),
    result: jsonb('result').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sync_mutations_ws_idx').on(t.workspaceId, t.createdAt)],
);

/** Content we declined to apply, retained so nothing is silently lost (PRD §10.6). */
export const conflictSnapshots = pgTable(
  'conflict_snapshots',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    entityType: varchar('entity_type', { length: 40 }).notNull(),
    entityId: uuid('entity_id').notNull(),
    deviceId: varchar('device_id', { length: 100 }),
    localPayload: jsonb('local_payload').notNull(),
    serverPayload: jsonb('server_payload').notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolution: varchar('resolution', { length: 20 }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('conflict_snapshots_ws_idx').on(t.workspaceId, t.createdAt)],
);

// ----------------------------------------------------------------- outbox & audit

/** Written in the same transaction as the domain change (PRD §15.3). */
export const outbox = pgTable(
  'outbox',
  {
    id: uuid('id').primaryKey(),
    eventType: varchar('event_type', { length: 60 }).notNull(),
    schemaVersion: integer('schema_version').notNull().default(1),
    workspaceId: uuid('workspace_id'),
    actorId: uuid('actor_id'),
    entityType: varchar('entity_type', { length: 40 }).notNull(),
    entityId: uuid('entity_id').notNull(),
    correlationId: varchar('correlation_id', { length: 80 }),
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    lastError: varchar('last_error', { length: 300 }),
  },
  (t) => [index('outbox_unpublished_idx').on(t.publishedAt, t.occurredAt)],
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id'),
    actorId: uuid('actor_id'),
    action: varchar('action', { length: 80 }).notNull(),
    targetType: varchar('target_type', { length: 40 }).notNull(),
    targetId: uuid('target_id'),
    /** Metadata only — never task content or secrets (PRD §11.4). */
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
    ipHash: varchar('ip_hash', { length: 64 }),
    requestId: varchar('request_id', { length: 80 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('audit_logs_ws_time_idx').on(t.workspaceId, t.createdAt)],
);

/** Generic idempotency ledger for HTTP mutations and job runs. */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    key: varchar('key', { length: 200 }).primaryKey(),
    scope: varchar('scope', { length: 80 }).notNull(),
    userId: uuid('user_id'),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idempotency_expiry_idx').on(t.expiresAt)],
);

// ----------------------------------------------------------------- attachments, calendar, billing

export const attachments = pgTable(
  'attachments',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
    uploaderId: uuid('uploader_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    objectKey: varchar('object_key', { length: 400 }).notNull(),
    fileName: varchar('file_name', { length: 300 }).notNull(),
    contentType: varchar('content_type', { length: 120 }).notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    scanStatus: scanStatusEnum('scan_status').notNull().default('PENDING'),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('attachments_task_idx').on(t.taskId),
    uniqueIndex('attachments_object_key_unique').on(t.objectKey),
    check('attachments_size_positive', sql`${t.sizeBytes} > 0`),
  ],
);

export const calendarConnections = pgTable(
  'calendar_connections',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    provider: varchar('provider', { length: 20 }).notNull(),
    externalAccountId: varchar('external_account_id', { length: 200 }),
    /** Envelope-encrypted; never plaintext (PRD §11.4). */
    accessTokenEncrypted: text('access_token_encrypted'),
    refreshTokenEncrypted: text('refresh_token_encrypted'),
    tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
    scopes: text('scopes'),
    mode: varchar('mode', { length: 20 }).notNull().default('READ_ONLY'),
    syncToken: text('sync_token'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    status: varchar('status', { length: 20 }).notNull().default('ACTIVE'),
    version: integer('version').notNull().default(1),
    disconnectedAt: timestamp('disconnected_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('calendar_connections_user_idx').on(t.userId, t.provider)],
);

export const calendarMappings = pgTable(
  'calendar_mappings',
  {
    id: uuid('id').primaryKey(),
    connectionId: uuid('connection_id').notNull().references(() => calendarConnections.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'cascade' }),
    externalId: varchar('external_id', { length: 300 }).notNull(),
    calendarId: varchar('calendar_id', { length: 300 }),
    syncState: varchar('sync_state', { length: 20 }).notNull().default('SYNCED'),
    externalUpdatedAt: timestamp('external_updated_at', { withTimezone: true }),
    localUpdatedAt: timestamp('local_updated_at', { withTimezone: true }),
    /** Set when both sides changed; the user must choose (PRD §16.4). */
    conflictPayload: jsonb('conflict_payload'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('calendar_mappings_external_unique').on(t.connectionId, t.externalId),
    uniqueIndex('calendar_mappings_task_unique').on(t.connectionId, t.taskId),
  ],
);

export const calendarEvents = pgTable(
  'calendar_events',
  {
    id: uuid('id').primaryKey(),
    connectionId: uuid('connection_id').notNull().references(() => calendarConnections.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    externalId: varchar('external_id', { length: 300 }).notNull(),
    calendarId: varchar('calendar_id', { length: 300 }),
    title: varchar('title', { length: 500 }),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    timeZone: varchar('time_zone', { length: 64 }),
    isAllDay: boolean('is_all_day').notNull().default(false),
    busy: boolean('busy').notNull().default(true),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('calendar_events_unique').on(t.connectionId, t.externalId),
    index('calendar_events_ws_time_idx').on(t.workspaceId, t.startsAt),
  ],
);

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    providerCustomerId: varchar('provider_customer_id', { length: 120 }),
    providerSubscriptionId: varchar('provider_subscription_id', { length: 120 }),
    plan: planEnum('plan').notNull().default('FREE'),
    status: subscriptionStatusEnum('status').notNull().default('ACTIVE'),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    graceEndsAt: timestamp('grace_ends_at', { withTimezone: true }),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('subscriptions_user_unique').on(t.userId),
    index('subscriptions_provider_idx').on(t.providerCustomerId),
  ],
);

/** Deduplicates billing webhooks on the provider event id (PRD §18.3). */
export const billingEvents = pgTable(
  'billing_events',
  {
    providerEventId: varchar('provider_event_id', { length: 120 }).primaryKey(),
    type: varchar('type', { length: 80 }).notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
    payload: jsonb('payload').notNull(),
  },
);

export const entitlements = pgTable(
  'entitlements',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    feature: varchar('feature', { length: 60 }).notNull(),
    limitValue: integer('limit_value'),
    source: varchar('source', { length: 40 }).notNull().default('PLAN'),
    ...timestamps,
  },
  (t) => [uniqueIndex('entitlements_user_feature_unique').on(t.userId, t.feature)],
);

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    type: varchar('type', { length: 60 }).notNull(),
    title: varchar('title', { length: 500 }).notNull(),
    body: text('body'),
    taskId: uuid('task_id'),
    reminderId: uuid('reminder_id').references(() => reminders.id, { onDelete: 'set null' }),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('notifications_user_idx').on(t.userId, t.readAt), uniqueIndex('notifications_reminder_unique').on(t.reminderId), index('notifications_history_idx').on(t.userId, t.workspaceId, t.createdAt, t.id)],
);

export const exports = pgTable(
  'exports',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    format: varchar('format', { length: 10 }).notNull().default('json'),
    status: varchar('status', { length: 20 }).notNull().default('PENDING'),
    objectKey: varchar('object_key', { length: 400 }),
    sizeBytes: integer('size_bytes'),
    /** Short-lived by policy (PRD §13.5: 24 hours). */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    error: varchar('error', { length: 300 }),
    ...timestamps,
  },
  (t) => [index('exports_user_status_idx').on(t.userId, t.status)],
);

export const userPreferences = pgTable(
  'user_preferences',
  {
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    key: varchar('key', { length: 60 }).notNull(),
    value: jsonb('value').notNull(),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })],
);

export const deviceRegistrations = pgTable(
  'device_registrations',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    deviceId: varchar('device_id', { length: 100 }).notNull(),
    platform: varchar('platform', { length: 20 }).notNull(),
    label: varchar('label', { length: 200 }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [uniqueIndex('device_registrations_unique').on(t.userId, t.deviceId)],
);

// ----------------------------------------------------------------- relations

export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(sessions),
  workspaces: many(workspaces),
}));

export const workspacesRelations = relations(workspaces, ({ one, many }) => ({
  owner: one(users, { fields: [workspaces.ownerId], references: [users.id] }),
  projects: many(projects),
  tasks: many(tasks),
}));

export const tasksRelations = relations(tasks, ({ one, many }) => ({
  workspace: one(workspaces, { fields: [tasks.workspaceId], references: [workspaces.id] }),
  project: one(projects, { fields: [tasks.projectId], references: [projects.id] }),
  section: one(sections, { fields: [tasks.sectionId], references: [sections.id] }),
  tags: many(taskTags),
  reminders: many(reminders),
  timerSessions: many(timerSessions),
}));

export const projectsRelations = relations(projects, ({ one, many }) => ({
  workspace: one(workspaces, { fields: [projects.workspaceId], references: [workspaces.id] }),
  sections: many(sections),
  tasks: many(tasks),
}));


/** Durable authentication backoff; identities are HMACs, never raw addresses. */
export const authenticationAttempts = pgTable('authentication_attempts', {
  key: varchar('key', { length: 64 }).primaryKey(),
  attempts: integer('attempts').notNull(),
  blockedUntil: timestamp('blocked_until', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, (t) => [index('authentication_attempts_expiry').on(t.expiresAt)]);

/** Encrypted mail payloads; user purge cascades their private contents. */
export const mailDeliveries = pgTable('mail_deliveries', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  kind: varchar('kind', { length: 40 }).notNull(),
  encryptedMessage: text('encrypted_message').notNull(),
  status: varchar('status', { length: 16 }).notNull().default('PENDING'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
  leaseToken: uuid('lease_token'),
  leaseUntil: timestamp('lease_until', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  lastError: varchar('last_error', { length: 80 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('mail_delivery_due').on(t.status, t.nextAttemptAt)]);

/** Durable invalidation, queue and consumer checkpoint; workspace/task ownership is a composite FK. */
export const trackingJobs = pgTable('tracking_jobs', {
 taskId: uuid('task_id').primaryKey(),
 workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
 revision: integer('revision').notNull().default(1),
 queuedRevision: integer('queued_revision').notNull().default(0),
 acknowledgedRevision: integer('acknowledged_revision').notNull().default(0),
 evaluatedRevision: integer('evaluated_revision').notNull().default(0),
 evaluatedCohortRevision: integer('evaluated_cohort_revision').notNull().default(0),
 queuedCohortRevision: integer('queued_cohort_revision').notNull().default(0),
 calculationVersion: integer('calculation_version').notNull().default(0),
 queuedCalculationVersion: integer('queued_calculation_version').notNull().default(0),
 nextEvaluationAt: timestamp('next_evaluation_at', { withTimezone: true }),
 evaluatedAt: timestamp('evaluated_at', { withTimezone: true }),
 requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
 queuedAt: timestamp('queued_at', { withTimezone: true }),
 claimToken: uuid('claim_token'),
 leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
 attempts: integer('attempts').notNull().default(0),
 nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
 lastError: varchar('last_error', { length: 80 }),
 lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
}, (t) => [index('tracking_jobs_workspace_idx').on(t.workspaceId, t.taskId),
 index('tracking_jobs_ready_idx').on(t.nextAttemptAt,t.queuedAt).where(sql`${t.queuedRevision}>${t.acknowledgedRevision} AND ${t.attempts}<6`),
 index('tracking_jobs_clock_idx').on(t.nextEvaluationAt).where(sql`${t.nextEvaluationAt} IS NOT NULL`),
 index('tracking_jobs_expired_lease_idx').on(t.leaseExpiresAt).where(sql`${t.claimToken} IS NOT NULL`),
 check('tracking_jobs_attempts_check',sql`${t.attempts} BETWEEN 0 AND 6`),
 check('tracking_jobs_lease_pair',sql`(${t.claimToken} IS NULL) = (${t.leaseExpiresAt} IS NULL)`),
 foreignKey({ columns: [t.taskId, t.workspaceId], foreignColumns: [tasks.id, tasks.workspaceId] }).onDelete('cascade')]);

/** Per-consumer receipts never pretend other outbox consumers have delivered. */
export const trackingOutboxReceipts = pgTable('tracking_outbox_receipts', {
 outboxId: uuid('outbox_id').primaryKey().references(() => outbox.id, { onDelete: 'cascade' }),
 workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
 receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
});
