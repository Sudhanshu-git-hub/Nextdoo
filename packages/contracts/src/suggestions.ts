/**
 * M8-i2 (PRD §5.5/§8.3/§8.5): advisory "improve" suggestions.
 *
 * Deterministic, heuristic-only: the current provider is a closed rule set
 * (RULE_VERSION) over the user's own analytics data. The PRD names the
 * endpoint `POST /v1/ai/suggestions`; per §6.10's deterministic-first design
 * the heuristic is the default provider and any model-backed variant (deferred
 * per §17 and standing directive) would later be a fallback behind this
 * contract. Suggestions are advisory: they never mutate plans except through
 * an explicit per-suggestion user confirmation (S1 only).
 */

/** Bumped whenever any rule trigger, threshold, rounding or cap changes. */
export const SUGGESTION_RULE_VERSION = 1;

export const SUGGESTION_TYPE = [
  /** §5.5 "larger estimates for similar tasks". */
  'S1_ESTIMATE',
  /** §5.5 "less work on overloaded days". View-only: never moves tasks (§8.3). */
  'S2_OVERLOAD',
  /** §5.5 "earlier planning for recurring work". */
  'S3_RECURRING',
  /** §5.5 "breaking large tasks into subtasks". */
  'S4_SPLIT',
  /** §5.5 "reviewing frequently rescheduled tasks". */
  'S5_REVIEW',
] as const;
export type SuggestionType = (typeof SUGGESTION_TYPE)[number];

/** What a suggestion points at. Exactly one id-like field is set per kind. */
export interface SuggestionTarget {
  kind: 'task' | 'day' | 'recurrence';
  taskId?: string;
  dayKey?: string;
  recurrenceRuleId?: string;
  /** Display name (own data only): task title, day label, series title. */
  label: string;
}

/**
 * The at-most-one interaction a suggestion offers. `raise_estimate` is the
 * only action capable of mutating a plan, and only after the user explicitly
 * confirms it on that suggestion (PRD §5.5). `open_*` actions navigate or
 * open the existing planning/review surface; they never mutate.
 */
export type SuggestionAction =
  | { kind: 'raise_estimate'; taskId: string; suggestedMinutes: number; taskVersion: number }
  | { kind: 'open_task'; taskId: string }
  | { kind: 'open_day'; dayKey: string }
  | { kind: 'open_recurrence'; recurrenceRuleId: string };

export interface Suggestion {
  /** Deterministic stable key: `${type}:${target id or dayKey}`. */
  id: string;
  type: SuggestionType;
  ruleVersion: number;
  /** Plain-language, non-punitive, ≤ 200 characters (PRD §7.8). */
  message: string;
  target: SuggestionTarget;
  action: SuggestionAction;
  /** Deterministic evidence values for the trigger (own data only). */
  evidence: Record<string, number>;
}

export interface SuggestionsResponse {
  suggestions: Suggestion[];
  ruleVersion: number;
}
