/**
 * PRD §7.9 Wellbeing Controls — per-user display preferences.
 *
 * The six independently-disableable §7.9 settings (numeric scores, streaks,
 * celebrations, sounds, comparative metrics, overload warnings) stored as
 * per-user `user_preferences` rows (same pattern as the M8-i2
 * overload-warning key). Preferences only change what is shown to the user —
 * they never change tracked data, score calculation, or task plans.
 *
 * Defaults (see docs/M8_i3_WELLBEING_CONTROLS_REVIEW.md §6):
 *   - PRD-specified: streaks ON (disableStreaks=false, §7.9 "streaks on"),
 *     celebrations OFF (disableCelebrations=true, §7.9 "celebrations off"),
 *     comparisons absent in MVP (disableComparativeMetrics=true, §7.9 + PD-04),
 *     scores shown (disableScores=false — TR-07 is an opt-out, PD-03).
 *   - Implementation decisions (PRD states no default): sounds enabled
 *     (disableSounds=false) per the "independently disable" framing; overload
 *     warnings shown (disableOverloadWarnings=false, established in M8-i2).
 */
import { z } from 'zod';

export const WELLBEING_PREFERENCE_KEYS = [
  'disableScores',
  'disableStreaks',
  'disableCelebrations',
  'disableSounds',
  'disableComparativeMetrics',
  'disableOverloadWarnings',
] as const;
export type WellbeingPreferenceKey = (typeof WELLBEING_PREFERENCE_KEYS)[number];

export interface WellbeingPreferences {
  /** §7.9 "numeric scores": hide score figures (TR-07). Default false (shown). */
  disableScores: boolean;
  /** §7.9 "streaks" (default on). Forward gate: no streak feature exists in MVP. */
  disableStreaks: boolean;
  /** §7.9 "celebrations" (default off). Forward gate: no celebration surface in MVP. */
  disableCelebrations: boolean;
  /** §7.9 "sounds". Forward gate: no audio system in MVP. Implementation default: enabled. */
  disableSounds: boolean;
  /**
   * §7.9 "comparative metrics" (comparisons absent in MVP per §7.9/PD-04).
   * Guard for future cross-user/team comparison surfaces only — the user's own
   * trend reporting (§7.8) is never affected by this key.
   */
  disableComparativeMetrics: boolean;
  /** §7.9 "overload warnings": Today banner + S2 suggestions (M8-i2). Default false (shown). */
  disableOverloadWarnings: boolean;
}

/** PRD-derived defaults applied when a user has no stored row for a key. */
export const WELLBEING_PREFERENCE_DEFAULTS: WellbeingPreferences = {
  disableScores: false,
  disableStreaks: false,
  disableCelebrations: true,
  disableSounds: false,
  disableComparativeMetrics: true,
  disableOverloadWarnings: false,
};

/** Strict PATCH body: only the keys being changed, booleans only, non-empty. */
export const wellbeingPreferencesPatchSchema = z
  .object({
    disableScores: z.boolean().optional(),
    disableStreaks: z.boolean().optional(),
    disableCelebrations: z.boolean().optional(),
    disableSounds: z.boolean().optional(),
    disableComparativeMetrics: z.boolean().optional(),
    disableOverloadWarnings: z.boolean().optional(),
  })
  .strict()
  .refine((v) => WELLBEING_PREFERENCE_KEYS.some((k) => v[k] !== undefined), {
    message: 'Provide at least one preference to change.',
  });

export type WellbeingPreferencesPatch = z.infer<typeof wellbeingPreferencesPatchSchema>;
