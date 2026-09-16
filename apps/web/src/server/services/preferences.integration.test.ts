import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';

/**
 * PRD §7.9 Wellbeing Controls integration tests — the per-user display
 * preferences endpoint's service layer, against a real database.
 *
 * Proves: defaults are "everything shown" (false), toggles persist
 * independently as `user_preferences` rows (same pattern as the
 * server-side `disableScores` reader), changes are owner-scoped, and
 * every real change writes an audit record naming the fields it touched.
 */

await (await import('../../../../../tests/database')).requireTestDatabase();

const { getDb } = await import('../db');
const { hashPassword } = await import('../auth');
const { registerUser } = await import('./accounts');
const { getWellbeingPreferences, setWellbeingPreferences } = await import('./preferences');

const db = getDb();
const { auditLogs, userPreferences } = await import('@nextdoo/db');

const PASSWORD = 'preferences-test-password-1';

async function newAccount() {
  return registerUser({
    email: `prefs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`,
    passwordHash: await hashPassword(PASSWORD),
    name: 'Preferences Test',
    timeZone: 'UTC',
  });
}

async function auditRows(userId: string, action: string) {
  const rows = await db.select().from(auditLogs).where(eq(auditLogs.action, action));
  return rows.filter((r) => r.actorId === userId);
}

describe('preferences service (§7.9)', () => {
  it('defaults to everything shown (false) and persists the overload toggle', async () => {
    const account = await newAccount();
    expect(await getWellbeingPreferences(account.id)).toEqual({ disableOverloadWarnings: false });

    const after = await setWellbeingPreferences(account.id, { disableOverloadWarnings: true });
    expect(after).toEqual({ disableOverloadWarnings: true });

    const rows = await db
      .select()
      .from(userPreferences)
      .where(and(eq(userPreferences.userId, account.id), eq(userPreferences.key, 'disableOverloadWarnings')));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toBe(true);

    // Toggling back to false is a real state change, not a row delete.
    const off = await setWellbeingPreferences(account.id, { disableOverloadWarnings: false });
    expect(off).toEqual({ disableOverloadWarnings: false });
    const afterOff = await db
      .select()
      .from(userPreferences)
      .where(and(eq(userPreferences.userId, account.id), eq(userPreferences.key, 'disableOverloadWarnings')));
    expect(afterOff).toHaveLength(1);
    expect(afterOff[0]!.value).toBe(false);
  });

  it('writes one audit record naming the preference fields it changed, and none for a no-op', async () => {
    const account = await newAccount();
    const noop = await setWellbeingPreferences(account.id, {});
    expect(noop).toEqual({ disableOverloadWarnings: false });
    expect(await auditRows(account.id, 'account.preferences_updated')).toHaveLength(0);
    expect(await db.select().from(userPreferences).where(eq(userPreferences.userId, account.id))).toHaveLength(0);

    await setWellbeingPreferences(account.id, { disableOverloadWarnings: true });
    const rows = await auditRows(account.id, 'account.preferences_updated');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata).toMatchObject({ fields: ['preferences.disableOverloadWarnings'] });
  });

  it('is owner-scoped: a second user sees and keeps their own defaults', async () => {
    const a = await newAccount();
    const b = await newAccount();
    await setWellbeingPreferences(a.id, { disableOverloadWarnings: true });

    expect(await getWellbeingPreferences(b.id)).toEqual({ disableOverloadWarnings: false });

    // B's write cannot touch A's row (and vice versa).
    await setWellbeingPreferences(b.id, { disableOverloadWarnings: false });
    expect(await getWellbeingPreferences(a.id)).toEqual({ disableOverloadWarnings: true });
    expect(await getWellbeingPreferences(b.id)).toEqual({ disableOverloadWarnings: false });
  });
});
