/**
 * M8-i2 (PRD §5.5/§8.5) — advisory suggestions service.
 *
 * Strictly read-only and workspace-scoped: it reuses the existing analytics
 * summary (same cohort, same corrections-filtered math) plus a few plain
 * SELECTs over the user's own data. It writes nothing, collects nothing new,
 * and never returns another workspace's data. Suggestion generation is a
 * deterministic function of the current state (pure rules module).
 */
import { and, eq, gte, inArray, isNull, lte, not, sql } from 'drizzle-orm';
import {
  projects,
  recurrenceRules,
  tags,
  taskTags,
  tasks,
  trackingResults,
  userPreferences,
} from '@nextdoo/db';
import { SUGGESTION_RULE_VERSION, type SuggestionsResponse } from '@nextdoo/contracts';
import { localParts, zonedTimeToUtc, type ComponentResult } from '@nextdoo/core';
import { getDb } from '../db';
import { getSummary } from './tracking';
import {
  buildSuggestions,
  type SuggestionCohortInput,
  type SuggestionDayInput,
  type SuggestionInputs,
  type SuggestionRecurrenceInput,
  type SuggestionTaskInput,
} from './suggestion-rules';

export interface SuggestionQuery {
  period: 'day' | 'week';
  /** `YYYY-MM-DD` local date for the window; null = the current day/week. */
  dateKey: string | null;
}

interface CohortTask {
  id: string;
  title: string;
  status: string;
  estimateMinutes: number | null;
  actualMinutes: number;
  actualSecondsRemainder: number;
  rescheduleCount: number;
  version: number;
  dueAt: Date | null;
  completedAt: Date | null;
  recurrenceRuleId: string | null;
  projectId: string | null;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : round1((s[m - 1]! + s[m]!) / 2);
};

/** PRD §7.7: a task's latest EXCLUDED_FROM_ANALYTICS correction hides it from analytics. */
const excludedFromAnalytics = sql`exists (
  select 1 from tracking_corrections tc
  where tc.task_id=${tasks.id} and tc.workspace_id=${tasks.workspaceId} and tc.kind='EXCLUDED_FROM_ANALYTICS' and tc.payload->>'state'='SET'
    and not exists (select 1 from tracking_corrections tc2
      where tc2.task_id=tc.task_id and tc2.workspace_id=tc.workspace_id and tc2.kind=tc.kind
        and (tc2.created_at,tc2.id)>(tc.created_at,tc.id)))`;

const actual = (t: CohortTask) => t.actualMinutes + t.actualSecondsRemainder / 60;

/**
 * Builds the advisory suggestion set for one workspace window.
 * Read-only: every statement here is a SELECT.
 */
export async function listSuggestions(
  actor: { userId: string; workspaceId: string },
  query: SuggestionQuery,
): Promise<SuggestionsResponse> {
  const db = getDb();
  // The summary carries the window, the workday and the per-day planned load
  // for the exact cohort the analytics page shows (corrections-filtered).
  const summary = await getSummary(actor.workspaceId, query.period, query.dateKey);
  const { timeZone } = summary;
  const from = new Date(summary.from);
  const to = new Date(summary.to);

  const [pref] = await db
    .select({ value: userPreferences.value })
    .from(userPreferences)
    .where(and(eq(userPreferences.userId, actor.userId), eq(userPreferences.key, 'disableOverloadWarnings')))
    .limit(1);
  const overloadWarningsEnabled = pref?.value !== true;

  // The full window cohort (all statuses), corrections-filtered — the same
  // population the summary measures, so S1/S3 cohorts pair with the page.
  const cohort = (
    await db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.workspaceId, actor.workspaceId),
          isNull(tasks.deletedAt),
          sql`${tasks.status}<>'DELETED'`,
          gte(tasks.dueAt, from),
          lte(tasks.dueAt, to),
          not(excludedFromAnalytics),
        ),
      )
  ) as unknown as CohortTask[];

  const dayInputs: SuggestionDayInput[] = summary.days.map((d) => {
    const [y = 1, m = 1, day = 1] = d.day.split('-').map(Number);
    const instant = zonedTimeToUtc(y, m, day, 12, 0, timeZone);
    return {
      day: d.day,
      label: new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone }).format(instant),
      plannedMinutes: d.plannedMinutes,
      workdayMinutes: d.workdayMinutes,
    };
  });

  // Measured cohorts (tags + projects) for S1 — the n≥2 convention, mean
  // signed variance; the rules module applies the ≥+10% trigger.
  const withBoth = cohort.filter((t) => t.estimateMinutes !== null && t.estimateMinutes > 0 && actual(t) > 0);
  const tagRows = withBoth.length
    ? await db
        .select({ tagId: tags.id, name: tags.name, taskId: taskTags.taskId })
        .from(taskTags)
        .innerJoin(tags, eq(tags.id, taskTags.tagId))
        .where(and(inArray(taskTags.taskId, withBoth.map((t) => t.id)), eq(tags.workspaceId, actor.workspaceId)))
    : [];
  const tagAgg = new Map<string, { name: string; sum: number; n: number }>();
  for (const t of withBoth) {
    for (const row of tagRows) {
      if (row.taskId !== t.id) continue;
      const acc = tagAgg.get(row.tagId) ?? { name: row.name, sum: 0, n: 0 };
      acc.sum += (actual(t) - t.estimateMinutes!) / t.estimateMinutes!;
      acc.n += 1;
      tagAgg.set(row.tagId, acc);
    }
  }
  const cohorts: SuggestionCohortInput[] = [...tagAgg.entries()]
    .filter(([, v]) => v.n >= 2)
    .map(([, v]) => ({ key: `tag:${v.name}`, kind: 'tag' as const, label: v.name, variancePct: round1((v.sum / v.n) * 100), taskCount: v.n }));
  const projectAgg = new Map<string, { sum: number; n: number }>();
  for (const t of withBoth) {
    if (t.projectId === null) continue;
    const acc = projectAgg.get(t.projectId) ?? { sum: 0, n: 0 };
    acc.sum += (actual(t) - t.estimateMinutes!) / t.estimateMinutes!;
    acc.n += 1;
    projectAgg.set(t.projectId, acc);
  }
  if (projectAgg.size) {
    const projectRows = await db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(and(eq(projects.workspaceId, actor.workspaceId), inArray(projects.id, [...projectAgg.keys()])));
    for (const p of projectRows) {
      const agg = projectAgg.get(p.id)!;
      if (agg.n >= 2) cohorts.push({ key: `project:${p.id}`, kind: 'project', label: p.name, variancePct: round1((agg.sum / agg.n) * 100), taskCount: agg.n });
    }
  }

  // S3 series: measured recurrence components (TR-06) + completion lateness,
  // grouped per rule; plus the next future occurrence time per rule.
  const recurring = cohort.filter((t) => t.recurrenceRuleId !== null);
  const recurrenceInputs: SuggestionRecurrenceInput[] = [];
  if (recurring.length) {
    const recurringIds = recurring.map((t) => t.id);
    const resultRows = await db
      .select({ id: trackingResults.id, taskId: trackingResults.taskId, components: trackingResults.components, createdAt: trackingResults.createdAt })
      .from(trackingResults)
      .where(and(eq(trackingResults.workspaceId, actor.workspaceId), isNull(trackingResults.supersededAt), inArray(trackingResults.taskId, recurringIds)));
    const rowsByTask = new Map<string, typeof resultRows>();
    for (const row of resultRows) rowsByTask.set(row.taskId, [...(rowsByTask.get(row.taskId) ?? []), row]);
    /**
     * A task can carry several ACTIVE result rows (e.g. a completion row plus
     * a backfilled occurrence row). Prefer the first (earliest) row whose
     * recurrence component is measured — deterministic for identical state.
     */
    const recurrenceComponent = (taskId: string): ComponentResult | undefined => {
      const rows = rowsByTask.get(taskId);
      if (!rows) return undefined;
      const ordered = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
      for (const row of ordered) {
        const comp = Array.isArray(row.components)
          ? (row.components as ComponentResult[]).find((c) => c.key === 'recurrence' && c.measured && c.value !== null)
          : undefined;
        if (comp) return comp;
      }
      return undefined;
    };
    const byRule = new Map<string, CohortTask[]>();
    for (const t of recurring) byRule.set(t.recurrenceRuleId!, [...(byRule.get(t.recurrenceRuleId!) ?? []), t]);
    const ruleRows = await db
      .select({ id: recurrenceRules.id, templateSnapshot: recurrenceRules.templateSnapshot })
      .from(recurrenceRules)
      .where(and(eq(recurrenceRules.workspaceId, actor.workspaceId), inArray(recurrenceRules.id, [...byRule.keys()])));
    const ruleTitle = new Map(
      ruleRows.map((r) => [r.id, (r.templateSnapshot as { title?: string } | null)?.title ?? 'Recurring task']),
    );
    const now = new Date();
    for (const [ruleId, occ] of [...byRule.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const values: number[] = [];
      const lateness: number[] = [];
      for (const t of occ) {
        const comp = recurrenceComponent(t.id);
        if (!comp || comp.value === null) continue;
        values.push(Number(comp.value));
        if (t.status === 'COMPLETED' && t.completedAt && t.dueAt) {
          lateness.push(Math.max(0, (t.completedAt.getTime() - t.dueAt.getTime()) / 60000));
        }
      }
      let nextDueMinutesOfDay: number | null = null;
      const futures = occ.filter((t) => t.dueAt !== null && t.dueAt.getTime() > now.getTime());
      if (futures.length) {
        const next = futures.reduce((min, t) => (t.dueAt!.getTime() < min.dueAt!.getTime() ? t : min), futures[0]!);
        const p = localParts(next.dueAt!, timeZone);
        nextDueMinutesOfDay = p.hour * 60 + p.minute;
      }
      recurrenceInputs.push({
        ruleId,
        title: ruleTitle.get(ruleId) ?? 'Recurring task',
        measuredOccurrences: values.length,
        medianLateMinutes: median(lateness),
        adherencePct: values.length ? round1((values.reduce((a, b) => a + b, 0) / values.length) * 100) : null,
        nextDueMinutesOfDay,
      });
    }
  }

  // Active window tasks for S1/S4/S5 candidates (+ tags and subtask flags).
  const active = cohort.filter((t) => t.status === 'ACTIVE');
  const activeIds = active.map((t) => t.id);
  const activeTagRows = activeIds.length
    ? await db
        .select({ taskId: taskTags.taskId, name: tags.name })
        .from(taskTags)
        .innerJoin(tags, eq(tags.id, taskTags.tagId))
        .where(and(inArray(taskTags.taskId, activeIds), eq(tags.workspaceId, actor.workspaceId)))
    : [];
  const tagsByTask = new Map<string, string[]>();
  for (const row of activeTagRows) tagsByTask.set(row.taskId, [...(tagsByTask.get(row.taskId) ?? []), row.name]);
  const childCounts = new Map<string, number>();
  if (activeIds.length) {
    const children = await db
      .select({ parentId: tasks.parentTaskId })
      .from(tasks)
      .where(and(eq(tasks.workspaceId, actor.workspaceId), isNull(tasks.deletedAt), inArray(tasks.parentTaskId, activeIds)));
    for (const c of children) childCounts.set(c.parentId!, (childCounts.get(c.parentId!) ?? 0) + 1);
  }
  const taskInputs: SuggestionTaskInput[] = active.map((t) => ({
    id: t.id,
    title: t.title,
    estimateMinutes: t.estimateMinutes,
    actualMinutes: actual(t) > 0 ? Math.round(actual(t) * 10) / 10 : null,
    rescheduleCount: t.rescheduleCount,
    version: t.version,
    tagNames: [...(tagsByTask.get(t.id) ?? [])].sort(),
    projectId: t.projectId,
    hasSubtasks: (childCounts.get(t.id) ?? 0) > 0,
  }));

  const inputs: SuggestionInputs = {
    overloadWarningsEnabled,
    days: dayInputs,
    tasks: taskInputs,
    cohorts,
    recurrences: recurrenceInputs,
  };
  return { suggestions: buildSuggestions(inputs), ruleVersion: SUGGESTION_RULE_VERSION };
}

/** §7.9: the user's overload-warning toggle (same pattern as `disableScores`). */
export async function readOverloadWarningsEnabled(userId: string): Promise<boolean> {
  const db = getDb();
  const [pref] = await db
    .select({ value: userPreferences.value })
    .from(userPreferences)
    .where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, 'disableOverloadWarnings')))
    .limit(1);
  return pref?.value !== true;
}
