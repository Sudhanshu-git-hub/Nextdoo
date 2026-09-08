import { createHash } from 'node:crypto';
import { and, asc, desc, eq, gte, inArray, isNull, lte } from 'drizzle-orm';
import { calculateScore, type ScoringInput } from '@nextdoo/core';
import { tasks, taskOccurrences, trackingEvents, trackingResults } from '@nextdoo/db';
import { getDb } from '../db';
import { newId } from '../ids';
import { logger } from '../observability';

/**
 * Tracking calculation pipeline (PRD §7.6).
 *
 * Results are content-addressed on (task, occurrence, version, inputHash) so
 * recomputing with unchanged inputs is a no-op. Prior results are superseded,
 * never mutated — the history stays auditable.
 */

export const CALCULATION_VERSION = 1;

function hashInputs(input: ScoringInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        c: input.completed,
        d: input.dueAt?.toISOString() ?? null,
        ca: input.completedAt?.toISOString() ?? null,
        e: input.estimateMinutes,
        a: input.actualMinutes,
        eo: input.expectedOccurrences,
        co: input.completedOccurrences,
        r: input.rescheduleCount,
        s: input.skipped,
      }),
    )
    .digest('hex')
    .slice(0, 64);
}

/** Assembles scoring inputs from the durable record. */
export async function buildScoringInput(workspaceId: string, taskId: string): Promise<ScoringInput | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, workspaceId)))
    .limit(1);
  const task = rows[0];
  if (!task) return null;

  let expected: number | null = null;
  let completed: number | null = null;
  if (task.recurrenceRuleId) {
    const occ = await db
      .select({ status: taskOccurrences.status })
      .from(taskOccurrences)
      .where(eq(taskOccurrences.recurrenceRuleId, task.recurrenceRuleId));
    if (occ.length) {
      expected = occ.filter((o) => o.status !== 'SKIPPED').length;
      completed = occ.filter((o) => o.status === 'COMPLETED').length;
    }
  }

  const skipped = await db
    .select({ id: trackingEvents.id })
    .from(trackingEvents)
    .where(and(eq(trackingEvents.taskId, taskId), eq(trackingEvents.type, 'TASK_SKIPPED')))
    .limit(1);

  return {
    completed: task.status === 'COMPLETED',
    dueAt: task.dueAt,
    completedAt: task.completedAt,
    estimateMinutes: task.estimateMinutes,
    actualMinutes: task.actualMinutes > 0 ? task.actualMinutes : null,
    expectedOccurrences: expected,
    completedOccurrences: completed,
    rescheduleCount: task.rescheduleCount,
    skipped: skipped.length > 0,
    evaluatedAt: new Date(),
  };
}

export interface StoredResult {
  id: string;
  taskId: string;
  score: number | null;
  outcome: string;
  components: unknown;
  explanation: string;
  measuredWeight: number;
  calculationVersion: number;
  recalculated: boolean;
  createdAt: string;
}

/**
 * Computes and persists an execution result.
 * Idempotent: identical inputs return the existing row untouched.
 */
export async function evaluateTask(
  workspaceId: string,
  taskId: string,
  options: { recalculated?: boolean } = {},
): Promise<StoredResult | null> {
  const input = await buildScoringInput(workspaceId, taskId);
  if (!input) return null;

  const result = calculateScore(input);
  const inputHash = hashInputs(input);
  const db = getDb();

  const existing = await db
    .select()
    .from(trackingResults)
    .where(
      and(
        eq(trackingResults.taskId, taskId),
        eq(trackingResults.calculationVersion, CALCULATION_VERSION),
        eq(trackingResults.inputHash, inputHash),
        isNull(trackingResults.supersededAt),
      ),
    )
    .limit(1);

  if (existing[0]) {
    const row = existing[0];
    return {
      id: row.id,
      taskId: row.taskId,
      score: row.score === null ? null : Number(row.score),
      outcome: row.outcome,
      components: row.components,
      explanation: row.explanation,
      measuredWeight: Number(row.measuredWeight),
      calculationVersion: row.calculationVersion,
      recalculated: row.recalculated,
      createdAt: row.createdAt.toISOString(),
    };
  }

  return db.transaction(async (tx) => {
    // Supersede prior results rather than deleting them.
    await tx
      .update(trackingResults)
      .set({ supersededAt: new Date() })
      .where(and(eq(trackingResults.taskId, taskId), isNull(trackingResults.supersededAt)));

    const [row] = await tx
      .insert(trackingResults)
      .values({
        id: newId(),
        workspaceId,
        taskId,
        occurrenceKey: null,
        score: result.score === null ? null : String(result.score),
        outcome: result.outcome,
        components: result.components,
        explanation: result.explanation,
        measuredWeight: String(result.measuredWeight),
        calculationVersion: CALCULATION_VERSION,
        inputHash,
        recalculated: options.recalculated ?? false,
      })
      .onConflictDoNothing()
      .returning();

    if (!row) return null;
    return {
      id: row.id,
      taskId: row.taskId,
      score: row.score === null ? null : Number(row.score),
      outcome: row.outcome,
      components: row.components,
      explanation: row.explanation,
      measuredWeight: Number(row.measuredWeight),
      calculationVersion: row.calculationVersion,
      recalculated: row.recalculated,
      createdAt: row.createdAt.toISOString(),
    };
  });
}

/**
 * Enqueues evaluation. Without Redis configured we evaluate inline but never let
 * a scoring failure surface to the user — the task mutation already committed.
 */
export async function scheduleTrackingEvaluation(workspaceId: string, taskId: string): Promise<void> {
  try {
    await evaluateTask(workspaceId, taskId);
  } catch (error) {
    logger.error('tracking.evaluate.failed', {
      workspaceId,
      taskId,
      error: error instanceof Error ? error.message : 'unknown',
    });
  }
}

export async function getResultForTask(workspaceId: string, taskId: string): Promise<StoredResult | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(trackingResults)
    .where(
      and(
        eq(trackingResults.workspaceId, workspaceId),
        eq(trackingResults.taskId, taskId),
        isNull(trackingResults.supersededAt),
      ),
    )
    .orderBy(desc(trackingResults.createdAt))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    taskId: row.taskId,
    score: row.score === null ? null : Number(row.score),
    outcome: row.outcome,
    components: row.components,
    explanation: row.explanation,
    measuredWeight: Number(row.measuredWeight),
    calculationVersion: row.calculationVersion,
    recalculated: row.recalculated,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface Summary {
  period: 'day' | 'week';
  from: string;
  to: string;
  plannedCount: number;
  completedCount: number;
  completionRate: number | null;
  onTimeCount: number;
  onTimeRate: number | null;
  lateCount: number;
  rescheduledCount: number;
  plannedMinutes: number;
  actualMinutes: number;
  averageScore: number | null;
  unmeasuredCount: number;
  estimateVariancePct: number | null;
  /** Plain-language findings shown in the review UI. */
  insights: string[];
}

/** Daily and weekly analytics (PRD §7.8). */
export async function getSummary(
  workspaceId: string,
  period: 'day' | 'week',
  reference: Date,
): Promise<Summary> {
  const db = getDb();
  const from = new Date(reference);
  from.setUTCHours(0, 0, 0, 0);
  if (period === 'week') from.setUTCDate(from.getUTCDate() - 6);
  const to = new Date(reference);
  to.setUTCHours(23, 59, 59, 999);

  const planned = await db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.workspaceId, workspaceId),
        isNull(tasks.deletedAt),
        gte(tasks.dueAt, from),
        lte(tasks.dueAt, to),
      ),
    );

  const completedTasks = planned.filter((t) => t.status === 'COMPLETED' && t.completedAt);
  const onTime = completedTasks.filter((t) => t.dueAt && t.completedAt && t.completedAt <= t.dueAt);
  const late = completedTasks.filter((t) => t.dueAt && t.completedAt && t.completedAt > t.dueAt);
  const rescheduled = planned.filter((t) => t.rescheduleCount > 0);

  const plannedMinutes = planned.reduce((s, t) => s + (t.estimateMinutes ?? 0), 0);
  const actualMinutes = planned.reduce((s, t) => s + t.actualMinutes, 0);

  /**
   * Scores must be scoped to the same task set as every other figure on this
   * page. Windowing results by their own `createdAt` produced the contradiction
   * of "0 tasks planned, average score 100" whenever a task due outside the
   * window happened to be scored inside it.
   */
  const plannedIds = planned.map((t) => t.id);
  const results = plannedIds.length
    ? await db
        .select({ score: trackingResults.score, outcome: trackingResults.outcome })
        .from(trackingResults)
        .where(
          and(
            eq(trackingResults.workspaceId, workspaceId),
            isNull(trackingResults.supersededAt),
            inArray(trackingResults.taskId, plannedIds),
          ),
        )
    : [];

  const scored = results.filter((r) => r.score !== null).map((r) => Number(r.score));
  const averageScore = scored.length
    ? Math.round((scored.reduce((a, b) => a + b, 0) / scored.length) * 10) / 10
    : null;

  const withBoth = planned.filter((t) => t.estimateMinutes && t.estimateMinutes > 0 && t.actualMinutes > 0);
  const estimateVariancePct = withBoth.length
    ? Math.round(
        (withBoth.reduce((s, t) => s + (t.actualMinutes - t.estimateMinutes!) / t.estimateMinutes!, 0) /
          withBoth.length) *
          100,
      )
    : null;

  // Rates are fractions in 0..1; formatting as a percentage is the caller's job.
  const rate = (numerator: number, denominator: number) =>
    denominator ? Math.round((numerator / denominator) * 1000) / 1000 : null;
  const completionRate = rate(completedTasks.length, planned.length);
  const onTimeRate = rate(onTime.length, completedTasks.length);

  // Descriptive, never judgemental (PRD §7.8).
  const insights: string[] = [];
  if (!planned.length) {
    insights.push('Nothing was scheduled in this period, so there is nothing to measure yet.');
  } else {
    if (completionRate !== null) {
      insights.push(`You completed ${completedTasks.length} of ${planned.length} scheduled task(s).`);
    }
    if (estimateVariancePct !== null && Math.abs(estimateVariancePct) >= 10) {
      const dir = estimateVariancePct > 0 ? 'longer' : 'shorter';
      insights.push(`Tracked work took about ${Math.abs(estimateVariancePct)}% ${dir} than estimated.`);
    }
    if (rescheduled.length > 0) {
      insights.push(`${rescheduled.length} task(s) moved date at least once — worth reviewing what blocked them.`);
    }
    if (!withBoth.length) {
      insights.push('Add estimates and track time to unlock estimate-accuracy feedback.');
    }
  }

  return {
    period,
    from: from.toISOString(),
    to: to.toISOString(),
    plannedCount: planned.length,
    completedCount: completedTasks.length,
    completionRate,
    onTimeCount: onTime.length,
    onTimeRate,
    lateCount: late.length,
    rescheduledCount: rescheduled.length,
    plannedMinutes,
    actualMinutes,
    averageScore,
    unmeasuredCount: results.filter((r) => r.outcome === 'UNMEASURED').length,
    estimateVariancePct,
    insights,
  };
}

export async function listTrackingEvents(workspaceId: string, taskId: string) {
  const db = getDb();
  return db
    .select({
      id: trackingEvents.id,
      type: trackingEvents.type,
      occurredAt: trackingEvents.occurredAt,
      payload: trackingEvents.payload,
    })
    .from(trackingEvents)
    .where(and(eq(trackingEvents.workspaceId, workspaceId), eq(trackingEvents.taskId, taskId)))
    .orderBy(asc(trackingEvents.occurredAt))
    .limit(200);
}
