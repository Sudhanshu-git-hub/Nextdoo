import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { ComponentResult } from '@nextdoo/core';
import { requireTestDatabase } from '../../../../../tests/database';
import { getDb } from '../db';
import { registerUser } from './accounts';
import { completeTask, createTask } from './tasks';
import { getSummary, getResultForTask } from './tracking';
import { readTrackingFreshness } from './tracking-freshness';
import {
  applyTrackingCorrection,
  getTrackingBackfillProgress,
  listTaskCorrections,
  requestTrackingBackfill,
} from './tracking-corrections';
await requireTestDatabase();

const dayKey = (offsetDays: number) => new Date(Date.now() - offsetDays * 86_400_000).toISOString().slice(0, 10);
const components = (r: { components: unknown }) => r.components as ComponentResult[];

async function fixture() {
  const u = await registerUser({ email: `corrections-${randomUUID()}@test.local`, passwordHash: 'test', name: null, timeZone: 'UTC' });
  const actor = { userId: u.id, workspaceId: u.workspaceId };
  return { actor, task: await createTask(actor, { workspaceId: actor.workspaceId, title: 'Correction subject', priority: 'NONE', tagIds: [] }) };
}

it('TR-05: a due-date correction after completion recalculates, keeps the original result and leaves events intact', async () => {
  const { actor, task } = await fixture();
  const db = getDb();
  const { tasks, trackingEvents, trackingResults, trackingCorrections, runTrackingCycle } = await import('@nextdoo/db');
  const due = new Date(Date.now() + 5 * 60_000);
  await db.update(tasks).set({ dueAt: due, estimateMinutes: 30 }).where(eq(tasks.id, task.id));
  const done = await completeTask(actor, task.id, task.version);
  const eventsBefore = (await db.select().from(trackingEvents).where(eq(trackingEvents.taskId, task.id))).map((e) => e.id);
  await runTrackingCycle(db, actor.workspaceId);
  const before = await getResultForTask(actor.workspaceId, task.id);
  expect(before?.outcome).toBe('ON_TIME');
  const originalId = before!.id;

  // Correct the due date to before the completion instant → the completion is late.
  const correctedDue = new Date(due.getTime() - 2 * 3_600_000);
  const applied = await applyTrackingCorrection(actor, task.id, { kind: 'DUE_DATE_CORRECTED', reason: 'The original due date was entered wrong', dueAt: correctedDue.toISOString() });
  expect(applied.change).toBe('applied');
  expect(applied.correction).toMatchObject({ kind: 'DUE_DATE_CORRECTED', reason: 'The original due date was entered wrong' });

  await runTrackingCycle(db, actor.workspaceId);
  expect((await readTrackingFreshness(actor.workspaceId, [task.id])).get(task.id)?.status).toBe('FRESH');
  const after = await getResultForTask(actor.workspaceId, task.id);
  expect(after?.id).not.toBe(originalId);
  expect(after).toMatchObject({ outcome: 'LATE', recalculated: true });
  // The original result is superseded, never mutated, still queryable.
  const all = await db.select().from(trackingResults).where(eq(trackingResults.taskId, task.id));
  expect(all).toHaveLength(2);
  expect(all.find((r) => r.id === originalId)).toMatchObject({ supersededAt: expect.any(Date), outcome: 'ON_TIME' });
  // Events are append-only: every original event still exists, in order; the
  // due-date correction itself appends the usual TASK_RESCHEDULED event.
  const eventsAfter = await db.select().from(trackingEvents).where(eq(trackingEvents.taskId, task.id));
  expect(eventsAfter.length).toBeGreaterThan(eventsBefore.length);
  expect(eventsAfter.slice(0, eventsBefore.length).map((e) => e.id)).toEqual(eventsBefore);
  // Actor, reason and the old/new due are recorded.
  const [row] = await db.select().from(trackingCorrections).where(eq(trackingCorrections.taskId, task.id));
  expect(row).toMatchObject({ kind: 'DUE_DATE_CORRECTED', actorId: actor.userId, reason: 'The original due date was entered wrong' });
  expect(row!.payload).toMatchObject({ from: due.toISOString(), to: correctedDue.toISOString() });
  // The corrected due date is the task's real due date now.
  expect((await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!.dueAt!.getTime()).toBe(correctedDue.getTime());
  expect(done.version).toBeLessThan((await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!.version);
});

it('re-applying the same toggle correction is a no-op and undo inserts a new row, never an update', async () => {
  const { actor, task } = await fixture();
  const first = await applyTrackingCorrection(actor, task.id, { kind: 'EXTERNALLY_BLOCKED', action: 'SET', reason: 'Blocked waiting on a vendor' });
  expect(first.change).toBe('applied');
  const noop = await applyTrackingCorrection(actor, task.id, { kind: 'EXTERNALLY_BLOCKED', action: 'SET', reason: 'Retried the same action' });
  expect(noop.change).toBe('noop');
  expect(noop.correction.id).toBe(first.correction.id);
  const reverted = await applyTrackingCorrection(actor, task.id, { kind: 'EXTERNALLY_BLOCKED', action: 'CLEAR', reason: 'The blockage was lifted' });
  expect(reverted.change).toBe('applied');
  expect(reverted.correction.id).not.toBe(first.correction.id);
  const rows = await listTaskCorrections(actor.workspaceId, task.id);
  expect(rows).toHaveLength(2);
  expect(rows.map((r) => r.state)).toEqual(['CLEAR', 'SET']);
  // Rows are immutable: the original row still carries its original reason.
  expect(rows[1]!.reason).toBe('Blocked waiting on a vendor');
});

it('UNTRACKED_COMPLETION scores the completion as absent and restores it on revert', async () => {
  const { actor, task } = await fixture();
  const db = getDb();
  const { tasks, trackingResults, runTrackingCycle } = await import('@nextdoo/db');
  const due = new Date(Date.now() - 60 * 60_000);
  await db.update(tasks).set({ dueAt: due, estimateMinutes: 30 }).where(eq(tasks.id, task.id));
  await completeTask(actor, task.id, task.version, new Date(due.getTime() - 10 * 60_000).toISOString());
  await runTrackingCycle(db, actor.workspaceId);
  expect((await getResultForTask(actor.workspaceId, task.id))?.outcome).toBe('ON_TIME');
  const originalId = (await getResultForTask(actor.workspaceId, task.id))!.id;

  await applyTrackingCorrection(actor, task.id, { kind: 'UNTRACKED_COMPLETION', action: 'SET', reason: 'Completion happened outside this workspace' });
  await runTrackingCycle(db, actor.workspaceId);
  expect((await readTrackingFreshness(actor.workspaceId, [task.id])).get(task.id)?.status).toBe('FRESH');
  const untracked = await getResultForTask(actor.workspaceId, task.id);
  expect(untracked?.id).not.toBe(originalId);
  expect(untracked?.outcome).toBe('INCOMPLETE');
  expect(untracked?.recalculated).toBe(true);
  const timing = components(untracked!).find((c) => c.key === 'timing');
  expect(timing).toMatchObject({ value: null, measured: false });
  const completion = components(untracked!).find((c) => c.key === 'completion');
  expect(completion?.value).toBe(0);

  await applyTrackingCorrection(actor, task.id, { kind: 'UNTRACKED_COMPLETION', action: 'CLEAR', reason: 'It was tracked after all' });
  await runTrackingCycle(db, actor.workspaceId);
  const restored = await getResultForTask(actor.workspaceId, task.id);
  expect(restored?.id).not.toBe(untracked!.id);
  expect(restored?.outcome).toBe('ON_TIME');
  const all = await db.select().from(trackingResults).where(eq(trackingResults.taskId, task.id));
  expect(all).toHaveLength(3);
  expect(all.find((r) => r.id === originalId)?.supersededAt).toBeInstanceOf(Date);
});

it('EXTERNALLY_BLOCKED marks timing Unmeasured without touching facts or other components', async () => {
  const { actor, task } = await fixture();
  const db = getDb();
  const { tasks, runTrackingCycle } = await import('@nextdoo/db');
  const due = new Date(Date.now() - 4 * 3_600_000);
  await db.update(tasks).set({ dueAt: due, estimateMinutes: 60 }).where(eq(tasks.id, task.id));
  await completeTask(actor, task.id, task.version, new Date(due.getTime() + 3 * 3_600_000).toISOString()); // 3h late → timing 88
  await runTrackingCycle(db, actor.workspaceId);
  const plain = await getResultForTask(actor.workspaceId, task.id);
  expect(plain?.outcome).toBe('LATE');
  expect(components(plain!).find((c) => c.key === 'timing')?.value).toBe(88);
  const plainId = plain!.id;

  await applyTrackingCorrection(actor, task.id, { kind: 'EXTERNALLY_BLOCKED', action: 'SET', reason: 'Waiting on a dependency outside the workspace' });
  await runTrackingCycle(db, actor.workspaceId);
  const blocked = await getResultForTask(actor.workspaceId, task.id);
  expect(blocked?.id).not.toBe(plainId);
  expect(blocked?.outcome).toBe('LATE'); // facts unchanged
  expect(blocked?.recalculated).toBe(true);
  const timing = components(blocked!).find((c) => c.key === 'timing');
  expect(timing).toMatchObject({ value: null, measured: false });
  expect(timing!.reason).toMatch(/externally blocked/i);
  expect(blocked!.measuredWeight).toBe(0.4); // completion only — timing and estimate are Unmeasured (no tracked time)
  expect(blocked?.score).toBe(100); // remaining weights normalised, nothing fabricated
});

it('EXCLUDED_FROM_ANALYTICS removes the task from the day summary, not from its stored result', async () => {
  const { actor, task } = await fixture();
  const db = getDb();
  const { tasks, runTrackingCycle } = await import('@nextdoo/db');
  const today = dayKey(0);
  const noon = new Date(`${today}T12:00:00Z`);
  await db.update(tasks).set({ dueAt: noon }).where(eq(tasks.id, task.id));
  await runTrackingCycle(db, actor.workspaceId);
  const baseline = await getSummary(actor.workspaceId, 'day', today);
  expect(baseline.plannedCount).toBe(1);

  await applyTrackingCorrection(actor, task.id, { kind: 'EXCLUDED_FROM_ANALYTICS', action: 'SET', reason: 'One-off task that distorts the trend' });
  const excluded = await getSummary(actor.workspaceId, 'day', today);
  expect(excluded.plannedCount).toBe(0);
  expect(excluded.excludedCount).toBe(1);
  // The stored result and its drill-down remain available.
  expect(await getResultForTask(actor.workspaceId, task.id)).toBeTruthy();
  expect((await listTaskCorrections(actor.workspaceId, task.id)).map((c) => c.state)).toEqual(['SET']);

  await applyTrackingCorrection(actor, task.id, { kind: 'EXCLUDED_FROM_ANALYTICS', action: 'CLEAR', reason: 'Include it again' });
  const restored = await getSummary(actor.workspaceId, 'day', today);
  expect(restored.plannedCount).toBe(1);
  expect(restored.excludedCount).toBe(0);
});

it('a due-date correction that only repeats the current due date is rejected', async () => {
  const { actor, task } = await fixture();
  const db = getDb();
  const { tasks } = await import('@nextdoo/db');
  const due = new Date(Date.now() + 3600_000);
  await db.update(tasks).set({ dueAt: due }).where(eq(tasks.id, task.id));
  await expect(
    applyTrackingCorrection(actor, task.id, { kind: 'DUE_DATE_CORRECTED', reason: 'No change', dueAt: due.toISOString() }),
  ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
});

it('a foreign user cannot read or correct another workspace task', async () => {
  const own = await fixture();
  const foreign = await fixture();
  await expect(applyTrackingCorrection(foreign.actor, own.task.id, { kind: 'EXTERNALLY_BLOCKED', action: 'SET', reason: 'Not mine' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(requestTrackingBackfill({ ...foreign.actor, workspaceId: own.actor.workspaceId }, { reason: 'Steal a recalculation' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(await listTaskCorrections(own.actor.workspaceId, own.task.id)).toEqual([]);
});

it('runs a bounded date-range backfill day by day, observably, and re-evaluates only the affected tasks', async () => {
  const { actor, task } = await fixture();
  const db = getDb();
  const { tasks, trackingResults, runTrackingCycle, runTrackingBackfill } = await import('@nextdoo/db');
  // Three tasks on three different UTC days: -3d completed, -1d completed, today active.
  const old = await createTask(actor, { workspaceId: actor.workspaceId, title: 'Old task', priority: 'NONE', tagIds: [] });
  const mid = await createTask(actor, { workspaceId: actor.workspaceId, title: 'Mid task', priority: 'NONE', tagIds: [] });
  await db.update(tasks).set({ dueAt: new Date(`${dayKey(3)}T09:00:00Z`) }).where(eq(tasks.id, old.id));
  await db.update(tasks).set({ dueAt: new Date(`${dayKey(1)}T09:00:00Z`) }).where(eq(tasks.id, mid.id));
  await db.update(tasks).set({ dueAt: new Date(`${dayKey(0)}T09:00:00Z`) }).where(eq(tasks.id, task.id));
  await completeTask(actor, old.id, old.version, `${dayKey(3)}T10:00:00Z`);
  await completeTask(actor, mid.id, mid.version, `${dayKey(1)}T12:00:00Z`);
  await runTrackingCycle(db, actor.workspaceId);
  const countsBefore = (await db.select().from(trackingResults).where(eq(trackingResults.workspaceId, actor.workspaceId))).length;
  expect(countsBefore).toBe(3);

  const requested = await requestTrackingBackfill(actor, { from: dayKey(3), to: dayKey(0), reason: 'Quarterly review' });
  expect(requested).toMatchObject({ from: dayKey(3), to: dayKey(0), totalDays: 4, status: 'PENDING' });
  expect(await getTrackingBackfillProgress(actor)).toMatchObject({ status: 'PENDING', processedDays: 0, totalDays: 4 });

  // One (workspace, day) chunk per run — four runs finish the range.
  for (let i = 0; i < 3; i++) {
    const run = await runTrackingBackfill(db, actor.workspaceId);
    expect(run.days).toBe(1);
    await runTrackingCycle(db, actor.workspaceId);
  }
  const final = await runTrackingBackfill(db, actor.workspaceId);
  expect(final).toMatchObject({ days: 1, completed: 1 });
  await runTrackingCycle(db, actor.workspaceId);

  expect(await getTrackingBackfillProgress(actor)).toMatchObject({ status: 'COMPLETED', processedDays: 4, remainingDays: 0 });
  const states = await readTrackingFreshness(actor.workspaceId, [task.id, old.id, mid.id]);
  for (const id of [task.id, old.id, mid.id]) expect(states.get(id)?.status).toBe('FRESH');
  // Re-evaluating unchanged inputs is a no-op: no duplicate result rows.
  expect((await db.select().from(trackingResults).where(eq(trackingResults.workspaceId, actor.workspaceId))).length).toBe(countsBefore);

  // A second range request over the same days still completes, still no duplicates.
  await requestTrackingBackfill(actor, { from: dayKey(3), to: dayKey(0), reason: 'Double check' });
  for (let i = 0; i < 4; i++) {
    await runTrackingBackfill(db, actor.workspaceId);
    await runTrackingCycle(db, actor.workspaceId);
  }
  expect((await getTrackingBackfillProgress(actor))!.status).toBe('COMPLETED');
  expect((await db.select().from(trackingResults).where(eq(trackingResults.workspaceId, actor.workspaceId))).length).toBe(countsBefore);
});

it('refuses an out-of-bounds or future recalculation range', async () => {
  const { actor } = await fixture();
  await expect(requestTrackingBackfill(actor, { from: dayKey(2), to: dayKey(5), reason: 'Backwards' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  await expect(requestTrackingBackfill(actor, { from: '2000-01-01', to: dayKey(0), reason: 'Too wide' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  await expect(requestTrackingBackfill(actor, { from: dayKey(1), to: dayKey(-1), reason: 'In the future' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  expect(await getTrackingBackfillProgress(actor)).toBeNull();
});
