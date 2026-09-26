import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { AppError, logTimeSchema, notFound, versionConflict, timeEntrySchema, editTimeEntrySchema, removeTimeEntrySchema } from '@nextdoo/contracts';
import { tasks, timerSessions, trackingEvents, type Database } from '@nextdoo/db';
import { getDb, withTransaction } from '../db';
import { withWorkspaceTransaction } from './transactions';
import { loadTask, serialiseTask } from './tasks';
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
  // An accepted client transition may be slightly ahead of the server clock.
  // Do not project elapsed work from an observation before that transition.
  const observed = new Date(Math.max(at.getTime(), row.lastTransitionAt.getTime()));
  return {
    id: row.id,
    taskId: row.taskId,
    workspaceId: row.workspaceId,
    deviceId: row.deviceId,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
    elapsedSeconds: elapsedSeconds(row, observed),
    version: row.version,
    observedAt: observed.toISOString(),
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

export async function startTimer(actor: TimerActor, taskId: string, deviceId: string, startedAt?: string, id = newId()) {
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
      id, workspaceId: actor.workspaceId, taskId, userId: actor.userId, deviceId,
      startedAt: now, lastResumedAt: incomingOlder ? null : now,
      status: incomingOlder ? 'OVERLAPPED' : 'RUNNING',
      endedAt: incomingOlder ? canonical.startedAt : null,
      accumulatedSeconds: incomingOlder ? Math.floor((canonical.startedAt.getTime() - now.getTime()) / 1000) : 0,
      lastTransitionAt: incomingOlder ? canonical.startedAt : now,
    }).returning();
    if (!created) throw new AppError('INTERNAL_ERROR', 'Timer could not be started.');
    await appendTrackingEvent(tx, { workspaceId: actor.workspaceId, taskId, type: 'TASK_STARTED', actorId: actor.userId, occurredAt: now, deviceId, idempotencyKey: `timer-start:${created.id}` });
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

export async function updateTimer(actor: TimerActor, timerId: string, action: 'pause' | 'resume' | 'stop', at?: string, version?: number) {
  const now = eventTime(at);

  const result = await withTimerTransaction(actor, async (tx) => {
    const rows = await tx
      .select()
      .from(timerSessions)
      .where(and(eq(timerSessions.id, timerId), eq(timerSessions.userId, actor.userId), eq(timerSessions.workspaceId, actor.workspaceId)))
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound('timer_session', timerId);
    if (version !== undefined && row.version !== version) throw versionConflict('timer', timerId);
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
        idempotencyKey: `timer-pause:${timerId}:${updated.version}`,
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
      metadata: { minutes, note: note ?? null },
      requestId: actor.requestId ?? null,
    });
  });
}

async function applyDurationToTask(tx: Database, actor: TimerActor, taskId: string, seconds: number): Promise<void> {
  if (seconds === 0) return;
  const [current] = await tx.select().from(tasks).where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, actor.workspaceId)));
  if (!current) throw notFound('task', taskId);
  const total = current.actualMinutes * 60 + current.actualSecondsRemainder + seconds;
  if (total < 0) throw new AppError('VALIDATION_FAILED', 'A correction cannot reduce recorded time below zero.');
  const [updated] = await tx.update(tasks)
    .set({ actualMinutes: Math.floor(total / 60),
      actualSecondsRemainder: total % 60, updatedAt: new Date(), version: sql`${tasks.version} + 1` })
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

/** Dated manual entries reuse timer_sessions; changes append compensating tracking events. */
export async function createTimeEntry(actor: TimerActor, raw: unknown, id = newId()) {
  const input = timeEntrySchema.parse(raw);
  return withTimerTransaction(actor, async tx => {
    const [task] = await tx.select().from(tasks).where(and(eq(tasks.id,input.taskId),eq(tasks.workspaceId,actor.workspaceId)));
    if (!task || task.status === 'DELETED') throw notFound('task',input.taskId);
    const start = eventTime(input.startedAt), end = eventTime(input.endedAt);
    if (end.getTime() > Date.now()+15*60000) throw new AppError('VALIDATION_FAILED','Time entries cannot end in the future.');
    const seconds = Math.floor((end.getTime()-start.getTime())/1000);
    if (seconds < 1) throw new AppError('VALIDATION_FAILED','Record at least one second.');
    const [entry] = await tx.insert(timerSessions).values({id,workspaceId:actor.workspaceId,taskId:input.taskId,userId:actor.userId,
      deviceId:'manual-entry',startedAt:start,endedAt:end,lastTransitionAt:end,status:'STOPPED',accumulatedSeconds:seconds}).returning();
    await applyDurationToTask(tx,actor,input.taskId,seconds);
    await appendTrackingEvent(tx,{workspaceId:actor.workspaceId,taskId:input.taskId,actorId:actor.userId,type:'TIME_LOGGED',occurredAt:start,
      payload:{seconds,minutes:seconds/60,source:'manual-entry',entryId:id,note:input.note},idempotencyKey:`manual-entry:${id}:1`});
    await writeAudit(tx,{workspaceId:actor.workspaceId,actorId:actor.userId,action:'time.entry_created',targetType:'timer_session',targetId:id,
      metadata:{seconds,startedAt:input.startedAt,endedAt:input.endedAt},requestId:actor.requestId});
    return {entry:serialise(entry!)};
  });
}
export async function reviseTimeEntry(actor: TimerActor, raw: unknown, remove = false) {
  const input = remove ? removeTimeEntrySchema.parse(raw) : editTimeEntrySchema.parse(raw);
  return withTimerTransaction(actor,async tx=>{
    const [entry]=await tx.select().from(timerSessions).where(and(eq(timerSessions.id,input.entryId),eq(timerSessions.workspaceId,actor.workspaceId),eq(timerSessions.userId,actor.userId)));
    if (!entry || entry.deviceId!=='manual-entry' || entry.status!=='STOPPED') throw notFound('manual time entry',input.entryId);
    await loadTask(actor.workspaceId,entry.taskId);
    if (entry.version!==input.version) throw versionConflict('timer',entry.id);
    const before=entry.accumulatedSeconds+entry.manualAdjustmentSeconds;
    if (!before) throw new AppError('VALIDATION_FAILED','This entry was already removed.');
    const start='startedAt' in input ? eventTime(String(input.startedAt)) : entry.startedAt;
    const end='endedAt' in input ? eventTime(String(input.endedAt)) : entry.endedAt!;
    const after=remove?0:Math.floor((end.getTime()-start.getTime())/1000);
    if ((!remove&&after<1)||end.getTime()>Date.now()+15*60000) throw new AppError('VALIDATION_FAILED','Invalid time entry timestamps.');
    await applyDurationToTask(tx,actor,entry.taskId,after-before);
    const [updated]=await tx.update(timerSessions).set({startedAt:start,endedAt:end,accumulatedSeconds:after,manualAdjustmentSeconds:0,version:entry.version+1,updatedAt:new Date()}).where(eq(timerSessions.id,entry.id)).returning();
    await appendTrackingEvent(tx,{workspaceId:actor.workspaceId,taskId:entry.taskId,actorId:actor.userId,type:'TIME_LOGGED',occurredAt:start,
      payload:{seconds:after-before,minutes:(after-before)/60,source:remove?'manual-entry-removed':'manual-entry-corrected',entryId:entry.id,note:input.note,
        previous:{seconds:before,startedAt:entry.startedAt.toISOString(),endedAt:entry.endedAt?.toISOString()},secondsAfter:after},idempotencyKey:`manual-entry:${entry.id}:${entry.version+1}`});
    await writeAudit(tx,{workspaceId:actor.workspaceId,actorId:actor.userId,action:remove?'time.entry_removed':'time.entry_corrected',targetType:'timer_session',targetId:entry.id,
      metadata:{before,after,previousStart:entry.startedAt.toISOString(),previousEnd:entry.endedAt?.toISOString(),startedAt:start.toISOString(),endedAt:end.toISOString()},requestId:actor.requestId});
    return {entry:serialise(updated!)};
  });
}
export async function listTimeEntries(actor: TimerActor, taskId: string) {
  const [task]=await getDb().select({id:tasks.id}).from(tasks).where(and(eq(tasks.id,taskId),eq(tasks.workspaceId,actor.workspaceId)));
  if(!task)throw notFound('task',taskId);
  const entries=await getDb().select().from(timerSessions).where(and(eq(timerSessions.taskId,taskId),eq(timerSessions.workspaceId,actor.workspaceId),eq(timerSessions.userId,actor.userId),eq(timerSessions.deviceId,'manual-entry'))).orderBy(desc(timerSessions.startedAt)).limit(51);
  const notes=await getDb().select({payload:trackingEvents.payload}).from(trackingEvents).where(and(eq(trackingEvents.workspaceId,actor.workspaceId),eq(trackingEvents.taskId,taskId),eq(trackingEvents.type,'TIME_LOGGED'))).orderBy(desc(trackingEvents.sequence));
  return {hasMore:entries.length>50,entries:entries.slice(0,50).map(e=>({...serialise(e),note:(notes.find(n=>(n.payload as Record<string,unknown>).entryId===e.id)?.payload as Record<string,unknown>|undefined)?.note??'',removed:e.accumulatedSeconds+e.manualAdjustmentSeconds===0}))};
}
