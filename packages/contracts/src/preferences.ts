/**
 * PRD §7.9 Wellbeing Controls — per-user display preferences.
 *
 * MVP surface: the §7.9 "overload warnings" independent toggle (M8-i2),
 * stored as a per-user `user_preferences` row (same pattern as the
 * server-side `disableScores` reader). Preferences only change what is
 * shown to the user — they never change tracked data or task plans.
 */
import { z } from 'zod';

export const WELLBEING_PREFERENCE_KEYS = ['disableOverloadWarnings'] as const;
export type WellbeingPreferenceKey = (typeof WELLBEING_PREFERENCE_KEYS)[number];

export interface WellbeingPreferences {
  /** §7.9: hide overload warnings (Today banner + S2 suggestions). Default false. */
  disableOverloadWarnings: boolean;
}

/** Strict PATCH body: only the keys being changed, booleans only. */
export const wellbeingPreferencesPatchSchema = z
  .object({
    disableOverloadWarnings: z.boolean().optional(),
  })
  .strict()
  .refine((v) => WELLBEING_PREFERENCE_KEYS.some((k) => v[k] !== undefined), {
    message: 'Provide at least one preference to change.',
  });

export type WellbeingPreferencesPatch = z.infer<typeof wellbeingPreferencesPatchSchema>;
