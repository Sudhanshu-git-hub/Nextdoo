import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { PERSONALIZATION_DEFAULTS, personalizationPatchSchema, WELLBEING_PREFERENCE_DEFAULTS } from '@nextdoo/contracts';
import { projects, userPreferences } from '@nextdoo/db';
await (await import('../../../../../tests/database')).requireTestDatabase();
const { registerUser } = await import('./accounts');
const { getDb } = await import('../db');
const { getPersonalization, setPersonalization } = await import('./personalization');
const { getWellbeingPreferences } = await import('./preferences');
const { createProject } = await import('./projects');
const { settingsCenterStatus } = await import('./settings-center');
async function actor() {
  const u = await registerUser({ email: `pc7-${randomUUID()}@test.local`, passwordHash: 'test', name: null, timeZone: 'UTC' });
  return { userId: u.id, workspaceId: u.workspaceId };
}
describe('PC7 account personalization', () => {
  it('computes defaults without writing rows', async () => {
    const a = await actor();
    expect(await getPersonalization(a)).toEqual(PERSONALIZATION_DEFAULTS);
    expect(await getDb().select().from(userPreferences).where(eq(userPreferences.userId, a.userId))).toHaveLength(0);
  });
  it('partial updates retain earlier choices and leave wellbeing untouched', async () => {
    const a = await actor();
    await setPersonalization(a, { theme: 'light', highContrast: true });
    expect(await setPersonalization(a, { calendarView: 'month' })).toEqual({ ...PERSONALIZATION_DEFAULTS, theme: 'light', highContrast: true, calendarView: 'month' });
    expect(await getWellbeingPreferences(a.userId)).toEqual(WELLBEING_PREFERENCE_DEFAULTS);
    expect(await getPersonalization(await actor())).toEqual(PERSONALIZATION_DEFAULTS);
  });
  it.each([{}, { theme: 'pink' }, { highContrast: 'true' }, { reminderMinutes: -1 }, { reminderMinutes: 43201 }, { reminderMinutes: 1.5 }, { startPage: 'https://evil.test' }, { reminderChannel: 'EMAIL' }, { userId: randomUUID() }, { defaultTaskList: 'bad' }])('rejects invalid or unowned fields: %j', patch => {
    expect(personalizationPatchSchema.safeParse(patch).success).toBe(false);
  });
  it('rejects another workspace and foreign project without partial writes', async () => {
    const a = await actor(), b = await actor();
    const p = await createProject(b, { name: 'Foreign project' });
    await expect(getPersonalization({ ...a, workspaceId: b.workspaceId })).rejects.toThrow();
    await expect(setPersonalization(a, { theme: 'dark', defaultTaskList: p.id })).rejects.toThrow();
    expect(await getPersonalization(a)).toEqual(PERSONALIZATION_DEFAULTS);
    await expect(settingsCenterStatus({ ...a, workspaceId: b.workspaceId })).rejects.toThrow();
  });
  it('uses only active owned projects, falls back when archived, and permits clearing', async () => {
    const a = await actor(), p = await createProject(a, { name: 'Capture list' });
    expect((await setPersonalization(a, { defaultTaskList: p.id })).defaultTaskList).toBe(p.id);
    await getDb().update(projects).set({ status: 'ARCHIVED' }).where(eq(projects.id, p.id));
    expect((await getPersonalization(a)).defaultTaskList).toBeNull();
    await expect(setPersonalization(a, { defaultTaskList: p.id })).rejects.toThrow();
    expect((await setPersonalization(a, { defaultTaskList: null })).defaultTaskList).toBeNull();
  });
  it('recovers invalid stored values without losing valid preferences', async () => {
    const a = await actor();
    await getDb().insert(userPreferences).values([{ userId: a.userId, key: 'personal.theme', value: 'invalid' }, { userId: a.userId, key: 'personal.accent', value: 'green' }]);
    expect(await getPersonalization(a)).toEqual({ ...PERSONALIZATION_DEFAULTS, accent: 'green' });
  });
  it('returns authoritative usage and plan state without provider credentials', async () => {
    const status = await settingsCenterStatus(await actor());
    expect(status.storageBytes).toBe(0);
    expect(status.checkout).toEqual({ stripe: expect.any(Boolean), razorpay: expect.any(Boolean) });
    expect(JSON.stringify(status)).not.toMatch(/secret|accessToken|refreshToken|passwordHash/);
  });
});
