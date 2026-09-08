import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { AppError, notFound } from '@nextdoo/contracts';
import { resolveTimerOverlap } from '@nextdoo/core';
import { tasks, timerSessions } from '@nextdoo/db';
import { getDb } from '../db';
import { newId } from '../ids';
import { appendTrackingEvent, publishEvent, writeAudit } from './events';
import { scheduleTrackingEvaluation } from './tracking';

/**
 * Focus timer and time tracking (PRD §6.7).
 *
 * Multi-device rule: only one timer is canonical per user. A second device
 * starting a timer does not delete the first — it closes it and flags OVERLAPPED,
 * preserving both records.
 */

export interface TimerActor {
  userId: string;
  workspaceId: string;
  requestId?: string;
}

function elapsedSeconds(row: typeof timerSessions.$inferSelect, at: Date): number {
  let total = row.accumulatedSeconds;
  if (row.status === 'RUNNING' && row.lastResumedAt) {
    total += Math.max(0, Math.floor((at.getTime() - row.lastResumedAt.getTime()) / 1000));
  }
  return total + row.manualAdjustmentSeconds;
}

function serialise(row: typeof timerSessions.$inferSelect, at = new Date()) {
  return {
    id: row.id,
    taskId: row.taskId,
    deviceId: row.deviceId,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
    elapsedSeconds: elapsedSeconds(row, at),
    version: row.version,
  };
}

export async function startTimer(actor: TimerActor, taskId: string, deviceId: string, startedAt?: string) {
  const db = getDb();
  const now = startedAt ? new Date(startedAt) : new Date();

  return db.transaction(async (tx) => {
    const taskRows = await tx
      .select({ id: tasks.id, status: tasks.status })
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, actor.workspaceId)))
      .limit(1);
    if (!taskRows[0] || taskRows[0].status === 'DELETED') throw notFound('task', taskId);

    // Close any other open session for this user, preserving it.
    const open = await tx
      .select()
      .from(timerSessions)
      .where(and(eq(timerSessions.userId, actor.userId), inArray(timerSessions.status, ['RUNNING', 'PAUSED'])));

    const [created] = await tx
      .insert(timerSessions)
      .values({
        id: newId(),
        workspaceId: actor.workspaceId,
        taskId,
        userId: actor.userId,
        deviceId,
        startedAt: now,
        lastResumedAt: now,
        status: 'RUNNING',
      })
      .returning();
    if (!created) throw new AppError('INTERNAL_ERROR', 'Timer could not be started.');

    for (const prior of open) {
      const { overlappedId } = resolveTimerOverlap(
        { id: prior.id, startedAt: prior.startedAt },
        { id: created.id, startedAt: created.startedAt },
      );
      const isPriorOverlapped = overlappedId === prior.id;
      await tx
        .update(timerSessions)
        .set({
          status: isPriorOverlapped ? 'OVERLAPPED' : 'STOPPED',
          endedAt: now,
          accumulatedSeconds: elapsedSeconds(prior, now) - prior.manualAdjustmentSeconds,
          lastResumedAt: null,
          version: sql`${timerSessions.version} + 1`,
        })
        .where(eq(timerSessions.id, prior.id));
      // Time already spent still counts toward the other task.
      await applyDurationToTask(tx, prior.taskId, Math.floor(elapsedSeconds(prior, now) / 60));
    }

    await appendTrackingEvent(tx, {
      workspaceId: actor.workspaceId,
      taskId,
      type: 'TASK_STARTED',
      actorId: actor.userId,
      occurredAt: now,
      deviceId,
    });
    await publishEvent(tx, {
      eventType: 'timer.started',
      workspaceId: actor.workspaceId,
      actorId: actor.userId,
      entityType: 'timer_session',
      entityId: created.id,
    });

    return serialise(created, now);
  });
}

export async function updateTimer(actor: TimerActor, timerId: string, action: 'pause' | 'resume' | 'stop', at?: string) {
  const db = getDb();
  const now = at ? new Date(at) : new Date();

  const result = await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(timerSessions)
      .where(and(eq(timerSessions.id, timerId), eq(timerSessions.userId, actor.userId)))
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound('timer_session', timerId);
    if (row.status === 'STOPPED') {
      throw new AppError('VALIDATION_FAILED', 'This timer has already been stopped.');
    }

    const runningSeconds =
      row.status === 'RUNNING' && row.lastResumedAt
        ? Math.max(0, Math.floor((now.getTime() - row.lastResumedAt.getTime()) / 1000))
        : 0;

    const patch: Partial<typeof timerSessions.$inferInsert> = { version: sql`${timerSessions.version} + 1` as never };

    if (action === 'pause') {
      if (row.status !== 'RUNNING') throw new AppError('VALIDATION_FAILED', 'Timer is not running.');
      patch.status = 'PAUSED';
      patch.accumulatedSeconds = row.accumulatedSeconds + runningSeconds;
      patch.lastResumedAt = null;
    } else if (action === 'resume') {
      if (row.status !== 'PAUSED') throw new AppError('VALIDATION_FAILED', 'Timer is not paused.');
      patch.status = 'RUNNING';
      patch.lastResumedAt = now;
    } else {
      patch.status = 'STOPPED';
      patch.accumulatedSeconds = row.accumulatedSeconds + runningSeconds;
      patch.lastResumedAt = null;
      patch.endedAt = now;
    }

    const [updated] = await tx
      .update(timerSessions)
      .set(patch)
      .where(eq(timerSessions.id, timerId))
      .returning();
    if (!updated) throw notFound('timer_session', timerId);

    if (action === 'pause') {
      await appendTrackingEvent(tx, {
        workspaceId: actor.workspaceId,
        taskId: row.taskId,
        type: 'TASK_PAUSED',
        actorId: actor.userId,
        occurredAt: now,
      });
    }

    if (action === 'stop') {
      const minutes = Math.floor(elapsedSeconds(updated, now) / 60);
      await applyDurationToTask(tx, row.taskId, minutes);
      await appendTrackingEvent(tx, {
        workspaceId: actor.workspaceId,
        taskId: row.taskId,
        type: 'TIME_LOGGED',
        actorId: actor.userId,
        occurredAt: now,
        payload: { minutes, source: 'timer' },
        idempotencyKey: `timer-stop:${timerId}`,
      });
      await publishEvent(tx, {
        eventType: 'timer.stopped',
        workspaceId: actor.workspaceId,
        actorId: actor.userId,
        entityType: 'timer_session',
        entityId: timerId,
        payload: { minutes },
      });
    }

    return { timer: serialise(updated, now), taskId: row.taskId, stopped: action === 'stop' };
  });

  if (result.stopped) await scheduleTrackingEvaluation(actor.workspaceId, result.taskId);
  return result.timer;
}

/** Manual time entry, audited because it changes a measured value (PRD §6.7). */
export async function logTime(actor: TimerActor, taskId: string, minutes: number, note?: string) {
  const db = getDb();
  await db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: tasks.id, status: tasks.status })
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, actor.workspaceId)))
      .limit(1);
    if (!rows[0] || rows[0].status === 'DELETED') throw notFound('task', taskId);

    await applyDurationToTask(tx, taskId, minutes);
    await appendTrackingEvent(tx, {
      workspaceId: actor.workspaceId,
      taskId,
      type: 'TIME_LOGGED',
      actorId: actor.userId,
      payload: { minutes, source: 'manual' },
    });
    await writeAudit(tx, {
      workspaceId: actor.workspaceId,
      actorId: actor.userId,
      action: 'time.logged_manually',
      targetType: 'task',
      targetId: taskId,
      metadata: { minutes },
      requestId: actor.requestId ?? null,
    });
  });
  await scheduleTrackingEvaluation(actor.workspaceId, taskId);
}

async function applyDurationToTask(tx: any, taskId: string, minutes: number): Promise<void> {
  if (minutes <= 0) return;
  await tx
    .update(tasks)
    .set({ actualMinutes: sql`${tasks.actualMinutes} + ${minutes}`, updatedAt: new Date() })
    .where(eq(tasks.id, taskId));
}

export async function getActiveTimer(userId: string) {
  const db = getDb();
  const rows = await db
    .select()
    .from(timerSessions)
    .where(and(eq(timerSessions.userId, userId), inArray(timerSessions.status, ['RUNNING', 'PAUSED'])))
    .orderBy(desc(timerSessions.startedAt))
    .limit(1);
  return rows[0] ? serialise(rows[0]) : null;
}
