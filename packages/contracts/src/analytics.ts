export interface ExecutionSummary {
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
  storedResultCount: number;
  scoredCount: number;
  missingResultCount: number;
  actualMeasuredCount: number;
  estimateMeasuredCount: number;
  /** Plain-language findings shown in the review UI. */
  insights: string[];
}

/** Project reports preserve the existing current-task / UTC due-date cohort. */
export interface ProjectAnalytics extends Omit<ExecutionSummary, 'averageScore'> {
  projectId: string;
  timeZone: 'UTC';
  cohort: 'current-project-due-date';
  scoresEnabled: boolean;
  averageScore?: number | null;
}
