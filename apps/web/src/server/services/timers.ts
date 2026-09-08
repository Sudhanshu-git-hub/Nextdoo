import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { AppError, logTimeSchema, notFound } from '@nextdoo/contracts';
import { tasks, timerSessions, type Database } from '@nextdoo/db';
import { getDb, withTransaction } from '../db';
import { withWorkspaceTransaction } from './transactions';
import { serialiseTask } from './tasks';
import { newId } from '../ids';
import { appendTrackingEvent, publishEvent, recordSyncChange, writeAudit } from './events';
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

/** User lock first, then all affected workspaces in deterministic order. */
function withTimerTransaction<T>(actor: TimerActor, perform: (db: Database) => Promise<T>): Promise<T> {
  return withTransaction(async (db) => {
    await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'timer-user:' + actor.userId}, 0))`);
    const open = await db.select({ workspaceId: timerSessions.workspaceId }).from(timerSessions)
      .where(and(eq(timerSessions.userId, actor.userId), inArray(timerSessions.status, ['RUNNING', 'PAUSED'])));
    for (const id of [...new Set([actor.workspaceId, ...open.map((r) => r.workspaceId)])].sort()) {
      await withWorkspaceTransaction(id, async () => {});
    }
    return perform(db);
  });
}
function eventTime(value?: string): Date {
  const time = value ? new Date(value) : new Date();
  if (!Number.isFinite(time.getTime())) throw new AppError('VALIDATION_FAILED', 'Invalid timer timestamp.');
  return time;
}

export async function startTimer(actor: TimerActor, taskId: string, deviceId: string, startedAt?: string) {
  const now = eventTime(startedAt);
  return withTimerTransaction(actor, async (tx) => {
    const [task] = await tx.select().from(tasks).where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, actor.workspaceId)));
    if (!task || task.status === 'DELETED') throw notFound('task', taskId);
    const open = await tx.select().from(timerSessions)
      .where(and(eq(timerSessions.userId, actor.userId), inArray(timerSessions.status, ['RUNNING', 'PAUSED'])))
      .orderBy(desc(timerSessions.startedAt));
    const canonical = open[0];
    const incomingOlder = canonical && now < canonical.startedAt;
    if (!incomingOlder && open.some((r) => now < r.lastTransitionAt)) throw new AppError('VALIDATION_FAILED', 'Start predates an already recorded timer transition.');
    // Only close the existing sessions if the incoming one is chronologically newer.
    if (!incomingOlder) {
      for (const prior of open) {
        await tx.update(timerSessions).set({ status: 'OVERLAPPED', endedAt: now,
          accumulatedSeconds: elapsedSeconds(prior, now) - prior.manualAdjustmentSeconds,
          lastResumedAt: null, lastTransitionAt: now, updatedAt: new Date(), version: sql`${timerSessions.version} + 1`,
        }).where(eq(timerSessions.id, prior.id));
        const seconds = elapsedSeconds(prior, now), minutes = seconds / 60;
        await applyDurationToTask(tx, { ...actor, workspaceId: prior.workspaceId }, prior.taskId, seconds);
        await appendTrackingEvent(tx, { workspaceId: prior.workspaceId, taskId: prior.taskId, type: 'TIME_LOGGED', actorId: actor.userId,
          occurredAt: now, payload: { minutes, seconds, source: 'timer-overlap' }, idempotencyKey: `timer-stop:${prior.id}` });
      }
    }
    const [created] = await tx.insert(timerSessions).values({
      id: newId(), workspaceId: actor.workspaceId, taskId, userId: actor.userId, deviceId,
      startedAt: now, lastResumedAt: incomingOlder ? null : now,
      status: incomingOlder ? 'OVERLAPPED' : 'RUNNING',
      endedAt: incomingOlder ? canonical.startedAt : null,
      accumulatedSeconds: incomingOlder ? Math.floor((canonical.startedAt.getTime() - now.getTime()) / 1000) : 0,
      lastTransitionAt: incomingOlder ? canonical.startedAt : now,
    }).returning();
    if (!created) throw new AppError('INTERNAL_ERROR', 'Timer could not be started.');
    await appendTrackingEvent(tx, { workspaceId: actor.workspaceId, taskId, type: 'TASK_STARTED', actorId: actor.userId, occurredAt: now, deviceId });
    if (incomingOlder) {
      const seconds = created.accumulatedSeconds, minutes = seconds / 60;
      await applyDurationToTask(tx, actor, taskId, seconds);
      await appendTrackingEvent(tx, { workspaceId: actor.workspaceId, taskId, type: 'TIME_LOGGED', actorId: actor.userId,
        occurredAt: canonical.startedAt, payload: { minutes, seconds, source: 'timer-overlap' }, idempotencyKey: `timer-stop:${created.id}` });
    }
    await publishEvent(tx, { eventType: 'timer.started', workspaceId: actor.workspaceId, actorId: actor.userId, entityType: 'timer_session', entityId: created.id });
    return serialise(created);
  });
}

export async function updateTimer(actor: TimerActor, timerId: string, action: 'pause' | 'resume' | 'stop', at?: string) {
  const now = eventTime(at);

  const result = await withTimerTransaction(actor, async (tx) => {
    const rows = await tx
      .select()
      .from(timerSessions)
      .where(and(eq(timerSessions.id, timerId), eq(timerSessions.userId, actor.userId), eq(timerSessions.workspaceId, actor.workspaceId)))
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound('timer_session', timerId);
    if (now < row.lastTransitionAt) throw new AppError('VALIDATION_FAILED', 'Timer timestamps cannot move backwards.');
    if (row.status === 'STOPPED' || row.status === 'OVERLAPPED') {
      throw new AppError('VALIDATION_FAILED', 'This timer has already been stopped.');
    }

    const runningSeconds =
      row.status === 'RUNNING' && row.lastResumedAt
        ? Math.max(0, Math.floor((now.getTime() - row.lastResumedAt.getTime()) / 1000))
        : 0;

    const patch: Partial<typeof timerSessions.$inferInsert> = { lastTransitionAt: now, updatedAt: new Date(), version: sql`${timerSessions.version} + 1` as never };

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
      const seconds = elapsedSeconds(updated, now), minutes = seconds / 60;
      await applyDurationToTask(tx, actor, row.taskId, seconds);
      await appendTrackingEvent(tx, {
        workspaceId: actor.workspaceId,
        taskId: row.taskId,
        type: 'TIME_LOGGED',
        actorId: actor.userId,
        occurredAt: now,
        payload: { minutes, seconds, source: 'timer' },
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

    return { timer: serialise(updated), taskId: row.taskId, stopped: action === 'stop' };
  });

  return result.timer;
}

/** Manual time entry, audited because it changes a measured value (PRD §6.7). */
export async function logTime(actor: TimerActor, taskId: string, minutes: number, note?: string) {
  logTimeSchema.parse({ taskId, minutes, note });
  await withTimerTransaction(actor, async (tx) => {
    const rows = await tx
      .select({ id: tasks.id, status: tasks.status })
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, actor.workspaceId)))
      .limit(1);
    if (!rows[0] || rows[0].status === 'DELETED') throw notFound('task', taskId);

    await applyDurationToTask(tx, actor, taskId, minutes * 60);
    await appendTrackingEvent(tx, {
      workspaceId: actor.workspaceId,
      taskId,
      type: 'TIME_LOGGED',
      actorId: actor.userId,
      payload: { minutes, seconds: minutes * 60, note: note ?? null, source: 'manual' },
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
}

async function applyDurationToTask(tx: Database, actor: TimerActor, taskId: string, seconds: number): Promise<void> {
  if (seconds <= 0) return;
  const [updated] = await tx.update(tasks)
    .set({ actualMinutes: sql`${tasks.actualMinutes} + floor((${tasks.actualSecondsRemainder}::bigint + ${seconds})::numeric / 60)::integer`,
      actualSecondsRemainder: sql`(${tasks.actualSecondsRemainder}::bigint + ${seconds}) % 60`, updatedAt: new Date(), version: sql`${tasks.version} + 1` })
    .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, actor.workspaceId))).returning();
  if (!updated) throw notFound('task', taskId);
  await recordSyncChange(tx, { workspaceId: actor.workspaceId, entityType: 'task', entityId: taskId, operation: 'update', payload: serialiseTask(updated), version: updated.version });
  await scheduleTrackingEvaluation(actor.workspaceId, taskId);
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
