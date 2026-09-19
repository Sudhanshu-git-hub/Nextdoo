import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { AppError, type ApplyTrackingCorrectionInput, type RecalculateRangeInput, type TrackingCorrection } from '@nextdoo/contracts';
import { trackingBackfills, trackingCorrections, trackingJobs, workspaces, type Database } from '@nextdoo/db';
import { getDb } from '../db';
import { newId } from '../ids';
import { withWorkspaceTransaction } from './transactions';
import { loadTask, updateTask, type TaskActor } from './tasks';
import { writeAudit } from './events';
import { recordTrackingCorrection, recordTrackingCorrectionFailed } from '../metrics';

const TOGGLE_KINDS = ['EXTERNALLY_BLOCKED', 'UNTRACKED_COMPLETION', 'EXCLUDED_FROM_ANALYTICS'] as const;
type ToggleKind = (typeof TOGGLE_KINDS)[number];

export type SerialisedCorrection = TrackingCorrection;

export interface CorrectionResult {
  /** 'noop' when the requested state was already the effective one. */
  change: 'applied' | 'noop';
  state: 'SET' | 'CLEAR' | null;
  correction: SerialisedCorrection;
}

type CorrectionRow = typeof trackingCorrections.$inferSelect;

function serialise(row: CorrectionRow): SerialisedCorrection {
  const payload = row.payload as { state?: unknown; to?: unknown } | null;
  const state = payload && typeof payload.state === 'string' ? (payload.state as 'SET' | 'CLEAR') : null;
  return {
    id: row.id,
    kind: row.kind,
    state,
    reason: row.reason,
    dueTo: payload && typeof payload.to === 'string' ? payload.to : null,
    createdAt: row.createdAt.toISOString(),
  };
}

async function latestCorrectionsForTask(db: Database, workspaceId: string, taskId: string): Promise<CorrectionRow[]> {
  return db
    .select()
    .from(trackingCorrections)
    .where(
      and(
        eq(trackingCorrections.workspaceId, workspaceId),
        eq(trackingCorrections.taskId, taskId),
        inArray(trackingCorrections.kind, [...TOGGLE_KINDS, 'DUE_DATE_CORRECTED']),
      ),
    )
    .orderBy(desc(trackingCorrections.createdAt), desc(trackingCorrections.id));
}

function effectiveState(rows: CorrectionRow[], kind: string): 'SET' | 'CLEAR' | undefined {
  const latest = rows.find((r) => r.kind === kind);
  const state = (latest?.payload as { state?: unknown } | undefined)?.state;
  return state === 'SET' || state === 'CLEAR' ? state : undefined;
}

/**
 * PRD §7.7: "Users may correct an incorrect due date, mark a task as externally
 * blocked, mark a completion as untracked, exclude a task from analytics".
 *
 * Corrections are immutable rows (supersede-never-mutate): the latest row per
 * (task, kind) is the effective one; undoing a toggle inserts a new CLEAR row.
 * The due-date kind reuses the existing versioned due-date path (events, sync,
 * outbox and tracking invalidation all commit atomically inside the same
 * re-entrant transaction).
 */
export async function applyTrackingCorrection(actor: TaskActor, taskId: string, input: ApplyTrackingCorrectionInput): Promise<CorrectionResult> {
  try {
    return await withWorkspaceTransaction(actor.workspaceId, async (db) => {
      const task = await loadTask(actor.workspaceId, taskId);
      const rows = await latestCorrectionsForTask(db, actor.workspaceId, taskId);

      if (input.kind === 'DUE_DATE_CORRECTED') {
        const newDue = new Date(input.dueAt!);
        if (task.dueAt && task.dueAt.getTime() === newDue.getTime()) {
          throw new AppError('VALIDATION_FAILED', 'The due date is already the corrected value.');
        }
        // `fastTracking: false` — the in-transaction fast path would write the
        // corrected result with `recalculated: false`; the durable invalidation
        // (PG trigger + outbox, unaffected) still re-evaluates, and the worker
        // path marks the new result `recalculated` (PRD §7.7, §7.11 TR-05).
        const updated = await updateTask(actor, taskId, { version: task.version, dueAt: newDue.toISOString() }, { fastTracking: false });
        const [row] = await db
          .insert(trackingCorrections)
          .values({
            id: newId(),
            workspaceId: actor.workspaceId,
            taskId,
            actorId: actor.userId,
            kind: 'DUE_DATE_CORRECTED',
            reason: input.reason,
            payload: { from: task.dueAt?.toISOString() ?? null, to: newDue.toISOString(), taskVersion: updated.version },
          })
          .returning();
        if (!row) throw new AppError('INTERNAL_ERROR', 'The correction was not recorded.');
        await writeAudit(db, {
          workspaceId: actor.workspaceId,
          actorId: actor.userId,
          action: 'tracking.correction_due_date',
          targetType: 'task',
          targetId: taskId,
          metadata: { from: task.dueAt?.toISOString() ?? null, to: newDue.toISOString() },
          requestId: actor.requestId,
        });
        recordTrackingCorrection(actor.workspaceId, 'DUE_DATE_CORRECTED', 'SET');
        return { change: 'applied', state: null, correction: serialise(row) };
      }

      const kind = input.kind as ToggleKind;
      const action = input.action ?? 'SET';
      const effective = effectiveState(rows, kind);
      if (effective === action) {
        return { change: 'noop', state: action, correction: serialise(rows.find((r) => r.kind === kind)!) };
      }
      const [row] = await db
        .insert(trackingCorrections)
        .values({ id: newId(), workspaceId: actor.workspaceId, taskId, actorId: actor.userId, kind, reason: input.reason, payload: { state: action } })
        .returning();
      if (!row) throw new AppError('INTERNAL_ERROR', 'The correction was not recorded.');
      // Force re-evaluation through the existing fenced, retried job machinery.
      await db
        .update(trackingJobs)
        .set({
          revision: sql`${trackingJobs.revision} + 1`,
          queuedRevision: sql`${trackingJobs.revision} + 1`,
          nextEvaluationAt: null,
          nextAttemptAt: sql`clock_timestamp()`,
          claimToken: null,
          leaseExpiresAt: null,
          attempts: 0,
          lastError: null,
          lastErrorAt: null,
        })
        .where(and(eq(trackingJobs.taskId, taskId), eq(trackingJobs.workspaceId, actor.workspaceId)));
      await writeAudit(db, {
        workspaceId: actor.workspaceId,
        actorId: actor.userId,
        action: 'tracking.correction',
        targetType: 'task',
        targetId: taskId,
        metadata: { kind, action },
        requestId: actor.requestId,
      });
      recordTrackingCorrection(actor.workspaceId, kind, action);
      return { change: 'applied', state: action, correction: serialise(row) };
    });
  } catch (error) {
    const code = error instanceof AppError ? error.code : 'INTERNAL_ERROR';
    recordTrackingCorrectionFailed(actor.workspaceId, input.kind, code);
    throw error;
  }
}

/** Latest immutable correction rows for one task (UI evidence). */
export async function listTaskCorrections(workspaceId: string, taskId: string, limit = 10): Promise<SerialisedCorrection[]> {
  const rows = await latestCorrectionsForTask(getDb(), workspaceId, taskId);
  return rows.slice(0, limit).map(serialise);
}

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const dayMs = (key: string) => Date.parse(`${key}T00:00:00Z`);
const toDayKey = (d: Date) => d.toISOString().slice(0, 10);

/**
 * PRD §7.6: bounded backfill, default last 90 days, chunked by workspace and
 * day (one day per worker run), rate limited at 10 requests/hour/user by the
 * route. Historical results are superseded, never mutated.
 */
export async function requestTrackingBackfill(
  actor: TaskActor,
  input: RecalculateRangeInput,
): Promise<{ id: string; from: string; to: string; totalDays: number; status: string }> {
  const db = getDb();
  const [workspace] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(eq(workspaces.id, actor.workspaceId), eq(workspaces.ownerId, actor.userId), isNull(workspaces.deletedAt)));
  if (!workspace) throw new AppError('NOT_FOUND', 'Workspace not found.');

  const today = toDayKey(new Date());
  const from = input.from ?? toDayKey(new Date(Date.now() - 89 * 86_400_000));
  const to = input.to ?? today;
  if (!DATE_KEY.test(from) || !DATE_KEY.test(to)) throw new AppError('VALIDATION_FAILED', 'Invalid date range.');
  if (from > to) throw new AppError('VALIDATION_FAILED', 'The range start must not be after its end.');
  const days = Math.round((dayMs(to) - dayMs(from)) / 86_400_000) + 1;
  if (days > 366) throw new AppError('VALIDATION_FAILED', 'The recalculation range is limited to 366 days.');
  if (to > today) throw new AppError('VALIDATION_FAILED', 'The range cannot extend beyond today.');

  const [pending] = await db
    .select({ n: sql<number>`count(*)` })
    .from(trackingBackfills)
    .where(and(eq(trackingBackfills.workspaceId, actor.workspaceId), eq(trackingBackfills.status, 'PENDING')));
  if ((pending?.n ?? 0) >= 3) {
    throw new AppError('VALIDATION_FAILED', 'Another recalculation for this workspace is still in progress.');
  }

  return withWorkspaceTransaction(actor.workspaceId, async (tx) => {
    const [row] = await tx
      .insert(trackingBackfills)
      .values({
        id: newId(),
        workspaceId: actor.workspaceId,
        fromDate: from,
        toDate: to,
        cursorDate: from,
        totalDays: days,
        status: 'PENDING',
        requestedBy: actor.userId,
        reason: input.reason,
      })
      .returning();
    if (!row) throw new AppError('INTERNAL_ERROR', 'The recalculation was not recorded.');
    await writeAudit(tx, {
      workspaceId: actor.workspaceId,
      actorId: actor.userId,
      action: 'tracking.correction_range',
      targetType: 'workspace',
      targetId: actor.workspaceId,
      metadata: { from, to, days },
      requestId: actor.requestId,
    });
    recordTrackingCorrection(actor.workspaceId, 'DATE_RANGE', 'SET');
    return { id: row.id, from: row.fromDate, to: row.toDate, totalDays: row.totalDays, status: row.status };
  });
}

export interface BackfillProgress {
  id: string;
  from: string;
  to: string;
  totalDays: number;
  processedDays: number;
  remainingDays: number;
  status: 'PENDING' | 'COMPLETED';
  createdAt: string;
  updatedAt: string;
}

/** Progress of the most recent recalculation request for this workspace. */
export async function getTrackingBackfillProgress(actor: TaskActor): Promise<BackfillProgress | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(trackingBackfills)
    .where(eq(trackingBackfills.workspaceId, actor.workspaceId))
    .orderBy(desc(trackingBackfills.createdAt), desc(trackingBackfills.id))
    .limit(1);
  if (!row) return null;
  const processed = row.status === 'COMPLETED' ? row.totalDays : Math.max(0, row.totalDays - (Math.round((dayMs(row.toDate) - dayMs(row.cursorDate)) / 86_400_000) + 1));
  return {
    id: row.id,
    from: row.fromDate,
    to: row.toDate,
    totalDays: row.totalDays,
    processedDays: processed,
    remainingDays: row.totalDays - processed,
    status: row.status as 'PENDING' | 'COMPLETED',
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
