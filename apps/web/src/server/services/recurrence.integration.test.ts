import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { taskOccurrences, tasks, recurrenceRules, generateRecurrenceBatch } from '@nextdoo/db';
import { requireTestDatabase } from '../../../../../tests/database';
import { getDb } from '../db';
import { registerUser } from './accounts';
import { createTask, completeTask, rescheduleTask, loadTask } from './tasks';
import { attachRecurrence, changeRecurrence, getRecurrence, skipOccurrence } from './recurrence';
await requireTestDatabase();
// Freeze Date only; real PostgreSQL/network timers keep running.
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-09T06:00:00Z')); });
afterEach(() => vi.useRealTimers());
async function fixture() {
 const u = await registerUser({ email: `series-${randomUUID()}@test.local`, passwordHash: 'test', name: null, timeZone: 'UTC' });
 const actor = { userId: u.id, workspaceId: u.workspaceId };
 const task = await createTask(actor, { workspaceId: actor.workspaceId, title: 'Recurring work', dueAt: '2026-09-10T09:00:00Z', priority: 'HIGH', tagIds: [] });
 return { actor, task };
}
it('attaches a series, generates real task occurrences, and retries/concurrent generation never duplicate them', async () => {
 const { actor, task } = await fixture();
 const series = await attachRecurrence(actor, task.id, { version: 1, rule: { freq: 'DAILY', interval: 1, count: 4, timeZone: 'UTC' } });
 expect(series.occurrences).toHaveLength(4);
 expect(new Set(series.occurrences.map((o) => o.taskId)).size).toBe(4);
 await Promise.all([generateRecurrenceBatch(getDb(), series.id), generateRecurrenceBatch(getDb(), series.id)]);
 expect((await getRecurrence(actor.workspaceId, series.id)).occurrences).toHaveLength(4);
 expect((await getDb().select().from(tasks).where(eq(tasks.workspaceId, actor.workspaceId))).every((t) => t.priority === 'HIGH')).toBe(true);
});
it('normal complete/reschedule operations maintain occurrence history; skip is distinct and version-safe', async () => {
 const { actor, task } = await fixture(); const series = await attachRecurrence(actor, task.id, { version: 1, rule: { freq: 'DAILY', interval: 1, count: 3, timeZone: 'UTC' } });
 const first = await loadTask(actor.workspaceId, task.id);
 await completeTask(actor, first.id, first.version);
 const second = series.occurrences.find((o) => o.taskId !== task.id)!; const row = await loadTask(actor.workspaceId, second.taskId!);
 await rescheduleTask(actor, row.id, row.version, '2026-09-20T10:00:00Z');
 await expect(skipOccurrence(actor, row.id, { version: row.version })).rejects.toMatchObject({ code: 'RESOURCE_VERSION_CONFLICT' });
 await skipOccurrence(actor, row.id, { version: row.version + 1 });
 const after = await getRecurrence(actor.workspaceId, series.id);
 expect(after.occurrences.find((o) => o.taskId === first.id)?.status).toBe('COMPLETED');
 expect(after.occurrences.find((o) => o.taskId === row.id)?.status).toBe('SKIPPED');
 expect(after.occurrences.find((o) => o.taskId === row.id)?.dueAt).toBe(second.dueAt);
 expect((await loadTask(actor.workspaceId, row.id)).status).toBe('ARCHIVED');
});
it('future edits preserve every existing task/occurrence and reject a start inside the generated range', async () => {
 const { actor, task } = await fixture(); const series = await attachRecurrence(actor, task.id, { version: 1, rule: { freq: 'DAILY', interval: 1, count: 2, timeZone: 'UTC' } });
 const before = await getDb().select().from(tasks).where(eq(tasks.workspaceId, actor.workspaceId));
 await expect(changeRecurrence(actor, series.id, { version: 1, rule: { freq: 'WEEKLY', interval: 1, timeZone: 'UTC' }, startsAt: '2026-09-11T09:00:00Z' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
 const changed = await changeRecurrence(actor, series.id, { version: 1, rule: { freq: 'DAILY', interval: 2, count: 2, timeZone: 'UTC' }, startsAt: '2026-09-15T10:00:00Z' });
 expect(changed.version).toBe(2); expect(changed.occurrences).toHaveLength(4);
 for (const row of before) expect(await loadTask(actor.workspaceId, row.id)).toEqual(row);
});
it('rule and task writes stay tenant-scoped and reject stale versions', async () => {
 const a = await fixture(), b = await fixture();
 await expect(attachRecurrence(a.actor, b.task.id, { version: 1, rule: { freq: 'DAILY', interval: 1, timeZone: 'UTC' } })).rejects.toMatchObject({ code: 'NOT_FOUND' });
 const series = await attachRecurrence(a.actor, a.task.id, { version: 1, rule: { freq: 'DAILY', interval: 1, count: 2, timeZone: 'UTC' } });
 await expect(getRecurrence(b.actor.workspaceId, series.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
 await expect(changeRecurrence(a.actor, series.id, { version: 0, active: false })).rejects.toBeTruthy();
 await changeRecurrence(a.actor, series.id, { version: 1, active: false });
 await expect(changeRecurrence(a.actor, series.id, { version: 1, active: true })).rejects.toMatchObject({ code: 'RESOURCE_VERSION_CONFLICT' });
});
it('a paused series does not generate, and generated work is bounded by active-task limits', async () => {
 const { actor, task } = await fixture();
 await getDb().insert(tasks).values(Array.from({ length: 198 }, () => ({ id: randomUUID(), workspaceId: actor.workspaceId, title: 'Capacity' })));
 const series = await attachRecurrence(actor, task.id, { version: 1, rule: { freq: 'DAILY', interval: 1, count: 5, timeZone: 'UTC' } });
 expect(series.occurrences).toHaveLength(2); expect(series.generationError).toBe('ACTIVE_TASK_LIMIT');
 await changeRecurrence(actor, series.id, { version: 1, active: false });
 expect((await generateRecurrenceBatch(getDb(), series.id)).generated).toBe(0);
 expect(await getDb().select().from(taskOccurrences).where(eq(taskOccurrences.recurrenceRuleId, series.id))).toHaveLength(2);
});
it('malformed stored rules roll back generation rather than advancing its checkpoint', async () => {
 const { actor, task } = await fixture(); const series = await attachRecurrence(actor, task.id, { version: 1, rule: { freq: 'DAILY', interval: 1, count: 1, timeZone: 'UTC' } });
 await getDb().update(recurrenceRules).set({ rule: { freq: 'SQL' } }).where(and(eq(recurrenceRules.id, series.id), eq(recurrenceRules.workspaceId, actor.workspaceId)));
 await expect(generateRecurrenceBatch(getDb(), series.id)).rejects.toBeTruthy();
 expect(await getDb().select().from(taskOccurrences).where(eq(taskOccurrences.recurrenceRuleId, series.id))).toHaveLength(1);
});
it('restoring a skipped instance clears the current skip state but retains the immutable skip event', async () => {
 const { actor, task } = await fixture(); await attachRecurrence(actor, task.id, { version: 1, rule: { freq: 'DAILY', interval: 1, count: 1, timeZone: 'UTC' } });
 await skipOccurrence(actor, task.id, { version: 2 });
 const { restoreTask } = await import('./tasks'); await restoreTask(actor, task.id, 3);
 const { buildScoringInput } = await import('./tracking'); expect((await buildScoringInput(actor.workspaceId, task.id))?.skipped).toBe(false);
 const { trackingEvents } = await import('@nextdoo/db'); expect(await getDb().select().from(trackingEvents).where(and(eq(trackingEvents.taskId, task.id), eq(trackingEvents.type, 'TASK_SKIPPED')))).toHaveLength(1);
});
it('generic sync rejects recurrence commands instead of silently acknowledging or enabling offline series creation', async () => {
 const { actor, task } = await fixture(); const { pushMutations } = await import('./sync');
 for (const operation of ['create', 'update'] as const) {
  const input = { deviceId: 'recurrence-offline', mutations: [{ mutationId: randomUUID(), entityId: operation === 'create' ? randomUUID() : task.id, entityType: 'task' as const, operation, baseVersion: 1, payload: { title: 'Preserve me', dueAt: '2026-09-10T09:00:00Z', recurrenceRule: { freq: 'DAILY', interval: 1, count: 2, timeZone: 'UTC' } }, createdAt: new Date().toISOString() }] };
  expect((await pushMutations(actor, input)).results[0]?.status).toBe('rejected');
 }
 expect(await getDb().select().from(tasks).where(eq(tasks.workspaceId, actor.workspaceId))).toHaveLength(1);
});
it('failure on a later generated task rolls back the rule, source version and all earlier generated history', async () => {
 const { actor, task } = await fixture(); const { sql } = await import('drizzle-orm');
 const name = `recurrence_test_${randomUUID().replaceAll('-', '')}`;
 await getDb().execute(sql.raw(`ALTER TABLE outbox ADD CONSTRAINT ${name} CHECK (workspace_id <> '${actor.workspaceId}'::uuid OR payload->>'occurrenceKey' NOT LIKE '%:2026-09-12') NOT VALID`));
 try { await expect(attachRecurrence(actor, task.id, { version: 1, rule: { freq: 'DAILY', interval: 1, count: 3, timeZone: 'UTC' } })).rejects.toBeTruthy(); }
 finally { await getDb().execute(sql.raw(`ALTER TABLE outbox DROP CONSTRAINT ${name}`)); }
 expect(await getDb().select().from(tasks).where(eq(tasks.workspaceId, actor.workspaceId))).toHaveLength(1);
 expect(await loadTask(actor.workspaceId, task.id)).toMatchObject({ version: 1, recurrenceRuleId: null });
 expect(await getDb().select().from(recurrenceRules).where(eq(recurrenceRules.workspaceId, actor.workspaceId))).toHaveLength(0);
 const { auditLogs, outbox, syncChanges, trackingEvents } = await import('@nextdoo/db');
 expect(await getDb().select().from(outbox).where(eq(outbox.workspaceId, actor.workspaceId))).toHaveLength(1);
 expect(await getDb().select().from(syncChanges).where(and(eq(syncChanges.workspaceId, actor.workspaceId), eq(syncChanges.entityType, 'task')))).toHaveLength(1);
 expect(await getDb().select().from(trackingEvents).where(eq(trackingEvents.workspaceId, actor.workspaceId))).toHaveLength(2);
 expect((await getDb().select().from(auditLogs).where(eq(auditLogs.workspaceId, actor.workspaceId))).some((r) => r.action.startsWith('recurrence.'))).toBe(false);
});
it('generation pauses at 50 future occurrences and never passes its 60-day horizon', async () => {
 const { actor, task } = await fixture(); const series = await attachRecurrence(actor, task.id, { version: 1, rule: { freq: 'DAILY', interval: 1, timeZone: 'UTC' } });
 expect(series.occurrences).toHaveLength(50);
 await generateRecurrenceBatch(getDb(), series.id);
 const after = await getRecurrence(actor.workspaceId, series.id); expect(after.occurrences).toHaveLength(50);
 expect(after.occurrences.every((o) => new Date(o.dueAt).getTime() <= Date.now() + 60 * 86400000)).toBe(true);
});
it('monthly clamping, time-zone edits and deleted instances retain original keys without regenerating deleted work', async () => {
 const { actor, task } = await fixture();
 const { updateTask, deleteTask } = await import('./tasks');
 await updateTask(actor, task.id, { version: 1, dueAt: '2026-02-28T09:00:00Z' });
 const series = await attachRecurrence(actor, task.id, { version: 2, rule: { freq: 'MONTHLY', interval: 1, byMonthDay: 31, count: 2, timeZone: 'UTC' } });
 expect(series.occurrences.map((o) => o.dueAt)).toEqual(['2026-02-28T09:00:00.000Z', '2026-03-31T09:00:00.000Z']);
 const deleted = series.occurrences[1]!; await deleteTask(actor, deleted.taskId!, deleted.task!.version);
 const changed = await changeRecurrence(actor, series.id, { version: 1, rule: { freq: 'DAILY', interval: 1, count: 2, timeZone: 'Asia/Kolkata' }, startsAt: '2026-09-15T03:30:00Z' });
 expect(changed.occurrences.slice(0, 2).map((o) => o.occurrenceKey)).toEqual(series.occurrences.map((o) => o.occurrenceKey));
 expect(changed.occurrences.find((o) => o.id === deleted.id)?.task).toBeNull();
 expect(changed.occurrences).toHaveLength(4);
});
it('weekly weekdays and DST midnight series produce the expected durable dates', async () => {
 const a = await fixture();
 const weekly = await attachRecurrence(a.actor, a.task.id, { version: 1, rule: { freq: 'WEEKLY', interval: 1, count: 3, byWeekday: [1, 4], timeZone: 'UTC' } });
 expect(weekly.occurrences.map((o) => o.dueAt)).toEqual(['2026-09-10T09:00:00.000Z', '2026-09-14T09:00:00.000Z', '2026-09-17T09:00:00.000Z']);
 const b = await fixture(); const { updateTask } = await import('./tasks');
 await updateTask(b.actor, b.task.id, { version: 1, dueAt: '2026-10-30T04:15:00Z' });
 const dst = await attachRecurrence(b.actor, b.task.id, { version: 2, rule: { freq: 'DAILY', interval: 1, count: 4, timeZone: 'America/New_York' } });
 expect(dst.occurrences.map((o) => o.dueAt)).toEqual(['2026-10-30T04:15:00.000Z', '2026-10-31T04:15:00.000Z', '2026-11-01T04:15:00.000Z', '2026-11-02T05:15:00.000Z']);
});
it('metadata and tags are copied, while unavailable projects block generation without losing the template', async () => {
 const { actor, task } = await fixture(); const { createProject, createTag, setProjectArchived } = await import('./projects'); const { updateTask } = await import('./tasks');
 const p = await createProject(actor, { name: 'Recurrence project' }); const tag = await createTag(actor.workspaceId, 'recurring');
 await updateTask(actor, task.id, { version: 1, description: 'Saved template', projectId: p.id, tagIds: [tag.id], estimateMinutes: 15 });
 const series = await attachRecurrence(actor, task.id, { version: 2, rule: { freq: 'DAILY', interval: 1, count: 2, timeZone: 'UTC' } });
 for (const o of series.occurrences) { expect(o.task).toMatchObject({ description: 'Saved template', projectId: p.id, estimateMinutes: 15 }); }
 const { taskTags } = await import('@nextdoo/db'); expect(await getDb().select().from(taskTags).where(eq(taskTags.tagId, tag.id))).toHaveLength(2);
 await setProjectArchived(actor, p.id, p.version, true);
 await generateRecurrenceBatch(getDb(), series.id);
 expect((await getRecurrence(actor.workspaceId, series.id)).generationError).toBe('PROJECT_UNAVAILABLE');
 expect((await getRecurrence(actor.workspaceId, series.id)).occurrences).toHaveLength(2);
});
