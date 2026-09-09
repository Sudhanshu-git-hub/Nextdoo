import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { DomainEventType, TrackingEventType } from '@nextdoo/contracts';
import { auditLogs, outbox, syncChanges, trackingEvents, tasks } from '@nextdoo/db';
import { newId } from '../ids';
import { getDb } from '../db';
import { logger } from '../observability';

/**
 * Event writers (PRD §7.2, §15.3).
 *
 * All three writers take a transaction handle, because a domain change and its
 * events must commit atomically. A consumer failing later must never roll back
 * the user's work — that is what the outbox relay is for.
 */

export interface TrackingEventInput {
  workspaceId: string;
  taskId: string;
  type: TrackingEventType;
  actorId: string | null;
  actorKind?: 'USER' | 'SYSTEM';
  occurredAt?: Date;
  clientTimestamp?: Date | null;
  deviceId?: string | null;
  occurrenceKey?: string | null;
  payload?: Record<string, unknown>;
  /**
   * Stable key so replaying the same logical event is a no-op.
   * Defaults to a hash including the accepted task version and source device.
   * Tied timestamps must not collapse distinct CAS-protected commands. Workers
   * and timer transitions supply their own stable command identities.
   */
  idempotencyKey?: string;
}

export function trackingIdempotencyKey(taskId: string, type: string, at: Date, extra = ''): string {
  return createHash('sha256')
    .update(`${taskId}:${type}:${at.toISOString()}:${extra}`)
    .digest('hex')
    .slice(0, 64);
}

/** Appends a tracking event. Duplicate keys are ignored, never updated. */
export async function appendTrackingEvent(tx: any, input: TrackingEventInput): Promise<void> {
  const occurredAt = input.occurredAt ?? new Date();
  let key = input.idempotencyKey;
  if (!key) {
    const [task] = await tx.select({ version: tasks.version }).from(tasks)
      .where(and(eq(tasks.id,input.taskId),eq(tasks.workspaceId,input.workspaceId)));
    if (!task) throw new Error('Tracking event task unavailable');
    key = trackingIdempotencyKey(input.taskId,input.type,occurredAt,`${task.version}:${input.deviceId ?? ''}`);
  }
  await tx
    .insert(trackingEvents)
    .values({
      id: newId(),
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      occurrenceKey: input.occurrenceKey ?? null,
      type: input.type,
      actorId: input.actorId,
      actorKind: input.actorKind ?? 'USER',
      occurredAt,
      clientTimestamp: input.clientTimestamp ?? null,
      deviceId: input.deviceId ?? null,
      payload: input.payload ?? {},
      idempotencyKey: key,
      schemaVersion: 1,
    })
    .onConflictDoNothing();
}

export interface DomainEventInput {
  eventType: DomainEventType;
  workspaceId: string | null;
  actorId: string | null;
  entityType: string;
  entityId: string;
  correlationId?: string | null;
  payload?: Record<string, unknown>;
}

/** Writes to the transactional outbox; a relay publishes it after commit. */
export async function publishEvent(tx: any, input: DomainEventInput): Promise<void> {
  await tx.insert(outbox).values({
    id: newId(),
    eventType: input.eventType,
    schemaVersion: 1,
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    entityType: input.entityType,
    entityId: input.entityId,
    correlationId: input.correlationId ?? null,
    payload: input.payload ?? {},
  });
}

export interface SyncChangeInput {
  workspaceId: string;
  entityType: string;
  entityId: string;
  operation: 'create' | 'update' | 'delete';
  payload: Record<string, unknown>;
  version: number;
  deviceId?: string | null;
}

/** Records a change so other devices can pull it via the sync cursor. */
export async function recordSyncChange(tx: any, input: SyncChangeInput): Promise<void> {
  await tx.insert(syncChanges).values({
    workspaceId: input.workspaceId,
    entityType: input.entityType,
    entityId: input.entityId,
    operation: input.operation,
    payload: input.payload,
    version: input.version,
    deviceId: input.deviceId ?? null,
  });
}

export interface AuditInput {
  workspaceId: string | null;
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  /** Metadata only — never task content or secrets. */
  metadata?: Record<string, unknown>;
  requestId?: string | null;
  ipHash?: string | null;
}

export async function writeAudit(tx: any, input: AuditInput): Promise<void> {
  await tx.insert(auditLogs).values({
    id: newId(),
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    metadata: input.metadata ?? {},
    requestId: input.requestId ?? null,
    ipHash: input.ipHash ?? null,
  });
}

/**
 * Writes an audit entry outside a caller-supplied transaction.
 *
 * Auditing must never be the reason a user-facing action fails, so a failure
 * here is logged and swallowed. Anything that genuinely requires atomicity with
 * its action should use `writeAudit` inside that transaction instead.
 */
export async function writeAuditLog(input: {
  userId: string | null;
  workspaceId?: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  metadata?: Record<string, unknown>;
  requestId?: string | null;
}): Promise<void> {
  try {
    await writeAudit(getDb(), {
      workspaceId: input.workspaceId ?? null,
      actorId: input.userId,
      action: input.action,
      targetType: input.entityType,
      targetId: input.entityId,
      metadata: input.metadata ?? {},
      requestId: input.requestId ?? null,
    });
  } catch (error) {
    logger.error('audit.write_failed', {
      action: input.action,
      error: error instanceof Error ? error.message : 'unknown',
    });
  }
}
