import { z } from 'zod';

/** PRD §15.1 — every domain event shares this envelope. */
export const DOMAIN_EVENT_TYPE = [
  'project.created',
  'project.updated',
  'project.archived',
  'project.restored',
  'task.created',
  'task.updated',
  'task.completed',
  'task.reopened',
  'task.rescheduled',
  'task.deleted',
  'task.restored',
  'recurrence.occurrence_generated',
  'reminder.scheduled',
  'reminder.sent',
  'reminder.failed',
  'timer.started',
  'timer.stopped',
  'tracking.result_created',
  'tracking.result_recalculated',
  'calendar.item_imported',
  'calendar.item_updated',
  'subscription.changed',
  'export.completed',
  'account.deletion_requested',
] as const;

export type DomainEventType = (typeof DOMAIN_EVENT_TYPE)[number];

export const eventEnvelopeSchema = z.object({
  event_id: z.string(),
  event_type: z.enum(DOMAIN_EVENT_TYPE),
  schema_version: z.number().int().min(1),
  occurred_at: z.string(),
  workspace_id: z.string().nullable(),
  actor_id: z.string().nullable(),
  entity_type: z.string(),
  entity_id: z.string(),
  correlation_id: z.string().nullable(),
  payload: z.record(z.unknown()),
});

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;
