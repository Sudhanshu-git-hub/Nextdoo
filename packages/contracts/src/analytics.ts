/**
 * One local day of the summary window (workspace time zone). `score` is the
 * mean of current stored results for tasks planned that day and is removed
 * from responses when numeric scores are disabled (PRD §7.2).
 */
export interface DayPoint {
  /** Local date key `YYYY-MM-DD` in the workspace time zone. */
  day: string;
  plannedCount: number;
  completedCount: number;
  completionRate: number | null;
  plannedMinutes: number;
  actualMinutes: number;
  /** All tracked focus time starting that local day (excluded tasks hidden). */
  focusMinutes: number;
  score: number | null;
  unmeasuredCount: number;
  /** Planned load above the workspace workday guideline (PRD §7.8). */
  overloaded: boolean;
  workdayMinutes: number | null;
}

/**
 * Recurring-task adherence (PRD §7.8), derived only from measured recurrence
 * components of current stored results (TR-06) — nothing is recomputed here.
 */
export interface RecurrenceAdherence {
  /** Recurring tasks in the window cohort. */
  recurringCount: number;
  /** Recurring tasks whose recurrence component was measurable. */
  measuredCount: number;
  /** Mean measured recurrence component; null when none is measurable. */
  adherencePct: number | null;
}

export interface RescheduledTask {
  taskId: string;
  title: string;
  count: number;
}

/** Tags whose tasks came in above estimate (PRD §7.8 "underestimated categories"). */
export interface TagVariance {
  tagId: string;
  name: string;
  taskCount: number;
  /** Mean (actual-estimate)/estimate, percent, positive = took longer. */
  variancePct: number;
}

export interface ExecutionSummary {
  freshness: TrackingSummaryFreshness;
  period: 'day' | 'week';
  /** Workspace IANA time zone the windows and day keys use. */
  timeZone: string;
  /** Workspace week-start weekday (0=Sunday..6=Saturday). */
  weekStart: number;
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
  storedResultCount: number;
  scoredCount: number;
  missingResultCount: number;
  actualMeasuredCount: number;
  estimateMeasuredCount: number;
  /** Mean lateness of late completions, minutes; null when none. */
  lateAverageMinutes: number | null;
  /** Per-day trend points across the window (PRD §7.8 weekly trends). */
  days: DayPoint[];
  recurrence: RecurrenceAdherence;
  /** Most rescheduled tasks in the window (max 5); empty when none. */
  mostRescheduled: RescheduledTask[];
  /** Underestimated tag categories (needs >=2 tasks, >=+10%); max 3. */
  tagVariances: TagVariance[];
  /** Plain-language findings shown in the review UI. */
  insights: string[];
  /** Tasks removed from this view by an EXCLUDED_FROM_ANALYTICS correction. */
  excludedCount?: number;
}

/** Immutable owner correction record (PRD §7.7). Latest row per (task, kind) wins. */
export interface TrackingCorrection {
  id: string;
  kind: string;
  /** Toggle kinds carry SET/CLEAR; null for due-date corrections. */
  state: 'SET' | 'CLEAR' | null;
  reason: string | null;
  /** New due instant for DUE_DATE_CORRECTED rows. */
  dueTo: string | null;
  createdAt: string;
}

/**
 * Project reports reuse the workspace-local due-date cohort of the summary.
 * Day scores are optional because scores-off responses strip the figure
 * entirely (PRD §7.2).
 */
export interface ProjectAnalytics extends Omit<ExecutionSummary, 'averageScore' | 'days'> {
  projectId: string;
  days: (Omit<DayPoint, 'score'> & { score?: number | null })[];
  cohort: 'current-project-due-date';
  scoresEnabled: boolean;
  averageScore?: number | null;
}

export interface TrackingFreshness {
 status: 'FRESH' | 'PENDING' | 'RETRYING' | 'FAILED';
 processing: boolean;
 revision: number;
 attempts: number;
 evaluatedAt: string | null;
 nextEvaluationAt: string | null;
 nextAttemptAt: string | null;
 errorCode: string | null;
 reference: string | null;
}
export interface TrackingSummaryFreshness {
 observedAt: string;
 freshCount: number;
 staleCount: number;
 pendingCount: number;
 retryingCount: number;
 failedCount: number;
}
