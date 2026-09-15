import { randomUUID } from 'node:crypto';
import { and, asc, eq, gte, inArray, isNull, like, lte, ne, sql } from 'drizzle-orm';
import {
  CalendarAuthError,
  CalendarRateLimited,
  CALENDAR_INSTANCE_KEY_SEPARATOR,
  type CalendarProvider,
  type CalendarTokenSet,
} from '@nextdoo/contracts';
import type { Database } from './client';
import {
  auditLogs,
  calendarConnections,
  calendarEvents,
  calendarMappings,
  calendarOauthStates,
  notifications,
  outbox,
  syncChanges,
  tasks,
} from './schema';

/**
 * Google Calendar two-way sync engine (PRD §16).
 *
 * Layering follows the codebase: durable domain operations live in
 * @nextdoo/db and receive the provider as a parameter — the provider
 * boundary (packages/contracts) is the only calendar abstraction, and the
 * Google adapter (packages/calendar) is its first implementation. No
 * product path ever talks to a provider directly.
 *
 * Invariants preserved from M5: every task mutation applies the same
 * invariants the task command path uses (version bump, reschedule count,
 * sync change for device pull, transactional outbox event), so
 * calendar-driven changes are indistinguishable from online edits on the
 * sync cursor. Tenant isolation is structural: every query is scoped to
 * the connection's (user, workspace) pair.
 *
 * Recurring events are imported as instances inside the sync window (the
 * normalized shape, PRD §16.3, carries no recurrence field).
 */

export const CALENDAR_EXPORT_HORIZON_DAYS = 30;
export const CALENDAR_SYNC_PAUSE_AFTER = 5;
export const CALENDAR_MAPPING_RETENTION_DAYS = 30;

export type CalendarPauseReason = 'TOKEN_EXPIRED' | 'TOKEN_REVOKED' | 'SYNC_FAILED';

export interface CalendarSyncOutcome {
  imported: number;
  removedExternal: number;
  unscheduledTasks: number;
  externalApplied: number;
  conflicts: number;
  exportedCreated: number;
  exportedUpdated: number;
  exportedDeleted: number;
  /** Set when this pass paused the connection; carries the reason. */
  paused: CalendarPauseReason | null;
  /** Set when the provider rate-limited; the pass is skipped, not retried. */
  rateLimitedSeconds: number | null;
  /** Refreshed tokens the caller must re-seal (PRD §16.1 rotation). */
  tokens: CalendarTokenSet | null;
}

const NOOP: CalendarSyncOutcome = {
  imported: 0,
  removedExternal: 0,
  unscheduledTasks: 0,
  externalApplied: 0,
  conflicts: 0,
  exportedCreated: 0,
  exportedUpdated: 0,
  exportedDeleted: 0,
  paused: null,
  rateLimitedSeconds: null,
  tokens: null,
};

export interface SyncContext {
  db: Database;
  connectionId: string;
  provider: CalendarProvider;
  /** Injectable clock for deterministic tests. */
  now?: Date;
}

/** The transaction handle the workspace transaction hands to callbacks. */
type CalendarTx = Parameters<Database['transaction']>[0] extends (tx: infer T) => unknown ? T : never;

async function loadActiveConnection(db: Database, connectionId: string) {
  const [conn] = await db
    .select()
    .from(calendarConnections)
    .where(and(eq(calendarConnections.id, connectionId), eq(calendarConnections.provider, 'google')))
    .limit(1);
  return conn && conn.status === 'ACTIVE' ? conn : null;
}

async function ensureTokens(ctx: SyncContext, outcome: CalendarSyncOutcome): Promise<boolean> {
  try {
    await ctx.provider.ensureAccessToken();
    return true;
  } catch (error) {
    if (error instanceof CalendarAuthError) {
      const reason: CalendarPauseReason = /reconnect|no refresh|rejected/i.test(error.message) ? 'TOKEN_REVOKED' : 'TOKEN_EXPIRED';
      await pauseConnection(ctx.db, ctx.connectionId, reason, error.message);
      outcome.paused = reason;
      return false;
    }
    // Rate-limited on the token op itself: skip the pass (PRD §16.1),
    // never count it as a failure.
    if (error instanceof CalendarRateLimited) {
      outcome.rateLimitedSeconds = error.retryAfterSeconds;
      return false;
    }
    throw error;
  }
}

function tokensIfRefreshed(ctx: SyncContext): CalendarTokenSet | null {
  try {
    return ctx.provider.currentTokens();
  } catch {
    return null;
  }
}

/**
 * Pause a connection and surface the reconnect prompt (PRD §16.6).
 * Never deletes user data; the user can reconnect (re-exchange) or
 * disconnect.
 */
export async function pauseConnection(db: Database, connectionId: string, reason: CalendarPauseReason, detail?: string): Promise<void> {
  const now = new Date();
  const [row] = await db
    .update(calendarConnections)
    .set({ status: 'SUSPENDED', pauseReason: reason, version: sql`${calendarConnections.version} + 1`, updatedAt: now })
    .where(and(eq(calendarConnections.id, connectionId), eq(calendarConnections.status, 'ACTIVE')))
    .returning();
  if (!row) return;
  await db.transaction(async (tx) => {
    await tx.insert(auditLogs).values({
      id: randomUUID(),
      workspaceId: row.workspaceId,
      actorId: null,
      action: 'calendar.connection_paused',
      targetType: 'calendar_connection',
      targetId: row.id,
      metadata: { reason, detail: detail ? detail.slice(0, 200) : null },
    });
    // Reconnect prompt: one durable in-app notification, not a storm.
    await tx
      .insert(notifications)
      .values({
        id: randomUUID(),
        userId: row.userId,
        workspaceId: row.workspaceId,
        type: 'calendar',
        title: 'Your calendar connection needs attention',
        body:
          reason === 'SYNC_FAILED'
            ? 'Synchronization keeps failing. Reconnect to continue syncing your calendar.'
            : 'Your calendar sign-in expired. Reconnect to continue syncing.',
      })
      .onConflictDoNothing();
  });
}

/**
 * Task mutation with the exact invariants of the task command path
 * (rescheduleTaskCore): version bump, reschedule count, sync change for
 * device pull, transactional outbox event. Used for calendar-driven
 * changes only — external changes never overwrite task titles.
 */
export { applyDueChange as applyTaskDueChange };
async function applyDueChange(
  tx: CalendarTx | Database,
  workspaceId: string,
  task: { id: string; version: number; dueAt: Date | null; title: string },
  nextDueAt: Date | null,
  reason: string,
  actorId: string | null,
): Promise<{ id: string; version: number } | null> {
  const now = new Date();
  const [updated] = await tx
    .update(tasks)
    .set({
      dueAt: nextDueAt,
      rescheduleCount: sql`${tasks.rescheduleCount} + 1`,
      updatedAt: now,
      version: sql`${tasks.version} + 1`,
    })
    .where(and(eq(tasks.id, task.id), eq(tasks.version, task.version)))
    .returning();
  if (!updated) return null;
  await tx.insert(syncChanges).values({
    workspaceId,
    entityType: 'task',
    entityId: updated.id,
    operation: 'update',
    payload: {
      id: updated.id,
      title: updated.title,
      dueAt: updated.dueAt ? updated.dueAt.toISOString() : null,
      status: updated.status,
      version: updated.version,
    },
    version: updated.version,
  });
  await tx.insert(outbox).values({
    id: randomUUID(),
    eventType: 'task.rescheduled',
    schemaVersion: 1,
    workspaceId,
    actorId,
    entityType: 'task',
    entityId: updated.id,
    payload: { reason, from: task.dueAt ? task.dueAt.toISOString() : null, to: nextDueAt ? nextDueAt.toISOString() : null },
  });
  await tx.insert(auditLogs).values({
    id: randomUUID(),
    workspaceId,
    actorId,
    action: 'task.rescheduled',
    targetType: 'task',
    targetId: updated.id,
    metadata: { reason, source: 'calendar_sync' },
  });
  return { id: updated.id, version: updated.version };
}

/** Escape a literal for use inside a LIKE pattern (Postgres default escape). */
function likeEscape(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Import pass: normalize external changes into calendar_events, apply
 * mapped-record updates (two-way, PRD §16.1), detect both-side changes
 * into CONFLICT (PRD §16.4), and unschedule tasks whose external event
 * was deleted (PRD §16.6 AC-3). Externally deleted events/occurrences also
 * have their mirror rows removed (M7-i2 G1/G2).
 */
export async function runCalendarImport(ctx: SyncContext): Promise<CalendarSyncOutcome> {
  const outcome: CalendarSyncOutcome = { ...NOOP };
  const db = ctx.db;
  const now = ctx.now ?? new Date();

  const conn = await loadActiveConnection(db, ctx.connectionId);
  if (!conn) return outcome;
  if (!(await ensureTokens(ctx, outcome))) return outcome;

  const changes = await ctx.provider
    .listChanges({
      syncToken: conn.syncToken,
      timeMin: new Date(now.getTime() - 86_400_000).toISOString(),
    })
    .catch((error: unknown) => {
      if (error instanceof CalendarRateLimited) {
        outcome.rateLimitedSeconds = error.retryAfterSeconds;
        return null;
      }
      throw error;
    });
  if (changes === null) return outcome;

  await db.transaction(async (tx) => {
    // 1) Upsert normalized events (PRD §16.3). The event mirror is
    // provider data; it never touches user-authored task titles.
    for (const event of changes.events) {
      outcome.imported += 1;
      await tx
        .insert(calendarEvents)
        .values({
          id: randomUUID(),
          connectionId: conn.id,
          workspaceId: conn.workspaceId,
          externalId: event.externalId,
          calendarId: event.calendarId,
          title: event.title.slice(0, 500),
          startsAt: new Date(event.startsAt),
          endsAt: new Date(event.endsAt),
          timeZone: event.timeZone,
          isAllDay: event.isAllDay,
          busy: event.busy,
          etag: event.etag,
        })
        .onConflictDoUpdate({
          target: [calendarEvents.connectionId, calendarEvents.externalId],
          set: {
            title: event.title.slice(0, 500),
            startsAt: new Date(event.startsAt),
            endsAt: new Date(event.endsAt),
            timeZone: event.timeZone,
            isAllDay: event.isAllDay,
            busy: event.busy,
            etag: event.etag,
            updatedAt: now,
          },
        });
    }

    // 2) Mapped records: two-way update / conflict detection (PRD §16.4).
    const externalIds = changes.events.map((e) => e.externalId);
    const mapped = externalIds.length
      ? await tx.select().from(calendarMappings).where(and(eq(calendarMappings.connectionId, conn.id), inArray(calendarMappings.externalId, externalIds)))
      : [];
    const byExternal = new Map(mapped.map((m) => [m.externalId, m]));

    for (const event of changes.events) {
      const mapping = byExternal.get(event.externalId);
      if (!mapping || !mapping.taskId || mapping.syncState !== 'SYNCED') continue; // CONFLICT waits for the user
      const [task] = await tx.select().from(tasks).where(and(eq(tasks.id, mapping.taskId), eq(tasks.workspaceId, conn.workspaceId))).limit(1);
      if (!task || task.status === 'DELETED') continue;
      if (mapping.externalUpdatedAt && event.updatedAt && new Date(event.updatedAt).getTime() <= mapping.externalUpdatedAt.getTime()) {
        continue; // unchanged externally since the last applied change
      }
      const localChanged = mapping.localUpdatedAt !== null && mapping.localUpdatedAt.getTime() > (mapping.externalUpdatedAt?.getTime() ?? 0);
      if (localChanged) {
        // Both sides modified the mapped date → CONFLICT with both values
        // preserved for the user to choose (PRD §16.4).
        await tx
          .update(calendarMappings)
          .set({
            syncState: 'CONFLICT',
            externalUpdatedAt: event.updatedAt ? new Date(event.updatedAt) : mapping.externalUpdatedAt,
            conflictPayload: {
              local: { dueAt: task.dueAt ? task.dueAt.toISOString() : null, title: task.title },
              external: { startsAt: event.startsAt, endsAt: event.endsAt, title: event.title, externalId: event.externalId },
              detectedAt: now.toISOString(),
            },
            updatedAt: now,
          })
          .where(eq(calendarMappings.id, mapping.id));
        outcome.conflicts += 1;
        await tx.insert(auditLogs).values({
          id: randomUUID(),
          workspaceId: conn.workspaceId,
          actorId: null,
          action: 'calendar.conflict_detected',
          targetType: 'calendar_mapping',
          targetId: mapping.id,
          metadata: { taskId: mapping.taskId, externalId: event.externalId },
        });
        continue;
      }
      // External-only change: apply the new time to the task through the
      // task invariants (title is never overwritten externally).
      const nextDue = new Date(event.startsAt);
      if (!task.dueAt || task.dueAt.getTime() !== nextDue.getTime()) {
        const updated = await applyDueChange(tx, conn.workspaceId, { id: task.id, version: task.version, dueAt: task.dueAt, title: task.title }, nextDue, 'Calendar event changed', conn.userId);
        if (updated) {
          outcome.externalApplied += 1;
          await tx
            .update(calendarMappings)
            .set({
              syncState: 'SYNCED',
              externalUpdatedAt: event.updatedAt ? new Date(event.updatedAt) : mapping.externalUpdatedAt,
              localUpdatedAt: now,
              updatedAt: now,
            })
            .where(eq(calendarMappings.id, mapping.id));
          await tx.insert(auditLogs).values({
              id: randomUUID(),
              workspaceId: conn.workspaceId,
              actorId: conn.userId,
              action: 'calendar.item_updated',
            targetType: 'task',
            targetId: task.id,
            metadata: { externalId: event.externalId, applied: 'external' },
          });
        }
      } else {
        await tx
          .update(calendarMappings)
          .set({ externalUpdatedAt: event.updatedAt ? new Date(event.updatedAt) : mapping.externalUpdatedAt, updatedAt: now })
          .where(eq(calendarMappings.id, mapping.id));
      }
    }

    // 3) External deletions → unschedule + notify (PRD §16.6 AC-3).
    if (changes.deletedExternalIds.length) {
      const deletedMapped = await tx
        .select()
        .from(calendarMappings)
        .where(and(eq(calendarMappings.connectionId, conn.id), inArray(calendarMappings.externalId, changes.deletedExternalIds)))
        .orderBy(asc(calendarMappings.id));
      for (const mapping of deletedMapped) {
        outcome.removedExternal += 1;
        const [task] = mapping.taskId
          ? await tx.select().from(tasks).where(and(eq(tasks.id, mapping.taskId), eq(tasks.workspaceId, conn.workspaceId))).limit(1)
          : [];
        if (task && task.status !== 'DELETED' && task.dueAt) {
          const updated = await applyDueChange(tx, conn.workspaceId, { id: task.id, version: task.version, dueAt: task.dueAt, title: task.title }, null, 'Calendar event removed', conn.userId);
          if (updated) {
            outcome.unscheduledTasks += 1;
            await tx.insert(auditLogs).values({
              id: randomUUID(),
              workspaceId: conn.workspaceId,
              actorId: conn.userId,
              action: 'calendar.item_imported',
              targetType: 'task',
              targetId: task.id,
              metadata: { externalId: mapping.externalId, effect: 'unscheduled' },
            });
            await tx
              .insert(notifications)
              .values({
                id: randomUUID(),
                userId: conn.userId,
                workspaceId: conn.workspaceId,
                type: 'calendar',
                title: 'A calendar event was removed',
                body: `Your task “${task.title.slice(0, 120)}” was removed from your calendar and is now unscheduled.`,
                taskId: task.id,
              })
              .onConflictDoNothing();
          }
        }
        await tx.delete(calendarMappings).where(eq(calendarMappings.id, mapping.id));
      }

      // 3b) Mirror cleanup (M7-i2 G1/G2): an externally deleted event or
      // occurrence must stop rendering as an availability block. Every
      // reported id gets an exact-key delete. A bare (series-level) id
      // additionally removes every expanded instance of that series —
      // instance keys are `<seriesId><SEP><slot>`, so `<id><SEP>%` matches
      // exactly that series' instances and nothing else; an occurrence
      // (composite) id is exact-only, so sibling occurrences survive.
      // Connection-scoped (tenant isolation); deletes are idempotent.
      for (const deletedId of changes.deletedExternalIds) {
        await tx
          .delete(calendarEvents)
          .where(and(eq(calendarEvents.connectionId, conn.id), eq(calendarEvents.externalId, deletedId)));
        if (!deletedId.includes(CALENDAR_INSTANCE_KEY_SEPARATOR)) {
          const seriesPrefix = `${likeEscape(deletedId)}${CALENDAR_INSTANCE_KEY_SEPARATOR}%`;
          await tx
            .delete(calendarEvents)
            .where(and(eq(calendarEvents.connectionId, conn.id), like(calendarEvents.externalId, seriesPrefix)));
        }
      }
    }

    // 4) Advance the sync checkpoint.
    await tx
      .update(calendarConnections)
      .set({ syncToken: changes.nextSyncToken ?? conn.syncToken, lastSyncedAt: now, updatedAt: now })
      .where(eq(calendarConnections.id, conn.id));
  });

  outcome.tokens = tokensIfRefreshed(ctx);
  return outcome;
}

/**
 * Export pass: tasks with a due time become timed events on the
 * provider's primary (NEXTDOO) calendar (PRD §16.1/§16.6). Idempotent —
 * the unique (connection, task) mapping is the dedup key; re-running
 * never duplicates events. READ_WRITE connections only: export requires
 * the write scope the user chose before authorization.
 */
export async function runCalendarExport(ctx: SyncContext): Promise<CalendarSyncOutcome> {
  const outcome: CalendarSyncOutcome = { ...NOOP };
  const db = ctx.db;
  const now = ctx.now ?? new Date();

  const conn = await loadActiveConnection(db, ctx.connectionId);
  if (!conn || conn.mode !== 'READ_WRITE') return outcome;
  if (!(await ensureTokens(ctx, outcome))) return outcome;

  const horizon = new Date(now.getTime() + CALENDAR_EXPORT_HORIZON_DAYS * 86_400_000);
  const windowStart = new Date(now.getTime() - 3_600_000);
  const dueTasks = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.workspaceId, conn.workspaceId), ne(tasks.status, 'DELETED'), isNull(tasks.deletedAt), gte(tasks.dueAt, windowStart), lte(tasks.dueAt, horizon)))
    .orderBy(asc(tasks.dueAt), asc(tasks.id))
    .limit(500);
  const taskIds = dueTasks.map((t) => t.id);
  const mappings = taskIds.length ? await db.select().from(calendarMappings).where(and(eq(calendarMappings.connectionId, conn.id), inArray(calendarMappings.taskId, taskIds))) : [];
  const byTask = new Map(mappings.map((m) => [m.taskId, m]));
  const eventIds = mappings.map((m) => m.externalId);
  const eventMirrors = eventIds.length ? await db.select().from(calendarEvents).where(and(eq(calendarEvents.connectionId, conn.id), inArray(calendarEvents.externalId, eventIds))) : [];
  const mirrorByExternal = new Map(eventMirrors.map((e) => [e.externalId, e]));

  for (const task of dueTasks) {
    try {
      const mapping = byTask.get(task.id);
      if (!mapping) {
        const written = await ctx.provider.writeEvent({
          externalId: null,
          calendarId: 'primary',
          title: task.title,
          startsAt: task.dueAt!.toISOString(),
          endsAt: new Date(task.dueAt!.getTime() + 3_600_000).toISOString(),
          timeZone: null,
          isAllDay: false,
          busy: true,
        });
        await db.transaction(async (tx) => {
          await tx.insert(calendarMappings).values({
            id: randomUUID(),
            connectionId: conn.id,
            taskId: task.id,
            externalId: written.externalId,
            calendarId: written.calendarId,
            syncState: 'SYNCED',
            externalUpdatedAt: written.updatedAt ? new Date(written.updatedAt) : null,
            localUpdatedAt: task.updatedAt,
          });
          await tx
            .insert(calendarEvents)
            .values({
              id: randomUUID(),
              connectionId: conn.id,
              workspaceId: conn.workspaceId,
              externalId: written.externalId,
              calendarId: written.calendarId,
              title: written.title.slice(0, 500),
              startsAt: new Date(written.startsAt),
              endsAt: new Date(written.endsAt),
              timeZone: written.timeZone,
              isAllDay: written.isAllDay,
              busy: written.busy,
              etag: written.etag,
            })
            .onConflictDoNothing();
          await tx.insert(auditLogs).values({
            id: randomUUID(),
            workspaceId: conn.workspaceId,
            actorId: conn.userId,
            action: 'calendar.event_exported',
            targetType: 'task',
            targetId: task.id,
            metadata: { externalId: written.externalId },
          });
        });
        outcome.exportedCreated += 1;
        continue;
      }
      if (mapping.syncState !== 'SYNCED') continue; // CONFLICT waits for the user

      const mirror = mirrorByExternal.get(mapping.externalId);
      const taskDueMs = task.dueAt!.getTime();
      const mirrorStartMs = mirror ? new Date(mirror.startsAt).getTime() : null;
      if (mirrorStartMs === null || mirrorStartMs === taskDueMs) continue; // already aligned
      // Locally rescheduled since the last export: patch the event.
      const written = await ctx.provider.writeEvent({
        externalId: mapping.externalId,
        calendarId: mapping.calendarId ?? 'primary',
        title: task.title,
        startsAt: task.dueAt!.toISOString(),
        endsAt: new Date(taskDueMs + 3_600_000).toISOString(),
        timeZone: null,
        isAllDay: false,
        busy: true,
        etag: mirror?.etag ?? null,
      });
      const reLinked = written.externalId !== mapping.externalId;
      await db.transaction(async (tx) => {
        await tx
          .update(calendarMappings)
          .set({
            externalId: written.externalId,
            calendarId: written.calendarId,
            externalUpdatedAt: written.updatedAt ? new Date(written.updatedAt) : null,
            localUpdatedAt: task.updatedAt,
            updatedAt: new Date(),
          })
          .where(eq(calendarMappings.id, mapping.id));
        await tx
          .insert(calendarEvents)
          .values({
            id: randomUUID(),
            connectionId: conn.id,
            workspaceId: conn.workspaceId,
            externalId: written.externalId,
            calendarId: written.calendarId,
            title: written.title.slice(0, 500),
            startsAt: new Date(written.startsAt),
            endsAt: new Date(written.endsAt),
            timeZone: written.timeZone,
            isAllDay: written.isAllDay,
            busy: written.busy,
            etag: written.etag,
          })
          .onConflictDoNothing();
        if (reLinked) {
          // The external event was recreated (404 patch): drop the stale
          // mirror so capacity never double-counts the interval.
          await tx.delete(calendarEvents).where(and(eq(calendarEvents.connectionId, conn.id), eq(calendarEvents.externalId, mapping.externalId)));
        }
      });
      outcome.exportedUpdated += 1;
    } catch (error) {
      if (error instanceof CalendarRateLimited) {
        outcome.rateLimitedSeconds = error.retryAfterSeconds;
        return outcome;
      }
      if (error instanceof CalendarAuthError) {
        await pauseConnection(db, ctx.connectionId, 'TOKEN_REVOKED', String(error.message));
        outcome.paused = 'TOKEN_REVOKED';
        return outcome;
      }
      // Per-task isolation: one failing task never blocks the pass.
      await db.insert(auditLogs).values({
        id: randomUUID(),
        workspaceId: conn.workspaceId,
        actorId: null,
        action: 'calendar.export_failed',
        targetType: 'task',
        targetId: task.id,
        metadata: { error: String(error).slice(0, 200) },
      });
    }
  }

  // Deletions: tasks deleted/unscheduled while mapped → remove the event
  // (PRD §16.6 AC-2). The unique (connection, task) index means each task
  // has at most one live event.
  const allMappings = await db
    .select()
    .from(calendarMappings)
    .where(eq(calendarMappings.connectionId, conn.id))
    .orderBy(asc(calendarMappings.id))
    .limit(500);
  for (const mapping of allMappings) {
    const [task] = mapping.taskId
      ? await db.select().from(tasks).where(and(eq(tasks.id, mapping.taskId), eq(tasks.workspaceId, conn.workspaceId))).limit(1)
      : [];
    const stale = !task || task.status === 'DELETED' || task.deletedAt !== null || task.dueAt === null;
    if (!stale) continue;
    try {
      await ctx.provider.deleteEvent(mapping.externalId);
    } catch (error) {
      if (error instanceof CalendarRateLimited) {
        outcome.rateLimitedSeconds = error.retryAfterSeconds;
        break;
      }
      if (error instanceof CalendarAuthError) {
        await pauseConnection(db, ctx.connectionId, 'TOKEN_REVOKED', String(error.message));
        outcome.paused = 'TOKEN_REVOKED';
        return outcome;
      }
      continue; // keep the mapping; retry next pass
    }
    await db.transaction(async (tx) => {
      await tx.delete(calendarMappings).where(eq(calendarMappings.id, mapping.id));
      await tx.delete(calendarEvents).where(and(eq(calendarEvents.connectionId, conn.id), eq(calendarEvents.externalId, mapping.externalId)));
      await tx.insert(auditLogs).values({
        id: randomUUID(),
        workspaceId: conn.workspaceId,
        actorId: null,
        action: 'calendar.event_removed',
        targetType: 'calendar_mapping',
        targetId: mapping.id,
        metadata: { externalId: mapping.externalId, taskId: mapping.taskId },
      });
    });
    outcome.exportedDeleted += 1;
  }

  outcome.tokens = tokensIfRefreshed(ctx);
  return outcome;
}

/**
 * Renew the push channel before it lapses (PRD §16.1: webhooks renewed
 * proactively). Best effort — a failure here defers to the 10-minute poll.
 */
export async function renewCalendarChannel(ctx: SyncContext, webhookTarget: string): Promise<string | null> {
  const conn = await loadActiveConnection(ctx.db, ctx.connectionId);
  if (!conn) return null;
  try {
    await ctx.provider.ensureAccessToken();
    const margin = 24 * 3_600_000;
    if (conn.channelExpiresAt && conn.channelExpiresAt.getTime() - Date.now() > margin) return conn.channelExpiresAt.toISOString();
    const { expiresAt } = await ctx.provider.ensureChannel(conn.id, webhookTarget);
    await ctx.db
      .update(calendarConnections)
      .set({ channelExpiresAt: new Date(expiresAt), updatedAt: new Date() })
      .where(eq(calendarConnections.id, conn.id));
    return expiresAt;
  } catch (error) {
    if (error instanceof CalendarRateLimited || error instanceof CalendarAuthError) return null;
    throw error;
  }
}

/**
 * Disconnect (PRD §16.5): revoke where supported, wipe tokens from
 * storage, stop sync immediately. Mappings are retained as historical
 * metadata (purged after 30 days by the retention sweep); imported tasks
 * and exported events are left in place — deleting exported events is
 * explicitly NOT the default.
 */
export async function finalizeDisconnect(db: Database, connectionId: string, provider: CalendarProvider | null): Promise<{ revoked: boolean }> {
  const [conn] = await db.select().from(calendarConnections).where(eq(calendarConnections.id, connectionId)).limit(1);
  if (!conn) throw new Error('Calendar connection not found.');
  let revoked = false;
  if (provider && conn.accessTokenEncrypted) {
    try {
      await provider.revoke();
      revoked = true;
    } catch {
      revoked = false;
    }
  }
  await db.update(calendarConnections).set({
    status: 'DISCONNECTED',
    disconnectedAt: new Date(),
    accessTokenEncrypted: null,
    refreshTokenEncrypted: null,
    tokenExpiresAt: null,
    syncToken: null,
    channelExpiresAt: null,
    pauseReason: null,
    version: sql`${calendarConnections.version} + 1`,
    updatedAt: new Date(),
  }).where(eq(calendarConnections.id, connectionId));
  return { revoked };
}

/**
 * Housekeeping: drop expired OAuth states and, 30 days after disconnect,
 * the retained mappings + event mirrors (PRD §16.5). Tasks and audit
 * rows are never touched here.
 */
export async function sweepCalendarRetention(db: Database, now?: Date): Promise<{ states: number; mappings: number; events: number }> {
  const at = now ?? new Date();
  const states = await db.delete(calendarOauthStates).where(lte(calendarOauthStates.expiresAt, at)).returning({ id: calendarOauthStates.stateHash });
  const stale = await db
    .select()
    .from(calendarConnections)
    .where(and(eq(calendarConnections.status, 'DISCONNECTED'), lte(calendarConnections.disconnectedAt, new Date(at.getTime() - CALENDAR_MAPPING_RETENTION_DAYS * 86_400_000))));
  const staleIds = stale.map((c) => c.id);
  let mappings = 0;
  let events = 0;
  if (staleIds.length) {
    mappings = (await db.delete(calendarMappings).where(inArray(calendarMappings.connectionId, staleIds)).returning({ id: calendarMappings.id })).length;
    events = (await db.delete(calendarEvents).where(inArray(calendarEvents.connectionId, staleIds)).returning({ id: calendarEvents.id })).length;
  }
  return { states: states.length, mappings, events };
}

/**
 * One 60-second worker cycle (PRD §12.4 `calendar.sync`):
 *
 *  - export pass for every ACTIVE READ_WRITE connection (the 60-second
 *    export guarantee, PRD §16.6 AC-1);
 *  - import pass for connections whose last sync is older than the 10-minute
 *    incremental-poll cadence (PRD §16.1; push webhooks trigger immediate
 *    imports via the webhook route);
 *  - push-channel renewal before the channel lapses (PRD §16.1);
 *  - retention housekeeping (expired OAuth states, 30-day post-disconnect
 *    mapping/event mirrors, PRD §16.5).
 *
 * Failure policy (PRD §12.4): auth failures pause the connection
 * immediately with a reconnect prompt (§16.6); rate limits skip the pass
 * without counting; generic transport failures count per connection and
 * pause+notify after CALENDAR_SYNC_PAUSE_AFTER consecutive failures.
 */
export interface CalendarCycleDeps {
  /** Resolves a connection row to a provider (null = provider unconfigured). */
  providerFor?: (row: { id: string; provider: string; status: string; accessTokenEncrypted: string | null }) => CalendarProvider | null;
  /** Push-channel target URL (webhook endpoint); null disables channel upkeep. */
  webhookTarget?: string | null;
  /** Injected clock (tests). */
  now?: Date;
  /** Import cadence in ms (default 10 minutes, PRD §16.1). */
  importIntervalMs?: number;
}

export interface CalendarCycleResult {
  connections: number;
  imported: number;
  exported: number;
  paused: number;
  rateLimited: number;
  failed: number;
  retention: { states: number; mappings: number; events: number };
}

const CALENDAR_IMPORT_INTERVAL_MS = 10 * 60_000;

export async function runCalendarSyncCycle(db: Database, deps: CalendarCycleDeps = {}): Promise<CalendarCycleResult> {
  const now = deps.now ?? new Date();
  const importInterval = deps.importIntervalMs ?? CALENDAR_IMPORT_INTERVAL_MS;
  const result: CalendarCycleResult = { connections: 0, imported: 0, exported: 0, paused: 0, rateLimited: 0, failed: 0, retention: { states: 0, mappings: 0, events: 0 } };

  const rows = await db
    .select()
    .from(calendarConnections)
    .where(and(eq(calendarConnections.provider, 'google'), eq(calendarConnections.status, 'ACTIVE')));

  for (const row of rows) {
    result.connections += 1;
    const provider = deps.providerFor ? deps.providerFor(row) : null;
    if (!provider) continue; // provider unconfigured for this deployment
    const ctx: SyncContext = { db, connectionId: row.id, provider, now };
    let paused = false;
    let failed = false;
    try {
      // 1) Export every cycle (60s guarantee for due-time tasks).
      const exportOutcome = await runCalendarExport(ctx);
      result.exported += exportOutcome.exportedCreated + exportOutcome.exportedUpdated + exportOutcome.exportedDeleted;
      if (exportOutcome.paused) paused = true;
      if (exportOutcome.rateLimitedSeconds !== null) result.rateLimited += 1;

      // 2) Import on the 10-minute cadence (or when never synced).
      const dueForImport = !row.lastSyncedAt || now.getTime() - row.lastSyncedAt.getTime() >= importInterval;
      if (dueForImport) {
        const importOutcome = await runCalendarImport(ctx);
        result.imported += importOutcome.imported;
        if (importOutcome.conflicts) result.imported += importOutcome.conflicts;
        if (importOutcome.paused) paused = true;
        if (importOutcome.rateLimitedSeconds !== null) result.rateLimited += 1;
      }

      // 3) Renew the push channel before it lapses (best effort).
      if (deps.webhookTarget) {
        await renewCalendarChannel(ctx, deps.webhookTarget);
      }

      if (!paused) {
        await db
          .update(calendarConnections)
          .set({ consecutiveFailures: 0 })
          .where(and(eq(calendarConnections.id, row.id), ne(calendarConnections.consecutiveFailures, 0)));
      }
    } catch (error) {
      if (error instanceof CalendarAuthError) {
        await pauseConnection(db, row.id, 'TOKEN_REVOKED', String(error.message));
        paused = true;
      } else {
        // Count a generic failure; pause + notify at the threshold (§12.4).
        const [current] = await db.select({ n: calendarConnections.consecutiveFailures }).from(calendarConnections).where(eq(calendarConnections.id, row.id)).limit(1);
        const count = (current?.n ?? 0) + 1;
        await db.update(calendarConnections).set({ consecutiveFailures: count }).where(eq(calendarConnections.id, row.id));
        await db.insert(auditLogs).values({
          id: randomUUID(),
          workspaceId: row.workspaceId,
          actorId: null,
          action: 'calendar.sync_failed',
          targetType: 'calendar_connection',
          targetId: row.id,
          metadata: { error: String(error).slice(0, 200), consecutive: count },
        });
        if (count >= CALENDAR_SYNC_PAUSE_AFTER) {
          await pauseConnection(db, row.id, 'SYNC_FAILED', String(error));
          paused = true;
        }
        failed = true;
      }
    }
    if (paused) result.paused += 1;
    if (failed && !paused) result.failed += 1;
  }

  result.retention = await sweepCalendarRetention(db, now);
  return result;
}
