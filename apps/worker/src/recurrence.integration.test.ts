import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { recurrenceRules, taskOccurrences, runRecurrenceGeneration } from '@nextdoo/db';
import { requireTestDatabase } from '../../../tests/database';
import { getDb } from '../../web/src/server/db';
import { registerUser } from '../../web/src/server/services/accounts';
import { createTask } from '../../web/src/server/services/tasks';
import { attachRecurrence, changeRecurrence } from '../../web/src/server/services/recurrence';
await requireTestDatabase();
async function fixture() {
 const u = await registerUser({ email: `worker-series-${randomUUID()}@test.local`, passwordHash: 'test', name: null, timeZone: 'UTC' });
 const actor = { userId: u.id, workspaceId: u.workspaceId };
 const task = await createTask(actor, { workspaceId: actor.workspaceId, title: 'Worker template', dueAt: '2020-01-01T09:00:00Z', priority: 'NONE', tagIds: [] });
 const series = await attachRecurrence(actor, task.id, { version: 1, rule: { freq: 'DAILY', interval: 1, count: 1, timeZone: 'UTC' } });
 return { actor, series };
}
it('scheduled generation uses due checks and rule locks across concurrent workers', async () => {
 const { series } = await fixture(); const now = new Date('2020-01-02T00:00:00Z');
 await getDb().update(recurrenceRules).set({ rule: { freq: 'DAILY', interval: 1, count: 3, timeZone: 'UTC' }, nextRunAt: now }).where(eq(recurrenceRules.id, series.id));
 const result = await Promise.all([runRecurrenceGeneration(getDb(), now), runRecurrenceGeneration(getDb(), now)]);
 expect(result.reduce((n, r) => n + r.processed, 0)).toBe(2);
 expect(await getDb().select().from(taskOccurrences).where(eq(taskOccurrences.recurrenceRuleId, series.id))).toHaveLength(3);
 expect((await runRecurrenceGeneration(getDb(), now)).processed).toBe(0);
});
it('hard generation failures back off, stop at five, and explicit reviewed resume resets the failure state', async () => {
 const { actor, series } = await fixture(); let now = new Date('2020-01-03T00:00:00Z');
 await getDb().update(recurrenceRules).set({ rule: { freq: 'INVALID' }, nextRunAt: now }).where(eq(recurrenceRules.id, series.id));
 for (let i = 1; i <= 5; i++) {
  await runRecurrenceGeneration(getDb(), now);
  const [row] = await getDb().select().from(recurrenceRules).where(eq(recurrenceRules.id, series.id));
  expect(row).toMatchObject({ generationError: 'GENERATION_FAILED', failureCount: i });
  expect(row!.nextRunAt.getTime() - now.getTime()).toBe(Math.min(15, 2 ** (i - 1)) * 60000); now = row!.nextRunAt;
 }
 await runRecurrenceGeneration(getDb(), new Date(now.getTime() + 86400000));
 expect((await getDb().select().from(recurrenceRules).where(eq(recurrenceRules.id, series.id)))[0]!.failureCount).toBe(5);
 await getDb().update(recurrenceRules).set({ rule: { freq: 'DAILY', interval: 1, count: 1, timeZone: 'UTC' } }).where(eq(recurrenceRules.id, series.id));
 const resumed = await changeRecurrence(actor, series.id, { version: 1, active: true }); expect(resumed.failureCount).toBe(0); expect(resumed.generationError).toBeNull();
});
it('account deletion suppresses generation without starving the worker queue; cancellation can resume it', async () => {
 const { actor, series } = await fixture(); const { users } = await import('@nextdoo/db'); const now = new Date('2020-01-04T00:00:00Z');
 await getDb().update(recurrenceRules).set({ rule: { freq: 'DAILY', interval: 1, count: 3, timeZone: 'UTC' }, nextRunAt: now }).where(eq(recurrenceRules.id, series.id));
 await getDb().update(users).set({ deletionRequestedAt: new Date() }).where(eq(users.id, actor.userId));
 await runRecurrenceGeneration(getDb(), now);
 expect(await getDb().select().from(taskOccurrences).where(eq(taskOccurrences.recurrenceRuleId, series.id))).toHaveLength(1);
 const [blocked] = await getDb().select().from(recurrenceRules).where(eq(recurrenceRules.id, series.id)); expect(blocked!.nextRunAt > now).toBe(true);
 await getDb().update(users).set({ deletionRequestedAt: null }).where(eq(users.id, actor.userId));
 await runRecurrenceGeneration(getDb(), blocked!.nextRunAt);
 expect(await getDb().select().from(taskOccurrences).where(eq(taskOccurrences.recurrenceRuleId, series.id))).toHaveLength(3);
});
