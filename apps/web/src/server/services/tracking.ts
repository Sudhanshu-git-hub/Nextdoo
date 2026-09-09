import { and, asc, desc, eq, gte, gt, inArray, isNull, lte, sql } from 'drizzle-orm';
import { tasks, trackingEvents, trackingResults, buildScoringInput as buildInput, evaluateTrackingInTransaction, type StoredResult } from '@nextdoo/db';
import { getDb, withTransaction } from '../db';
import { readTrackingFreshness } from './tracking-freshness';
import { logger } from '../observability';
import { withWorkspaceTransaction } from './transactions';
export { CALCULATION_VERSION, type StoredResult } from '@nextdoo/db';
export function buildScoringInput(workspaceId: string, taskId: string) { return buildInput(getDb(), workspaceId, taskId); }
export function evaluateTask(workspaceId: string, taskId: string, options: { recalculated?: boolean } = {}) {
 return withWorkspaceTransaction(workspaceId, (db) => evaluateTrackingInTransaction(db, workspaceId, taskId, options));
}
/** Best-effort immediate feedback. A real savepoint isolates calculation failure;
 * the task, append-only events and durable invalidation still commit together.
 */
export async function scheduleTrackingEvaluation(workspaceId: string, taskId: string): Promise<void> {
 await withWorkspaceTransaction(workspaceId, async (db) => {
  try { await db.transaction(async (tx) => {
    const [settings] = await tx.execute<{ timeout: string; now: string }>(sql`select current_setting('statement_timeout') as timeout,
      to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as now`);
    await tx.execute(sql`select set_config('statement_timeout','500ms',true)`);
    await evaluateTrackingInTransaction(tx as unknown as typeof db, workspaceId, taskId, { now: new Date(settings!.now), streamBudgetMs: 500 });
    await tx.execute(sql`select set_config('statement_timeout',${settings!.timeout},true)`);
  }); }
  catch { logger.warn('tracking.fast_path_deferred', { workspaceId, taskId }); }
 });
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

export type Summary = import('@nextdoo/contracts').ExecutionSummary;

export function getSummary(workspaceId: string, period: 'day' | 'week', reference: Date, projectId?: string): Promise<Summary> {
 return withTransaction(() => readSummary(workspaceId, period, reference, projectId), { isolationLevel: 'repeatable read', accessMode: 'read only' });
}

/** Daily and weekly analytics (PRD §7.8). */
async function readSummary(
  workspaceId: string,
  period: 'day' | 'week',
  reference: Date,
  projectId?: string,
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
        ...(projectId ? [eq(tasks.projectId, projectId)] : []),
        isNull(tasks.deletedAt),
        sql`${tasks.status}<>'DELETED'`,
        gte(tasks.dueAt, from),
        lte(tasks.dueAt, to),
      ),
    );

  const completedTasks = planned.filter((t) => t.status === 'COMPLETED' && t.completedAt);
  const onTime = completedTasks.filter((t) => t.dueAt && t.completedAt && t.completedAt <= t.dueAt);
  const late = completedTasks.filter((t) => t.dueAt && t.completedAt && t.completedAt > t.dueAt);
  const rescheduled = planned.filter((t) => t.rescheduleCount > 0);

  const plannedMinutes = planned.reduce((s, t) => s + (t.estimateMinutes ?? 0), 0);
  // Timers preserve sub-minute remainders; analytics must not round them away.
  const actual = (t: typeof tasks.$inferSelect) => t.actualMinutes + t.actualSecondsRemainder / 60;
  const actualMinutes = planned.reduce((s, t) => s + t.actualMinutes * 60 + t.actualSecondsRemainder, 0) / 60;

  /**
   * Scores must be scoped to the same task set as every other figure on this
   * page. Windowing results by their own `createdAt` produced the contradiction
   * of "0 tasks planned, average score 100" whenever a task due outside the
   * window happened to be scored inside it.
   */
  const plannedIds = planned.map((t) => t.id);
  const states = [...(await readTrackingFreshness(workspaceId,plannedIds)).values()];
  const freshCount = states.filter((state)=>state.status==='FRESH').length;
  const freshness = { observedAt:new Date().toISOString(),freshCount,staleCount:planned.length-freshCount,
   pendingCount:states.filter((state)=>state.status==='PENDING').length,retryingCount:states.filter((state)=>state.status==='RETRYING').length,
   failedCount:states.filter((state)=>state.status==='FAILED').length };
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

  const withBoth = planned.filter((t) => t.estimateMinutes && t.estimateMinutes > 0 && actual(t) > 0);
  const estimateVariancePct = withBoth.length
    ? Math.round(
        (withBoth.reduce((s, t) => s + (actual(t) - t.estimateMinutes!) / t.estimateMinutes!, 0) /
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
    freshness,
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
    storedResultCount: results.length,
    scoredCount: scored.length,
    missingResultCount: planned.length - results.length,
    actualMeasuredCount: planned.filter((t) => actual(t) > 0).length,
    estimateMeasuredCount: withBoth.length,
    insights,
  };
}

export async function listTrackingEvents(workspaceId: string, taskId: string, after = 0, limit = 200) {
  const db = getDb();
  return db
    .select({
      id: trackingEvents.id,
      sequence: trackingEvents.sequence,
      type: trackingEvents.type,
      occurredAt: trackingEvents.occurredAt,
      payload: trackingEvents.payload,
    })
    .from(trackingEvents)
    .where(and(eq(trackingEvents.workspaceId, workspaceId), eq(trackingEvents.taskId, taskId), gt(trackingEvents.sequence, after)))
    .orderBy(asc(trackingEvents.sequence))
    .limit(limit);
}
