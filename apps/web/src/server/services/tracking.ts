import { and, asc, desc, eq, gte, gt, inArray, isNull, lte, not, sql } from 'drizzle-orm';
import { tasks, timerSessions, tags, taskTags, trackingEvents, trackingResults, workspaces, buildScoringInput as buildInput, evaluateTrackingInTransaction, type StoredResult } from '@nextdoo/db';
import { localDateKey, localDayBounds, localParts, workdayMinutes, workspaceWeek, zonedTimeToUtc, type ComponentResult } from '@nextdoo/core';
import { getDb, withTransaction } from '../db';
import { readTrackingFreshness } from './tracking-freshness';
import { logger } from '../observability';
import { recordUnmeasuredResult } from '../metrics';
import { withWorkspaceTransaction } from './transactions';
import { AppError, type DayPoint, type RecurrenceAdherence, type RescheduledTask, type TagVariance } from '@nextdoo/contracts';
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
    const result = await evaluateTrackingInTransaction(tx as unknown as typeof db, workspaceId, taskId, { now: new Date(settings!.now), streamBudgetMs: 500 });
    await tx.execute(sql`select set_config('statement_timeout',${settings!.timeout},true)`);
    // M4 "unmeasured result rate": counted once, where the result committed.
    if (result) recordUnmeasuredResult(workspaceId, result.score === null || result.measuredWeight < 1);
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

/**
 * Workspace-local day/week analytics (PRD §7.8). `dateKey` is a local
 * calendar date (`YYYY-MM-DD`) in the workspace time zone, or null for "now".
 * Window bounds and every day key are computed in the workspace zone, so a
 * report always matches the workspace's own calendar (PRD §6.2).
 */
export function getSummary(workspaceId: string, period: 'day' | 'week', dateKey: string | null, projectId?: string): Promise<Summary> {
 return withTransaction(() => readSummary(workspaceId, period, dateKey, projectId), { isolationLevel: 'repeatable read', accessMode: 'read only' });
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Daily and weekly analytics (PRD §7.8). */
async function readSummary(
  workspaceId: string,
  period: 'day' | 'week',
  dateKey: string | null,
  projectId?: string,
): Promise<Summary> {
  const db = getDb();
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  if (!ws) {
    throw new AppError('NOT_FOUND', 'This workspace does not exist.', { resource: { type: 'workspace', id: workspaceId } });
  }
  const { timeZone, weekStart } = ws;
  const workday = workdayMinutes(ws.workdayStartMinute, ws.workdayEndMinute);
  const workdayMinutesPerDay = workday > 0 ? workday : null;

  // A requested day is local noon in the workspace zone, so the key always
  // round-trips to the requested date. Impossible calendar dates (Feb 30)
  // roll over and are rejected instead of silently shifting the window.
  const reference = dateKey === null
    ? new Date()
    : (() => {
        // The schema guarantees exactly `YYYY-MM-DD`; defaults only satisfy the type system.
        const [y = 1, m = 1, d = 1] = dateKey.split('-').map(Number);
        const ref = zonedTimeToUtc(y, m, d, 12, 0, timeZone);
        const parts = localParts(ref, timeZone);
        if (parts.year !== y || parts.month !== m || parts.day !== d) {
          throw new AppError('VALIDATION_FAILED', `That date does not exist in ${timeZone}.`, { fieldErrors: [{ path: 'date', message: 'That date does not exist.' }] });
        }
        return ref;
      })();

  const dayBounds = localDayBounds(reference, timeZone);
  const weekDays = period === 'week' ? workspaceWeek(reference, timeZone, weekStart).days : null;
  const from = weekDays ? weekDays[0]! : dayBounds.start;
  const to = dayBounds.end;
  // One entry per local day in the window: the reference day alone, or the
  // week-start through the reference day (a partial current week is honest).
  const dayEntries: Array<{ key: string; instant: Date }> = period === 'week'
    ? workspaceWeek(reference, timeZone, weekStart).days
        .map((instant) => ({ key: localDateKey(instant, timeZone), instant }))
        .filter((entry) => entry.instant.getTime() <= to.getTime())
    : [{ key: localDateKey(reference, timeZone), instant: dayBounds.start }];
  const dayLabel = (key: string) => {
    const [y = 1, m = 1, d = 1] = key.split('-').map(Number);
    return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone }).format(zonedTimeToUtc(y, m, d, 12, 0, timeZone));
  };
  const formatDuration = (minutes: number) => {
    const h = Math.floor(minutes / 60);
    const m = Math.round(minutes - h * 60);
    return h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
  };

  // PRD §7.7: a task's latest EXCLUDED_FROM_ANALYTICS correction removes it
  // from analytics (this summary), never from the task itself or its results.
  const excludedFromAnalytics = sql`exists (
    select 1 from tracking_corrections tc
    where tc.task_id=${tasks.id} and tc.workspace_id=${workspaceId} and tc.kind='EXCLUDED_FROM_ANALYTICS' and tc.payload->>'state'='SET'
      and not exists (select 1 from tracking_corrections tc2
        where tc2.task_id=tc.task_id and tc2.workspace_id=tc.workspace_id and tc2.kind=tc.kind
          and (tc2.created_at,tc2.id)>(tc.created_at,tc.id)))`;
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
        not(excludedFromAnalytics),
      ),
    );
  const [excludedRow] = await db
    .select({ n: sql<number>`count(*)` })
    .from(tasks)
    .where(
      and(
        eq(tasks.workspaceId, workspaceId),
        ...(projectId ? [eq(tasks.projectId, projectId)] : []),
        isNull(tasks.deletedAt),
        sql`${tasks.status}<>'DELETED'`,
        gte(tasks.dueAt, from),
        lte(tasks.dueAt, to),
        excludedFromAnalytics,
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
        .select({ taskId: trackingResults.taskId, score: trackingResults.score, outcome: trackingResults.outcome, components: trackingResults.components })
        .from(trackingResults)
        .where(
          and(
            eq(trackingResults.workspaceId, workspaceId),
            isNull(trackingResults.supersededAt),
            inArray(trackingResults.taskId, plannedIds),
          ),
        )
    : [];
  const byTask = new Map(results.map((r) => [r.taskId, r]));

  // Focus trend (PRD §7.8): all tracked focus time starting inside the window,
  // bucketed by the local day it started on. Excluded tasks stay hidden here
  // too, so the focus figures pair with the same cohort as every other number.
  const excludedSession = sql`exists (
    select 1 from tracking_corrections tc
    where tc.task_id=${timerSessions.taskId} and tc.workspace_id=${workspaceId} and tc.kind='EXCLUDED_FROM_ANALYTICS' and tc.payload->>'state'='SET'
      and not exists (select 1 from tracking_corrections tc2
        where tc2.task_id=tc.task_id and tc2.workspace_id=tc.workspace_id and tc2.kind=tc.kind
          and (tc2.created_at,tc2.id)>(tc.created_at,tc.id)))`;
  const focusRows = await db
    .select({
      startedAt: timerSessions.startedAt,
      seconds: sql<number>`${timerSessions.accumulatedSeconds} + ${timerSessions.manualAdjustmentSeconds}`,
    })
    .from(timerSessions)
    .where(
      and(
        eq(timerSessions.workspaceId, workspaceId),
        gte(timerSessions.startedAt, from),
        lte(timerSessions.startedAt, to),
        not(excludedSession),
      ),
    );
  const focusByDay = new Map<string, number>();
  for (const row of focusRows) {
    const key = localDateKey(row.startedAt, timeZone);
    focusByDay.set(key, (focusByDay.get(key) ?? 0) + Number(row.seconds));
  }

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
  const lateAverageMinutes = late.length
    ? Math.round(late.reduce((s, t) => s + (t.completedAt!.getTime() - t.dueAt!.getTime()), 0) / late.length / 60000)
    : null;

  // Per-day trend points (PRD §7.8). Every figure is computed from the same
  // task cohort and the same current stored results as the window totals.
  const days: DayPoint[] = dayEntries.map(({ key }) => {
    const dayTasks = planned.filter((t) => localDateKey(t.dueAt!, timeZone) === key);
    const dayCompleted = dayTasks.filter((t) => t.status === 'COMPLETED' && t.completedAt);
    const dayResults = dayTasks.map((t) => byTask.get(t.id)).filter((r): r is (typeof results)[number] => Boolean(r));
    const dayScored = dayResults.filter((r) => r.score !== null).map((r) => Number(r.score));
    const dayPlannedMinutes = dayTasks.reduce((s, t) => s + (t.estimateMinutes ?? 0), 0);
    return {
      day: key,
      plannedCount: dayTasks.length,
      completedCount: dayCompleted.length,
      completionRate: rate(dayCompleted.length, dayTasks.length),
      plannedMinutes: dayPlannedMinutes,
      actualMinutes: dayTasks.reduce((s, t) => s + t.actualMinutes * 60 + t.actualSecondsRemainder, 0) / 60,
      focusMinutes: round1((focusByDay.get(key) ?? 0) / 60),
      score: dayScored.length ? round1(dayScored.reduce((a, b) => a + b, 0) / dayScored.length) : null,
      unmeasuredCount: dayResults.filter((r) => r.outcome === 'UNMEASURED').length,
      overloaded: workdayMinutesPerDay !== null && dayPlannedMinutes > workdayMinutesPerDay,
      workdayMinutes: workdayMinutesPerDay,
    };
  });

  // Recurrence adherence reads the stored recurrence components only (TR-06);
  // nothing is recomputed, and unmeasured components never count as zero.
  const recurring = planned.filter((t) => t.recurrenceRuleId !== null);
  const measuredRecurrence = recurring
    .map((t) => byTask.get(t.id))
    .filter((r): r is (typeof results)[number] => Boolean(r))
    .map((r) => (Array.isArray(r.components) ? (r.components as ComponentResult[]).find((c) => c.key === 'recurrence' && c.measured) : undefined))
    .filter((c): c is ComponentResult => Boolean(c && c.value !== null))
    .map((c) => Number(c.value));
  const recurrence: RecurrenceAdherence = {
    recurringCount: recurring.length,
    measuredCount: measuredRecurrence.length,
    adherencePct: measuredRecurrence.length ? round1(measuredRecurrence.reduce((a, b) => a + b, 0) / measuredRecurrence.length) : null,
  };

  const mostRescheduled: RescheduledTask[] = planned
    .filter((t) => t.rescheduleCount > 0)
    .sort((a, b) => b.rescheduleCount - a.rescheduleCount || a.title.localeCompare(b.title))
    .slice(0, 5)
    .map((t) => ({ taskId: t.id, title: t.title, count: t.rescheduleCount }));

  // Underestimated categories (PRD §7.8): tags whose measured tasks came in
  // above estimate. A tag needs >=2 measured tasks to be a signal, and only
  // the longest-overrun categories are reported.
  const withBothIds = withBoth.map((t) => t.id);
  const tagRows = withBothIds.length
    ? await db
        .select({ tagId: tags.id, name: tags.name, taskId: taskTags.taskId })
        .from(taskTags)
        .innerJoin(tags, eq(tags.id, taskTags.tagId))
        .where(inArray(taskTags.taskId, withBothIds))
    : [];
  const varianceByTag = new Map<string, { name: string; sum: number; n: number }>();
  for (const t of withBoth) {
    for (const row of tagRows) {
      if (row.taskId !== t.id) continue;
      const acc = varianceByTag.get(row.tagId) ?? { name: row.name, sum: 0, n: 0 };
      acc.sum += (actual(t) - t.estimateMinutes!) / t.estimateMinutes!;
      acc.n += 1;
      varianceByTag.set(row.tagId, acc);
    }
  }
  const tagVariances: TagVariance[] = [...varianceByTag.entries()]
    .filter(([, v]) => v.n >= 2 && (v.sum / v.n) * 100 >= 10)
    .sort((a, b) => b[1].sum / b[1].n - a[1].sum / a[1].n)
    .slice(0, 3)
    .map(([tagId, v]) => ({ tagId, name: v.name, taskCount: v.n, variancePct: Math.round((v.sum / v.n) * 100) }));

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
    for (const tag of tagVariances.slice(0, 2)) {
      insights.push(`Tasks tagged '${tag.name}' took about ${tag.variancePct}% longer than estimated (${tag.taskCount} task(s)).`);
    }
    if (rescheduled.length > 0) {
      insights.push(`${rescheduled.length} task(s) moved date at least once — worth reviewing what blocked them.`);
      if (mostRescheduled[0]) {
        insights.push(`Most rescheduled: "${mostRescheduled[0].title}" (moved ${mostRescheduled[0].count} times).`);
      }
    }
    for (const day of days.filter((d) => d.overloaded).slice(0, 2)) {
      insights.push(`${dayLabel(day.day)} was planned at ${day.plannedMinutes} min — above your ${day.workdayMinutes} min workday.`);
    }
    if (period === 'week') {
      const measuredDays = days.filter((d) => d.plannedCount > 0 && d.completionRate !== null);
      if (measuredDays.length >= 2) {
        const min = measuredDays.reduce((best, d) => (d.completionRate! < best.completionRate! ? d : best));
        const max = measuredDays.reduce((best, d) => (d.completionRate! > best.completionRate! ? d : best));
        const pct = (d: DayPoint) => `${Math.round(d.completionRate! * 100)}%`;
        if (max.completionRate! - min.completionRate! <= 0.2) {
          insights.push(`Completion was steady this week (${pct(min)}–${pct(max)} of planned tasks finished on each scheduled day).`);
        } else {
          insights.push(`Completion varied from ${pct(min)} (${dayLabel(min.day)}) to ${pct(max)} (${dayLabel(max.day)}).`);
        }
      }
      const totalFocus = days.reduce((s, d) => s + d.focusMinutes, 0);
      if (totalFocus > 0) {
        insights.push(`You tracked about ${formatDuration(totalFocus)} of focus time in this window.`);
      }
    }
    if (recurrence.measuredCount > 0 && recurrence.adherencePct !== null) {
      insights.push(`Recurring task adherence was ${recurrence.adherencePct}% across ${recurrence.measuredCount} recurring task(s).`);
    }
    if (!withBoth.length) {
      insights.push('Add estimates and track time to unlock estimate-accuracy feedback.');
    }
  }

  return {
    period,
    freshness,
    timeZone,
    weekStart,
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
    lateAverageMinutes,
    days,
    recurrence,
    mostRescheduled,
    tagVariances,
    insights,
    excludedCount: excludedRow ? Number(excludedRow.n) : 0,
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
