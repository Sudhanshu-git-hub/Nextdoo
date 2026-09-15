import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { recurrenceRules, taskOccurrences, tasks, trackingResults } from '@nextdoo/db';
import { requireTestDatabase } from '../../../../../tests/database';
import { getDb } from '../db';
import { registerUser } from './accounts';
import { completeTask, createTask, reopenTask, updateTask } from './tasks';
import { buildScoringInput, evaluateTask, getResultForTask } from './tracking';
await requireTestDatabase();
async function fixture(extra = {}) {
  const u = await registerUser({ email: `score-${randomUUID()}@test.local`, name: null, passwordHash: 'test-not-login', timeZone: 'UTC' });
  const actor = { userId: u.id, workspaceId: u.workspaceId };
  const task = await createTask(actor, { workspaceId: u.workspaceId, title: 'Score integrity', priority: 'NONE', tagIds: [], ...extra });
  return { actor, task };
}

describe('scoring history integrity', () => {
  it('reopening immediately removes the old completed score from the active result', async () => {
    const { actor, task } = await fixture();
    const done = await completeTask(actor, task.id, task.version);
    expect((await getResultForTask(actor.workspaceId, task.id))?.score).toBe(100);
    await reopenTask(actor, task.id, done.version);
    expect((await getResultForTask(actor.workspaceId, task.id))?.score).toBeNull();
  });
  it('A → B → A preserves history and exactly one active result instead of losing A', async () => {
    const { actor, task } = await fixture({ estimateMinutes: 30 });
    await getDb().update(tasks).set({ actualMinutes: 30 }).where(eq(tasks.id, task.id));
    const done = await completeTask(actor, task.id, task.version);
    const a = await getResultForTask(actor.workspaceId, task.id);
    const changed = await updateTask(actor, task.id, { version: done.version, estimateMinutes: 60 });
    await evaluateTask(actor.workspaceId, task.id);
    await updateTask(actor, task.id, { version: changed.version, estimateMinutes: 30 });
    const again = await evaluateTask(actor.workspaceId, task.id);
    expect(again).not.toBeNull(); expect(again?.score).toBe(a?.score); expect(again?.id).not.toBe(a?.id);
    const rows = await getDb().select().from(trackingResults).where(eq(trackingResults.taskId, task.id));
    expect(rows).toHaveLength(3); expect(rows.filter((r) => !r.supersededAt)).toHaveLength(1);
  });
  it('three completed plus one skipped occurrence means three of FOUR (TR-06)', async () => {
    const { actor, task } = await fixture(), ruleId = randomUUID();
    await getDb().insert(recurrenceRules).values({ id: ruleId, workspaceId: actor.workspaceId, templateTaskId: task.id, rule: {}, timeZone: 'UTC', seriesStart: new Date() });
    await getDb().update(tasks).set({ recurrenceRuleId: ruleId }).where(eq(tasks.id, task.id));
    await getDb().insert(taskOccurrences).values(Array.from({ length: 4 }, (_, i) => ({ id: randomUUID(), recurrenceRuleId: ruleId, occurrenceKey: `${ruleId}:${i}`, dueAt: new Date(), status: i === 3 ? 'SKIPPED' as const : 'COMPLETED' as const })));
    expect(await buildScoringInput(actor.workspaceId, task.id)).toMatchObject({ expectedOccurrences: 4, completedOccurrences: 3 });
  });
  it('concurrent identical evaluations all return the single active result', async () => {
    const { actor, task } = await fixture();
    const results = await Promise.all(Array.from({ length: 5 }, () => evaluateTask(actor.workspaceId, task.id)));
    expect(results.every(Boolean)).toBe(true);
    expect(new Set(results.map((r) => r?.id)).size).toBe(1);
    expect(await getDb().select().from(trackingResults).where(and(eq(trackingResults.taskId, task.id), isNull(trackingResults.supersededAt)))).toHaveLength(1);
  });
  it('crossing a due instant invalidates the scoring input cache', async () => {
    const now = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(now);
      const { actor, task } = await fixture({ dueAt: new Date(now + 1000).toISOString() });
      expect((await evaluateTask(actor.workspaceId, task.id))?.outcome).toBe('UNMEASURED');
      vi.setSystemTime(now + 2000);
      expect((await evaluateTask(actor.workspaceId, task.id))?.outcome).toBe('INCOMPLETE');
    } finally { vi.useRealTimers(); }
  });
});

it('stores immutable calculation inputs rather than an unrecoverable hash alone', async () => {
  const { actor, task } = await fixture({ estimateMinutes: 30 });
  const done = await completeTask(actor, task.id, task.version);
  const result = await getResultForTask(actor.workspaceId, task.id);
  await updateTask(actor, task.id, { version: done.version, estimateMinutes: 60 });
  const [original] = await getDb().select().from(trackingResults).where(eq(trackingResults.id, result!.id));
  expect((original as unknown as { inputSnapshot?: unknown }).inputSnapshot).toMatchObject({ estimateMinutes: 30, completed: true });
});
