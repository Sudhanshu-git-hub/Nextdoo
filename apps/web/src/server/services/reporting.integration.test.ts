import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { recurrenceRules, tags, taskOccurrences, taskTags, tasks, timerSessions, trackingResults } from '@nextdoo/db';
import { requireTestDatabase } from '../../../../../tests/database';
import { getDb } from '../db';
import { registerUser } from './accounts';
import { createProject } from './projects';
import { completeTask, createTask, updateTask } from './tasks';
import { loadWorkspaceSettings, updateWorkspaceSettings } from './workspaces';
import { getSummary } from './tracking';
import { applyTrackingCorrection } from './tracking-corrections';
import { deleteReviewNote, getReviewNote, saveReviewNote } from './review-notes';
await requireTestDatabase();

const DAY = '2026-09-08';

async function workspaceFixture() {
  const u = await registerUser({ email: `reporting-${randomUUID()}@test.local`, passwordHash: 'test', name: null, timeZone: 'UTC' });
  const actor = { userId: u.id, workspaceId: u.workspaceId };
  const project = await createProject(actor, { name: 'Reporting project' });
  return { actor, project };
}
function makeTask(actor: { userId: string; workspaceId: string }, projectId: string, extra = {}) {
  return createTask(actor, { workspaceId: actor.workspaceId, projectId, title: 'Reporting task', priority: 'NONE', tagIds: [], dueAt: `${DAY}T12:00:00Z`, ...extra });
}
async function setSettings(actor: { userId: string; workspaceId: string }, patch: Record<string, unknown>) {
  const current = await loadWorkspaceSettings(actor.workspaceId, actor.workspaceId);
  return updateWorkspaceSettings(actor, actor.workspaceId, { version: current.version, ...patch } as never);
}

it('day windows follow the workspace zone, not UTC', async () => {
  const { actor, project } = await workspaceFixture();
  await setSettings(actor, { timeZone: 'Asia/Kolkata' });
  // IST is UTC+5:30 without DST: local 2026-09-08 ends at 18:29:59.999Z.
  await makeTask(actor, project.id, { dueAt: '2026-09-08T18:29:00Z' }); // local 09-08 23:59
  await makeTask(actor, project.id, { dueAt: '2026-09-08T18:31:00Z' }); // local 09-09 00:01
  const d8 = await getSummary(actor.workspaceId, 'day', DAY);
  expect(d8).toMatchObject({ plannedCount: 1, from: '2026-09-07T18:30:00.000Z', to: '2026-09-08T18:29:59.999Z', timeZone: 'Asia/Kolkata' });
  expect(d8.days).toHaveLength(1);
  expect(d8.days[0]).toMatchObject({ day: '2026-09-08', plannedCount: 1 });
  const d9 = await getSummary(actor.workspaceId, 'day', '2026-09-09');
  expect(d9.plannedCount).toBe(1);
  expect(d9.days[0]).toMatchObject({ day: '2026-09-09', plannedCount: 1 });
});

it('week windows start on the configured week start and run through the reference day', async () => {
  const { actor, project } = await workspaceFixture();
  // 2026-09-05 Sat, 06 Sun, 07 Mon, 08 Tue, 09 Wed.
  for (const d of ['2026-09-05', '2026-09-06', '2026-09-07', '2026-09-08', '2026-09-09']) await makeTask(actor, project.id, { dueAt: `${d}T12:00:00Z` });
  const monday = await getSummary(actor.workspaceId, 'week', DAY);
  expect(monday).toMatchObject({ from: '2026-09-07T00:00:00.000Z', to: '2026-09-08T23:59:59.999Z', plannedCount: 2, weekStart: 1 });
  expect(monday.days.map((d) => d.day)).toEqual(['2026-09-07', '2026-09-08']);
  await setSettings(actor, { weekStart: 0 });
  const sunday = await getSummary(actor.workspaceId, 'week', DAY);
  expect(sunday).toMatchObject({ from: '2026-09-06T00:00:00.000Z', plannedCount: 3, weekStart: 0 });
  expect(sunday.days.map((d) => d.day)).toEqual(['2026-09-06', '2026-09-07', '2026-09-08']);
});

it('overload is judged against the workday guideline, including next-day workdays', async () => {
  const { actor, project } = await workspaceFixture();
  // Default workday 09:00-17:00 = 480 min.
  await makeTask(actor, project.id, { dueAt: '2026-09-07T12:00:00Z', estimateMinutes: 479 });
  await makeTask(actor, project.id, { dueAt: '2026-09-08T12:00:00Z', estimateMinutes: 481 });
  const summary = await getSummary(actor.workspaceId, 'week', DAY);
  const byDay = Object.fromEntries(summary.days.map((d) => [d.day, d]));
  expect(byDay['2026-09-07']).toMatchObject({ overloaded: false, workdayMinutes: 480 });
  expect(byDay['2026-09-08']).toMatchObject({ overloaded: true, workdayMinutes: 480 });
  // Next-day workday 22:00-06:00 = 480 min.
  await setSettings(actor, { workdayStartMinute: 1320, workdayEndMinute: 360 });
  const overnight = await getSummary(actor.workspaceId, 'week', DAY);
  expect(overnight.days[0]!.workdayMinutes).toBe(480);
  expect(overnight.days.find((d) => d.day === '2026-09-08')?.overloaded).toBe(true);
});

it('day scores use current stored results only; a correction re-buckets and re-scores the day', async () => {
  const { actor, project } = await workspaceFixture();
  const { runTrackingCycle } = await import('@nextdoo/db');
  const onTime = await makeTask(actor, project.id, { dueAt: '2026-09-08T09:00:00Z' });
  await completeTask(actor, onTime.id, onTime.version, '2026-09-08T08:00:00Z');
  const late = await makeTask(actor, project.id, { dueAt: '2026-09-08T09:00:00Z' });
  await completeTask(actor, late.id, late.version, '2026-09-08T12:00:00Z');
  await runTrackingCycle(getDb(), actor.workspaceId);
  const current = await getDb().select().from(trackingResults).where(eq(trackingResults.workspaceId, actor.workspaceId));
  const active = current.filter((r) => r.supersededAt === null);
  const expected = Math.round((Number(active[0]!.score!) + Number(active[1]!.score!)) / 2 * 10) / 10;
  const before = await getSummary(actor.workspaceId, 'day', DAY);
  expect(before.days[0]).toMatchObject({ day: DAY, score: expected, unmeasuredCount: 0 });
  expect(before.averageScore).toBe(expected);
  // Externally blocking the late task makes its timing unmeasured and changes the stored score.
  await applyTrackingCorrection(actor, late.id, { kind: 'EXTERNALLY_BLOCKED', action: 'SET', reason: 'Dependency outside the workspace' });
  await runTrackingCycle(getDb(), actor.workspaceId);
  const after = await getSummary(actor.workspaceId, 'day', DAY);
  const afterActive = (await getDb().select().from(trackingResults).where(eq(trackingResults.workspaceId, actor.workspaceId))).filter((r) => r.supersededAt === null);
  const afterExpected = Math.round((Number(afterActive[0]!.score!) + Number(afterActive[1]!.score!)) / 2 * 10) / 10;
  expect(after.days[0]!.score).toBe(afterExpected);
  expect(afterExpected).not.toBe(expected);
});

it('recurrence adherence reads measured components only, never fabricating zeros', async () => {
  const { actor, project } = await workspaceFixture();
  const db = getDb();
  const { runTrackingCycle } = await import('@nextdoo/db');
  const a = await makeTask(actor, project.id, { title: 'Recurring A' });
  const b = await makeTask(actor, project.id, { title: 'Recurring B', dueAt: '2026-09-07T12:00:00Z' });
  const plain = await makeTask(actor, project.id, { title: 'One-off' });
  const ruleA = randomUUID(), ruleB = randomUUID();
  await db.insert(recurrenceRules).values([
    { id: ruleA, workspaceId: actor.workspaceId, templateTaskId: a.id, rule: {}, timeZone: 'UTC', seriesStart: new Date() },
    { id: ruleB, workspaceId: actor.workspaceId, templateTaskId: b.id, rule: {}, timeZone: 'UTC', seriesStart: new Date() },
  ]);
  await db.update(tasks).set({ recurrenceRuleId: ruleA }).where(eq(tasks.id, a.id));
  await db.update(tasks).set({ recurrenceRuleId: ruleB }).where(eq(tasks.id, b.id));
  // A: 3 of 4 completed (one skipped) -> 75. B: 4 of 4 -> 100. Mean 87.5.
  await db.insert(taskOccurrences).values(Array.from({ length: 4 }, (_, i) => ({ id: randomUUID(), recurrenceRuleId: ruleA, occurrenceKey: `${ruleA}:${i}`, dueAt: new Date(), status: i === 3 ? 'SKIPPED' as const : 'COMPLETED' as const })));
  await db.insert(taskOccurrences).values(Array.from({ length: 4 }, (_, i) => ({ id: randomUUID(), recurrenceRuleId: ruleB, occurrenceKey: `${ruleB}:${i}`, dueAt: new Date(), status: 'COMPLETED' as const })));
  await runTrackingCycle(db, actor.workspaceId);
  void plain;
  const summary = await getSummary(actor.workspaceId, 'week', DAY);
  expect(summary.recurrence).toEqual({ recurringCount: 2, measuredCount: 2, adherencePct: 87.5 });
  expect(summary.insights.join(' ')).toMatch(/adherence was 87\.5% across 2 recurring/);
});

it('underestimated categories need two measured tasks and report the overrun', async () => {
  const { actor, project } = await workspaceFixture();
  const db = getDb();
  const client = await db.insert(tags).values({ id: randomUUID(), workspaceId: actor.workspaceId, name: 'client-work' }).returning();
  const internal = await db.insert(tags).values({ id: randomUUID(), workspaceId: actor.workspaceId, name: 'internal' }).returning();
  const link = async (taskId: string, tagId: string) => db.insert(taskTags).values({ taskId, tagId });
  const a = await makeTask(actor, project.id, { title: 'CW A', estimateMinutes: 60 });
  const b = await makeTask(actor, project.id, { title: 'CW B', estimateMinutes: 60 });
  const c = await makeTask(actor, project.id, { title: 'Internal only', estimateMinutes: 60 });
  await link(a.id, client[0]!.id);
  await link(b.id, client[0]!.id);
  await link(c.id, internal[0]!.id);
  for (const [id, actual] of [[a.id, 90], [b.id, 80], [c.id, 90]] as const) {
    await db.update(tasks).set({ actualMinutes: actual, actualSecondsRemainder: 0 }).where(eq(tasks.id, id));
  }
  const summary = await getSummary(actor.workspaceId, 'day', DAY);
  // client-work: (+50 + +33.3) / 2 = +41.67 -> 42. internal has n=1 -> not a signal.
  expect(summary.tagVariances).toEqual([{ tagId: client[0]!.id, name: 'client-work', taskCount: 2, variancePct: 42 }]);
  expect(summary.insights.join(' ')).toMatch(/Tasks tagged 'client-work' took about 42% longer than estimated \(2 task\(s\)\)/);
});

it('most rescheduled lists the top five and excludes hidden tasks', async () => {
  const { actor, project } = await workspaceFixture();
  const db = getDb();
  const { runTrackingCycle } = await import('@nextdoo/db');
  const make = async (title: string, moves: number) => {
    let t = await makeTask(actor, project.id, { title });
    for (let i = 0; i < moves; i += 1) t = await updateTask(actor, t.id, { version: t.version, dueAt: `${DAY}T${String(10 + i).padStart(2, '0')}:00:00Z` });
    return t;
  };
  await make('Moved thrice', 3);
  await make('Moved twice A', 2);
  await make('Moved twice B', 2);
  await make('Moved once', 1);
  const hidden = await make('Hidden mover', 5);
  await applyTrackingCorrection(actor, hidden.id, { kind: 'EXCLUDED_FROM_ANALYTICS', action: 'SET', reason: 'Distorts the trend' });
  await runTrackingCycle(db, actor.workspaceId);
  const summary = await getSummary(actor.workspaceId, 'day', DAY);
  expect(summary.mostRescheduled.map((t) => [t.title, t.count])).toEqual([
    ['Moved thrice', 3],
    ['Moved twice A', 2],
    ['Moved twice B', 2],
    ['Moved once', 1],
  ]);
  expect(summary.mostRescheduled.every((t) => t.taskId !== hidden.id)).toBe(true);
  expect(summary.rescheduledCount).toBe(4);
  expect(summary.excludedCount).toBe(1);
});

it('excluded tasks are hidden from focus time and every trend', async () => {
  const { actor, project } = await workspaceFixture();
  const db = getDb();
  const { runTrackingCycle } = await import('@nextdoo/db');
  const t = await makeTask(actor, project.id);
  await db.insert(timerSessions).values({ id: randomUUID(), workspaceId: actor.workspaceId, taskId: t.id, userId: actor.userId, deviceId: 'test-device', startedAt: new Date(`${DAY}T08:00:00Z`), endedAt: new Date(`${DAY}T08:30:00Z`), accumulatedSeconds: 1800, status: 'STOPPED' });
  const before = await getSummary(actor.workspaceId, 'day', DAY);
  expect(before.days[0]!.focusMinutes).toBe(30);
  await applyTrackingCorrection(actor, t.id, { kind: 'EXCLUDED_FROM_ANALYTICS', action: 'SET', reason: 'One-off' });
  await runTrackingCycle(db, actor.workspaceId);
  const after = await getSummary(actor.workspaceId, 'day', DAY);
  expect(after.plannedCount).toBe(0);
  expect(after.days[0]!.focusMinutes).toBe(0);
  expect(after.excludedCount).toBe(1);
});

it('focus time is bucketed by the local day it started on', async () => {
  const { actor, project } = await workspaceFixture();
  const db = getDb();
  await setSettings(actor, { timeZone: 'Asia/Kolkata' });
  await makeTask(actor, project.id, { dueAt: '2026-09-09T03:00:00Z' }); // local 09-09 08:30
  await db.insert(timerSessions).values({ id: randomUUID(), workspaceId: actor.workspaceId, taskId: (await makeTask(actor, project.id, { dueAt: '2026-09-09T03:00:00Z' })).id, userId: actor.userId, deviceId: 'test-device', startedAt: new Date('2026-09-08T18:31:00Z'), endedAt: new Date('2026-09-08T19:31:00Z'), accumulatedSeconds: 3600, status: 'STOPPED' });
  const summary = await getSummary(actor.workspaceId, 'week', '2026-09-09');
  const byDay = Object.fromEntries(summary.days.map((d) => [d.day, d]));
  expect(byDay['2026-09-08']!.focusMinutes).toBe(0);
  expect(byDay['2026-09-09']!.focusMinutes).toBe(60);
  expect(summary.insights.join(' ')).toMatch(/tracked about 1h of focus time/);
});

it('late average minutes is the mean over due for late completions', async () => {
  const { actor, project } = await workspaceFixture();
  const { runTrackingCycle } = await import('@nextdoo/db');
  const a = await makeTask(actor, project.id, { title: 'One hour late' });
  await completeTask(actor, a.id, a.version, '2026-09-08T13:00:00Z');
  const b = await makeTask(actor, project.id, { title: 'Three hours late' });
  await completeTask(actor, b.id, b.version, '2026-09-08T15:00:00Z');
  await runTrackingCycle(getDb(), actor.workspaceId);
  const summary = await getSummary(actor.workspaceId, 'day', DAY);
  expect(summary).toMatchObject({ lateCount: 2, lateAverageMinutes: 120 });
});

it('cross-workspace reads cannot leak cohorts, trends or notes', async () => {
  const a = await workspaceFixture();
  const b = await workspaceFixture();
  const t = await makeTask(a.actor, a.project.id);
  const db = getDb();
  await db.insert(timerSessions).values({ id: randomUUID(), workspaceId: a.actor.workspaceId, taskId: t.id, userId: a.actor.userId, deviceId: 'test-device', startedAt: new Date(`${DAY}T08:00:00Z`), accumulatedSeconds: 900, status: 'STOPPED' });
  const foreign = await getSummary(b.actor.workspaceId, 'day', DAY);
  expect(foreign).toMatchObject({ plannedCount: 0, days: [{ plannedCount: 0, focusMinutes: 0 }], mostRescheduled: [], tagVariances: [], recurrence: { recurringCount: 0, measuredCount: 0, adherencePct: null } });
  await saveReviewNote(a.actor.userId, a.actor.workspaceId, DAY, 'private note');
  expect(await getReviewNote(a.actor.userId, a.actor.workspaceId, DAY)).toMatchObject({ body: 'private note' });
  await expect(getReviewNote(b.actor.userId, a.actor.workspaceId, DAY)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(saveReviewNote(b.actor.userId, a.actor.workspaceId, DAY, 'intrusion')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(deleteReviewNote(b.actor.userId, a.actor.workspaceId, DAY)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect((await getReviewNote(a.actor.userId, a.actor.workspaceId, DAY))?.body).toBe('private note');
});

it('review notes are per local day, upsert, clear, and bounded', async () => {
  const { actor } = await workspaceFixture();
  expect(await getReviewNote(actor.userId, actor.workspaceId, DAY)).toBeNull();
  const saved = await saveReviewNote(actor.userId, actor.workspaceId, DAY, 'Shipped the hard part; the rest is polish.');
  expect(saved).toMatchObject({ day: DAY, body: 'Shipped the hard part; the rest is polish.' });
  expect(await getReviewNote(actor.userId, actor.workspaceId, '2026-09-07')).toBeNull();
  const overwritten = await saveReviewNote(actor.userId, actor.workspaceId, DAY, 'Edited.');
  expect(overwritten.body).toBe('Edited.');
  expect((await getReviewNote(actor.userId, actor.workspaceId, DAY))?.body).toBe('Edited.');
  const boundary = 'x'.repeat(500);
  await expect(saveReviewNote(actor.userId, actor.workspaceId, DAY, boundary)).resolves.toMatchObject({ body: boundary });
  await deleteReviewNote(actor.userId, actor.workspaceId, DAY);
  expect(await getReviewNote(actor.userId, actor.workspaceId, DAY)).toBeNull();
});

it('impossible calendar dates are rejected in the workspace zone', async () => {
  const { actor } = await workspaceFixture();
  await setSettings(actor, { timeZone: 'Asia/Kolkata' });
  await expect(getSummary(actor.workspaceId, 'day', '2026-02-30')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  await expect(getSummary(actor.workspaceId, 'week', '2026-04-31')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  // A real date in a non-UTC zone still resolves to the requested local day.
  const summary = await getSummary(actor.workspaceId, 'day', DAY);
  expect(summary.days[0]!.day).toBe(DAY);
});

it('empty windows report structured nulls and never fabricate', async () => {
  const { actor } = await workspaceFixture();
  const day = await getSummary(actor.workspaceId, 'day', DAY);
  expect(day).toMatchObject({ plannedCount: 0, completionRate: null, onTimeRate: null, averageScore: null, estimateVariancePct: null, lateAverageMinutes: null, recurrence: { recurringCount: 0, measuredCount: 0, adherencePct: null }, mostRescheduled: [], tagVariances: [] });
  expect(day.days[0]).toMatchObject({ plannedCount: 0, completionRate: null, score: null, focusMinutes: 0, overloaded: false });
  expect(day.insights).toEqual(['Nothing was scheduled in this period, so there is nothing to measure yet.']);
  const week = await getSummary(actor.workspaceId, 'week', DAY);
  expect(week.days).toHaveLength(2); // Monday and the reference Tuesday
  expect(week.days.every((d) => d.score === null && d.focusMinutes === 0)).toBe(true);
});
