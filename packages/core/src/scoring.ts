import type { ExecutionOutcome } from '@nextdoo/contracts';

/**
 * Execution scoring (PRD §7.4).
 *
 * Two rules drive the whole design:
 *  1. A component with insufficient data is UNMEASURED and is *excluded* from the
 *     weighted average — never defaulted to zero, which would silently punish users.
 *  2. Every result is explainable: we return the inputs and a plain-language reason
 *     for each component so the UI can show its work (PRD §7.4 "Show source events").
 */

export const DEFAULT_WEIGHTS = {
  completion: 0.4,
  timing: 0.25,
  estimateAccuracy: 0.2,
  recurrence: 0.15,
} as const;

export type ComponentKey = keyof typeof DEFAULT_WEIGHTS;
export type Weights = Record<ComponentKey, number>;

/** Points deducted per hour late before the timing component bottoms out at 0. */
export const DEFAULT_LATENESS_PENALTY_PER_HOUR = 4;

/** Completing this many minutes or more before due counts as EARLY. */
export const DEFAULT_EARLY_THRESHOLD_MINUTES = 60;

export interface ScoringInput {
  completed: boolean;
  /** Planned due instant. Null means the task was never scheduled — timing is unmeasurable. */
  dueAt: Date | null;
  completedAt: Date | null;
  estimateMinutes: number | null;
  actualMinutes: number | null;
  /** Recurrence adherence; both null for non-recurring tasks. */
  expectedOccurrences: number | null;
  completedOccurrences: number | null;
  rescheduleCount: number;
  skipped: boolean;
  /** Review cutoff used to decide INCOMPLETE vs still-open. Defaults to now. */
  evaluatedAt?: Date;
}

export interface ComponentResult {
  key: ComponentKey;
  /** Null when UNMEASURED. */
  value: number | null;
  weight: number;
  measured: boolean;
  reason: string;
}

export interface ScoreResult {
  /** Null when no component could be measured at all. */
  score: number | null;
  outcome: ExecutionOutcome;
  components: ComponentResult[];
  /** Sum of weights that actually contributed, for transparency. */
  measuredWeight: number;
  explanation: string;
}

export interface ScoringOptions {
  weights?: Partial<Weights>;
  latenessPenaltyPerHour?: number;
  earlyThresholdMinutes?: number;
}

const clamp = (n: number, min = 0, max = 100) => Math.min(max, Math.max(min, n));
const round1 = (n: number) => Math.round(n * 10) / 10;
/** Weights need finer precision than scores: 0.40 + 0.25 must stay 0.65, not round to 0.7. */
const round2 = (n: number) => Math.round(n * 100) / 100;

export function determineOutcome(input: ScoringInput, earlyThresholdMinutes: number): ExecutionOutcome {
  if (input.skipped) return 'SKIPPED';

  if (input.completed && input.completedAt) {
    if (!input.dueAt) return 'UNMEASURED';
    const deltaMs = input.dueAt.getTime() - input.completedAt.getTime();
    const deltaMin = deltaMs / 60_000;
    if (deltaMin >= earlyThresholdMinutes) return 'EARLY';
    if (deltaMin >= 0) return 'ON_TIME';
    return 'LATE';
  }

  // Not completed: rescheduling is the more informative signal when it happened.
  if (input.rescheduleCount > 0) return 'RESCHEDULED';

  const cutoff = input.evaluatedAt ?? new Date();
  if (input.dueAt && input.dueAt.getTime() < cutoff.getTime()) return 'INCOMPLETE';

  return 'UNMEASURED';
}

function completionComponent(input: ScoringInput, weight: number): ComponentResult {
  if (input.skipped) {
    return {
      key: 'completion',
      value: null,
      weight,
      measured: false,
      reason: 'Occurrence was intentionally skipped, so completion is not scored.',
    };
  }
  const cutoff = input.evaluatedAt ?? new Date();
  const dueHasPassed = input.dueAt !== null && input.dueAt.getTime() < cutoff.getTime();

  if (!input.completed && !dueHasPassed) {
    return {
      key: 'completion',
      value: null,
      weight,
      measured: false,
      reason: 'Task is still open and not yet due.',
    };
  }
  return {
    key: 'completion',
    value: input.completed ? 100 : 0,
    weight,
    measured: true,
    reason: input.completed ? 'Task was completed.' : 'Task was not completed by its due date.',
  };
}

function timingComponent(input: ScoringInput, weight: number, penaltyPerHour: number): ComponentResult {
  if (!input.dueAt) {
    return { key: 'timing', value: null, weight, measured: false, reason: 'No due date was set, so timing cannot be measured.' };
  }
  if (!input.completed || !input.completedAt) {
    return { key: 'timing', value: null, weight, measured: false, reason: 'Task has not been completed, so timing is not yet measurable.' };
  }
  const hoursLate = (input.completedAt.getTime() - input.dueAt.getTime()) / 3_600_000;
  if (hoursLate <= 0) {
    return { key: 'timing', value: 100, weight, measured: true, reason: 'Completed at or before the planned time.' };
  }
  const value = clamp(100 - hoursLate * penaltyPerHour);
  return {
    key: 'timing',
    value: round1(value),
    weight,
    measured: true,
    reason: `Completed ${round1(hoursLate)} hour(s) after the planned time.`,
  };
}

function estimateComponent(input: ScoringInput, weight: number): ComponentResult {
  if (input.estimateMinutes === null || input.estimateMinutes <= 0) {
    return { key: 'estimateAccuracy', value: null, weight, measured: false, reason: 'No estimate was recorded, so accuracy is unmeasured.' };
  }
  if (input.actualMinutes === null || input.actualMinutes <= 0) {
    return { key: 'estimateAccuracy', value: null, weight, measured: false, reason: 'No tracked time, so estimate accuracy is unmeasured.' };
  }
  const variance = Math.abs(input.actualMinutes - input.estimateMinutes) / input.estimateMinutes;
  const value = clamp(100 - Math.min(100, variance * 100));
  const pct = Math.round(variance * 100);
  const direction = input.actualMinutes > input.estimateMinutes ? 'longer than' : 'shorter than';
  return {
    key: 'estimateAccuracy',
    value: round1(value),
    weight,
    measured: true,
    reason: pct === 0 ? 'Actual time matched the estimate.' : `Took ${pct}% ${direction} estimated.`,
  };
}

function recurrenceComponent(input: ScoringInput, weight: number): ComponentResult {
  const { expectedOccurrences: expected, completedOccurrences: done } = input;
  if (expected === null || done === null || expected <= 0) {
    return { key: 'recurrence', value: null, weight, measured: false, reason: 'Not a recurring task, so adherence is unmeasured.' };
  }
  const value = clamp((done / expected) * 100);
  return {
    key: 'recurrence',
    value: round1(value),
    weight,
    measured: true,
    reason: `Completed ${done} of ${expected} scheduled occurrence(s).`,
  };
}

export function calculateScore(input: ScoringInput, options: ScoringOptions = {}): ScoreResult {
  const weights: Weights = { ...DEFAULT_WEIGHTS, ...options.weights };
  const penalty = options.latenessPenaltyPerHour ?? DEFAULT_LATENESS_PENALTY_PER_HOUR;
  const earlyThreshold = options.earlyThresholdMinutes ?? DEFAULT_EARLY_THRESHOLD_MINUTES;

  const components: ComponentResult[] = [
    completionComponent(input, weights.completion),
    timingComponent(input, weights.timing, penalty),
    estimateComponent(input, weights.estimateAccuracy),
    recurrenceComponent(input, weights.recurrence),
  ];

  const measured = components.filter((c) => c.measured && c.value !== null);
  const measuredWeight = measured.reduce((sum, c) => sum + c.weight, 0);

  // Normalise over available components only (PRD §7.4).
  const score =
    measuredWeight > 0
      ? round1(measured.reduce((sum, c) => sum + (c.value as number) * c.weight, 0) / measuredWeight)
      : null;

  const outcome = determineOutcome(input, earlyThreshold);
  const excluded = components.filter((c) => !c.measured).map((c) => c.key);

  const explanation =
    score === null
      ? 'Not enough information to score this task yet.'
      : `Scored ${score} from ${measured.map((c) => c.key).join(', ')}.` +
        (excluded.length ? ` Excluded: ${excluded.join(', ')}.` : '');

  return { score, outcome, components, measuredWeight: round2(measuredWeight), explanation };
}
