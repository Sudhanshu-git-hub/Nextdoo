/**
 * PRD §7.9 Wellbeing Controls — per-user display preferences service.
 *
 * Same pattern as the existing server-side `disableScores` reader
 * (per-user `user_preferences` key/value rows): reads default to false
 * (everything shown) and writes are explicit upserts. Preferences only
 * change what is shown to the user — they never touch tracked data or
 * task plans, and no other user's rows are ever read or written.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { WELLBEING_PREFERENCE_KEYS, type WellbeingPreferenceKey, type WellbeingPreferences } from '@nextdoo/contracts';
import { userPreferences } from '@nextdoo/db';
import { getDb } from '../db';
import { writeAuditLog } from './events';

export async function getWellbeingPreferences(userId: string): Promise<WellbeingPreferences> {
  const db = getDb();
  const rows = await db
    .select({ key: userPreferences.key, value: userPreferences.value })
    .from(userPreferences)
    .where(and(eq(userPreferences.userId, userId), inArray(userPreferences.key, [...WELLBEING_PREFERENCE_KEYS])));
  const prefs: WellbeingPreferences = { disableOverloadWarnings: false };
  for (const row of rows) {
    if (row.key in prefs) prefs[row.key as WellbeingPreferenceKey] = row.value === true;
  }
  return prefs;
}

/**
 * Persists the given toggles (only the provided keys change) and writes one
 * audit record naming the changed fields. Returns the full new state.
 */
export async function setWellbeingPreferences(
  userId: string,
  patch: Partial<WellbeingPreferences>,
): Promise<WellbeingPreferences> {
  const db = getDb();
  const changed: WellbeingPreferenceKey[] = [];
  for (const key of WELLBEING_PREFERENCE_KEYS) {
    const value = patch[key];
    if (value === undefined) continue;
    await db
      .insert(userPreferences)
      .values({ userId, key, value })
      .onConflictDoUpdate({ target: [userPreferences.userId, userPreferences.key], set: { value } });
    changed.push(key);
  }
  if (changed.length) {
    await writeAuditLog({
      userId,
      action: 'account.preferences_updated',
      entityType: 'user',
      entityId: userId,
      metadata: { fields: changed.map((key) => `preferences.${key}`) },
    });
  }
  return getWellbeingPreferences(userId);
}
