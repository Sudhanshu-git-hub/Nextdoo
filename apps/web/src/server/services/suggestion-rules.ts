/**
 * M8-i2 (PRD §5.5) — the five advisory suggestion rules. Pure and
 * deterministic: a fixed function of its typed inputs (no database, no clock,
 * no randomness, no model calls). All thresholds/rounding/caps for
 * RULE_VERSION 1 live here so the behaviour is documented in one place
 * (docs/M8_i2_ADVISORY_SUGGESTIONS_REVIEW.md §rule table).
 *
 * Advisory invariant: the output describes observations and offers at most
 * one explicit confirmation action (S1). Nothing in this module mutates
 * anything; the only plan change that can ever flow from a suggestion is a
 * user-confirmed estimate raise applied through the normal versioned task
 * PATCH (PRD §5.5: "They cannot automatically change user plans without
 * confirmation.").
 */
import { minuteTime } from '@nextdoo/core';
import { SUGGESTION_RULE_VERSION, type Suggestion, type SuggestionAction, type SuggestionTarget } from '@nextdoo/contracts';

/* RULE_VERSION 1 thresholds (deterministic, documented). */
const S1_MIN_VARIANCE_PCT = 10; // cohort must average ≥ +10% over estimate
const S1_MIN_COHORT_TASKS = 2; //  ≥ 2 measured tasks in the cohort (n≥2 convention)
const S1_CAP = 2;
const S2_CAP = 2; // most overloaded days
const S3_MIN_MEASURED = 3; // ≥ 3 measured occurrences in the window
const S3_MIN_LATE_MINUTES = 30; // median lateness ≥ 30 min
const S3_MAX_ADHERENCE_PCT = 80; // or adherence < 80%
const S3_CAP = 2;
const S4_MIN_SIZE_MINUTES = 240; // ≥ 4 h estimate or measured actual
const S4_CAP = 3;
const S5_MIN_RESCHEDES = 3; // rescheduleCount ≥ 3
const S5_CAP = 3;
// Review doc: ≤ 11 suggestions per read. Per-type caps sum to 12, so this
// explicit total deterministically trims the tail (lowest-priority S5 items)
// when every theme saturates — the same stable order is the tie-break.
const MAX_TOTAL = 11;
const MAX_MESSAGE_LENGTH = 200;

export interface SuggestionDayInput {
  /** Local date key (YYYY-MM-DD) in the workspace zone. */
  day: string;
  /** Display label, e.g. "Fri 15 Sep" — computed by the caller. */
  label: string;
  plannedMinutes: number;
  /** Workday guideline in minutes; null = workday unknown (rule cannot fire). */
  workdayMinutes: number | null;
}

export interface SuggestionTaskInput {
  id: string;
  title: string;
  estimateMinutes: number | null;
  /** Measured actual minutes; null = Unmeasured (never treated as a number). */
  actualMinutes: number | null;
  rescheduleCount: number;
  version: number;
  tagNames: string[];
  projectId: string | null;
  hasSubtasks: boolean;
}

export interface SuggestionCohortInput {
  /** `tag:<name>` or `project:<id>`. */
  key: string;
  kind: 'tag' | 'project';
  /** Display name (tag name or project name) — own data only. */
  label: string;
  /** Mean (actual − estimate) / estimate × 100 over measured tasks, 1 dp. */
  variancePct: number;
  /** Measured tasks with both estimate and actual. */
  taskCount: number;
}

export interface SuggestionRecurrenceInput {
  ruleId: string;
  title: string;
  measuredOccurrences: number;
  /** Median of positive lateness (completedAt − dueAt) minutes; null when unmeasured. */
  medianLateMinutes: number | null;
  /** On-time share of measured occurrences, 0–100; null when unmeasured. */
  adherencePct: number | null;
  /** Local minutes-of-day of the next occurrence due after now; null = none. */
  nextDueMinutesOfDay: number | null;
}

export interface SuggestionInputs {
  overloadWarningsEnabled: boolean;
  days: SuggestionDayInput[];
  tasks: SuggestionTaskInput[];
  cohorts: SuggestionCohortInput[];
  recurrences: SuggestionRecurrenceInput[];
}

const round5 = (n: number) => Math.round(n / 5) * 5;
const round15 = (n: number) => Math.round(n / 15) * 15;

/** Deterministic truncation to ≤ 200 chars on a word boundary. */
function clampMessage(message: string): string {
  if (message.length <= MAX_MESSAGE_LENGTH) return message;
  const cut = message.slice(0, MAX_MESSAGE_LENGTH - 1);
  const boundary = cut.lastIndexOf(' ');
  const base = (boundary > 120 ? cut.slice(0, boundary) : cut).replace(/[\s,.;:]+$/, '');
  return `${base}…`;
}

function make(type: Suggestion['type'], id: string, message: string, target: SuggestionTarget, action: SuggestionAction, evidence: Record<string, number>): Suggestion {
  return { id: `${type}:${id}`, type, ruleVersion: SUGGESTION_RULE_VERSION, message: clampMessage(message), target, action, evidence };
}

/** Stable total ordering (ties break on label then id) — no input-order dependence. */
function order<T>(items: T[], rank: (item: T) => number, label: (item: T) => string, key: (item: T) => string): T[] {
  return [...items].sort((a, b) => rank(b) - rank(a) || label(a).localeCompare(label(b)) || key(a).localeCompare(key(b)));
}

/** S1 — larger estimates for similar tasks (tag cohort, else project cohort). */
function estimateSuggestions(tasks: SuggestionTaskInput[], cohorts: SuggestionCohortInput[]): Suggestion[] {
  const strong = cohorts.filter((c) => c.taskCount >= S1_MIN_COHORT_TASKS && c.variancePct >= S1_MIN_VARIANCE_PCT);
  const candidates: Array<{ task: SuggestionTaskInput; cohort: SuggestionCohortInput; suggested: number; estimate: number }> = [];
  for (const task of tasks) {
    if (task.estimateMinutes === null || task.estimateMinutes <= 0) continue;
    const estimate = task.estimateMinutes; // narrowed to a positive number here
    const matches = strong.filter((c) =>
      c.kind === 'tag' ? task.tagNames.includes(c.label) : task.projectId !== null && c.key === `project:${task.projectId}`,
    );
    if (!matches.length) continue;
    const cohort = order(matches, (m) => m.variancePct, (m) => m.label, (m) => m.key)[0]!;
    const suggested = round5(estimate * (1 + cohort.variancePct / 100));
    if (suggested <= estimate) continue; // rounding must not be a no-op
    candidates.push({ task, cohort, suggested, estimate });
  }
  return order(candidates, (c) => c.suggested - c.estimate, (c) => c.task.title, (c) => c.task.id)
    .slice(0, S1_CAP)
    .map(({ task, cohort, suggested, estimate }) =>
      make(
        'S1_ESTIMATE',
        task.id,
        `Raise "${task.title}" from ${estimate} to about ${suggested} min — work named "${cohort.label}" has come in about ${cohort.variancePct}% over estimate lately (${cohort.taskCount} task(s)).`,
        { kind: 'task', taskId: task.id, label: task.title },
        { kind: 'raise_estimate', taskId: task.id, suggestedMinutes: suggested, taskVersion: task.version },
        { estimateMinutes: estimate, variancePct: cohort.variancePct, taskCount: cohort.taskCount },
      ),
    );
}

/** S2 — less work on overloaded days. View-only: the action is navigation, never a move. */
function overloadSuggestions(days: SuggestionDayInput[], enabled: boolean): Suggestion[] {
  if (!enabled) return [];
  const overloaded = days
    .filter((d) => d.workdayMinutes !== null && d.plannedMinutes > d.workdayMinutes)
    .map((d) => ({ day: d, overBy: d.plannedMinutes - d.workdayMinutes! }));
  return order(overloaded, (d) => d.overBy, (d) => d.day.label, (d) => d.day.day)
    .slice(0, S2_CAP)
    .map(({ day, overBy }) =>
      make(
        'S2_OVERLOAD',
        day.day,
        `You've planned ${day.plannedMinutes} min for ${day.label} — about ${overBy} min above your ${day.workdayMinutes} min guideline. Consider moving or splitting some of it.`,
        { kind: 'day', dayKey: day.day, label: day.label },
        { kind: 'open_day', dayKey: day.day },
        { plannedMinutes: day.plannedMinutes, workdayMinutes: day.workdayMinutes!, overByMinutes: overBy },
      ),
    );
}

/** S3 — earlier planning for recurring work. */
function recurrenceSuggestions(series: SuggestionRecurrenceInput[]): Suggestion[] {
  const triggers = series.filter(
    (r) =>
      r.measuredOccurrences >= S3_MIN_MEASURED &&
      ((r.medianLateMinutes !== null && r.medianLateMinutes >= S3_MIN_LATE_MINUTES) ||
        (r.adherencePct !== null && r.adherencePct < S3_MAX_ADHERENCE_PCT)),
  );
  return order(triggers, (r) => r.medianLateMinutes ?? -1, (r) => r.title, (r) => r.ruleId)
    .slice(0, S3_CAP)
    .map((r) => {
      const evidence: Record<string, number> = { measuredOccurrences: r.measuredOccurrences };
      if (r.medianLateMinutes !== null) evidence.medianLateMinutes = r.medianLateMinutes;
      if (r.adherencePct !== null) evidence.adherencePct = r.adherencePct;
      let message: string;
      if (
        r.medianLateMinutes !== null &&
        r.medianLateMinutes >= S3_MIN_LATE_MINUTES &&
        r.nextDueMinutesOfDay !== null
      ) {
        const shift = round15(r.medianLateMinutes);
        const earlier = r.nextDueMinutesOfDay - shift;
        if (shift > 0 && earlier >= 0) {
          message = `Your "${r.title}" is usually done about ${r.medianLateMinutes} min late — consider planning it for ${minuteTime(earlier)} instead of ${minuteTime(r.nextDueMinutesOfDay)}.`;
        } else {
          message = `Your "${r.title}" is usually done about ${r.medianLateMinutes} min late — consider planning it earlier in the day.`;
        }
      } else if (r.medianLateMinutes !== null && r.medianLateMinutes >= S3_MIN_LATE_MINUTES) {
        message = `Your "${r.title}" is usually done about ${r.medianLateMinutes} min late — consider planning it earlier in the day.`;
      } else {
        message = `Your "${r.title}" is done on time only about ${r.adherencePct}% of the time — consider planning it earlier.`;
      }
      return make('S3_RECURRING', r.ruleId, message, { kind: 'recurrence', recurrenceRuleId: r.ruleId, label: r.title }, { kind: 'open_recurrence', recurrenceRuleId: r.ruleId }, evidence);
    });
}

/** S4 — breaking large tasks into subtasks. */
function splitSuggestions(tasks: SuggestionTaskInput[]): Suggestion[] {
  const candidates = tasks
    .filter((t) => !t.hasSubtasks && ((t.estimateMinutes !== null && t.estimateMinutes >= S4_MIN_SIZE_MINUTES) || (t.actualMinutes !== null && t.actualMinutes >= S4_MIN_SIZE_MINUTES)))
    .map((t) => ({ task: t, size: Math.max(t.estimateMinutes ?? 0, t.actualMinutes ?? 0) }));
  return order(candidates, (c) => c.size, (c) => c.task.title, (c) => c.task.id)
    .slice(0, S4_CAP)
    .map(({ task, size }) =>
      make(
        'S4_SPLIT',
        task.id,
        `"${task.title}" is a big task (${size} min). Breaking it into subtasks makes progress easier to track.`,
        { kind: 'task', taskId: task.id, label: task.title },
        { kind: 'open_task', taskId: task.id },
        { sizeMinutes: size },
      ),
    );
}

/** S5 — reviewing frequently rescheduled tasks. */
function reviewSuggestions(tasks: SuggestionTaskInput[]): Suggestion[] {
  return order(
    tasks.filter((t) => t.rescheduleCount >= S5_MIN_RESCHEDES),
    (t) => t.rescheduleCount,
    (t) => t.title,
    (t) => t.id,
  )
    .slice(0, S5_CAP)
    .map((t) =>
      make(
        'S5_REVIEW',
        t.id,
        `"${t.title}" has been rescheduled ${t.rescheduleCount} times — reviewing its due date or scope may help.`,
        { kind: 'task', taskId: t.id, label: t.title },
        { kind: 'open_task', taskId: t.id },
        { rescheduleCount: t.rescheduleCount },
      ),
    );
}

/** Builds the advisory set for one workspace + window. Deterministic in inputs. */
export function buildSuggestions(inputs: SuggestionInputs): Suggestion[] {
  const out: Suggestion[] = [
    ...estimateSuggestions(inputs.tasks, inputs.cohorts),
    ...overloadSuggestions(inputs.days, inputs.overloadWarningsEnabled),
    ...recurrenceSuggestions(inputs.recurrences),
    ...splitSuggestions(inputs.tasks),
    ...reviewSuggestions(inputs.tasks),
  ];
  return out.slice(0, MAX_TOTAL);
}

export const SUGGESTION_RULE_LIMITS = {
  S1: { minVariancePct: S1_MIN_VARIANCE_PCT, minCohortTasks: S1_MIN_COHORT_TASKS, cap: S1_CAP },
  S2: { cap: S2_CAP },
  S3: { minMeasured: S3_MIN_MEASURED, minLateMinutes: S3_MIN_LATE_MINUTES, maxAdherencePct: S3_MAX_ADHERENCE_PCT, cap: S3_CAP },
  S4: { minSizeMinutes: S4_MIN_SIZE_MINUTES, cap: S4_CAP },
  S5: { minReschedules: S5_MIN_RESCHEDES, cap: S5_CAP },
  maxTotal: MAX_TOTAL,
  maxMessageLength: MAX_MESSAGE_LENGTH,
  ruleVersion: SUGGESTION_RULE_VERSION,
} as const;
