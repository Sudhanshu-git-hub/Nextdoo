import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { projects, tasks, trackingResults, userPreferences } from '@nextdoo/db';
import { requireTestDatabase } from '../../../../../tests/database';
import { getDb } from '../db';
import { registerUser } from './accounts';
import { createProject, setProjectArchived } from './projects';
import * as projectServices from './projects';
import { completeTask, createTask, deleteTask, updateTask } from './tasks';
import { getSummary } from './tracking';
import * as analytics from './project-analytics';
await requireTestDatabase();
const day = '2026-09-08';
async function fixture() {
 const u = await registerUser({ email: `analytics-${randomUUID()}@test.local`, passwordHash: 'test', name: null, timeZone: 'Asia/Kolkata' });
 const actor = { userId: u.id, workspaceId: u.workspaceId };
 return { actor, project: await createProject(actor, { name: 'Measured work' }) };
}
function task(actor: { workspaceId: string; userId: string }, projectId: string, extra = {}) {
 return createTask(actor, { workspaceId: actor.workspaceId, projectId, title: 'Private task', priority: 'NONE', tagIds: [], dueAt: `${day}T12:00:00Z`, ...extra });
}
it('scopes every metric and stored score to the same project due-date cohort', async () => {
 const { actor, project } = await fixture(), other = await createProject(actor, { name: 'Other' });
 const included = await task(actor, project.id, { estimateMinutes: 20 });
 await completeTask(actor, included.id, included.version, `${day}T11:00:00Z`);
 await task(actor, project.id);
 const unrelated = await task(actor, other.id, { estimateMinutes: 999 });
 await completeTask(actor, unrelated.id, unrelated.version, `${day}T18:00:00Z`);
 await task(actor, project.id, { dueAt: null });
 await task(actor, project.id, { dueAt: '2026-09-09T00:00:00Z' });
 const summary = await analytics.getProjectAnalytics(actor, project.id, { period: 'day', date: day });
 expect(summary).toMatchObject({ projectId: project.id, timeZone: 'UTC', plannedCount: 2, completedCount: 1, onTimeCount: 1, completionRate: 0.5, onTimeRate: 1, plannedMinutes: 20, averageScore: 100, scoredCount: 1, missingResultCount: 1 });
 expect(JSON.stringify(summary)).not.toContain('Private task');
});
it('day and rolling-seven-day windows include exact UTC boundaries and reject impossible dates', async () => {
 const { actor, project } = await fixture();
 for (const dueAt of ['2026-09-01T23:59:59.999Z', '2026-09-02T00:00:00Z', '2026-09-08T00:00:00Z', '2026-09-08T23:59:59.999Z', '2026-09-09T00:00:00Z']) await task(actor, project.id, { dueAt });
 expect(await analytics.getProjectAnalytics(actor, project.id, { period: 'week', date: day })).toMatchObject({ plannedCount: 3, from: '2026-09-02T00:00:00.000Z', to: '2026-09-08T23:59:59.999Z' });
 expect((await analytics.getProjectAnalytics(actor, project.id, { period: 'day', date: day })).plannedCount).toBe(2);
 await expect(analytics.getProjectAnalytics(actor, project.id, { period: 'day', date: '2026-02-30' })).rejects.toThrow();
});
it('empty and unmeasured cohorts do not fabricate percentages, variance or scores', async () => {
 const { actor, project } = await fixture();
 expect(await analytics.getProjectAnalytics(actor, project.id, { period: 'day', date: day })).toMatchObject({ plannedCount: 0, completionRate: null, onTimeRate: null, averageScore: null, estimateVariancePct: null, scoredCount: 0 });
 await task(actor, project.id);
 expect(await analytics.getProjectAnalytics(actor, project.id, { period: 'day', date: day })).toMatchObject({ averageScore: null, missingResultCount: 1, actualMeasuredCount: 0, estimateMeasuredCount: 0 });
});
it('preserves second-level tracked time and paired estimate measurement in shared summaries', async () => {
 const { actor, project } = await fixture();
 const t = await task(actor, project.id, { estimateMinutes: 1 });
 await getDb().update(tasks).set({ actualSecondsRemainder: 30 }).where(eq(tasks.id, t.id));
 const summary = await getSummary(actor.workspaceId, 'day', new Date(`${day}T12:00:00Z`));
 expect(summary.actualMinutes).toBe(0.5);
 expect(summary.estimateVariancePct).toBe(-50);
});
it('foreign/deleted projects are inaccessible; archived reports remain readable and moves use current membership', async () => {
 const a = await fixture(), b = await fixture();
 await expect(analytics.getProjectAnalytics(a.actor, b.project.id, { period: 'day', date: day })).rejects.toMatchObject({ code: 'NOT_FOUND' });
 const t = await task(a.actor, a.project.id);
 const target = await createProject(a.actor, { name: 'Destination' });
 await updateTask(a.actor, t.id, { version: t.version, projectId: target.id });
 expect((await analytics.getProjectAnalytics(a.actor, a.project.id, { period: 'day', date: day })).plannedCount).toBe(0);
 await setProjectArchived(a.actor, target.id, target.version, true);
 expect((await analytics.getProjectAnalytics(a.actor, target.id, { period: 'day', date: day })).plannedCount).toBe(1);
 await deleteTask(a.actor, t.id);
 expect((await analytics.getProjectAnalytics(a.actor, target.id, { period: 'day', date: day })).plannedCount).toBe(0);
 await getDb().update(projects).set({ deletedAt: new Date() }).where(eq(projects.id, target.id));
 await expect(analytics.getProjectAnalytics(a.actor, target.id, { period: 'day', date: day })).rejects.toMatchObject({ code: 'NOT_FOUND' });
});
it('project reads honor disabled numeric scores and do not create or replace calculation history', async () => {
 const { actor, project } = await fixture();
 const t = await task(actor, project.id);
 await completeTask(actor, t.id, t.version, `${day}T11:00:00Z`);
 const before = await getDb().select().from(trackingResults).where(eq(trackingResults.taskId, t.id));
 await getDb().insert(userPreferences).values({ userId: actor.userId, key: 'disableScores', value: true });
 const summary = await analytics.getProjectAnalytics(actor, project.id, { period: 'day', date: day });
 expect(summary.scoresEnabled).toBe(false); expect(summary).not.toHaveProperty('averageScore');
 expect(summary.completedCount).toBe(1);
 expect(await getDb().select().from(trackingResults).where(eq(trackingResults.taskId, t.id))).toEqual(before);
});

it('a concurrent project move cannot mix project access, cohort and results from different snapshots', async () => {
 const { actor, project } = await fixture();
 const t = await task(actor, project.id);
 const target = await createProject(actor, { name: 'Concurrent destination' });
 let announce!: () => void, release!: () => void;
 const loaded = new Promise<void>((resolve) => { announce = resolve; });
 const proceed = new Promise<void>((resolve) => { release = resolve; });
 const original = projectServices.loadProject;
 const spy = vi.spyOn(projectServices, 'loadProject').mockImplementationOnce(async (workspaceId, id) => {
   const row = await original(workspaceId, id); announce(); await proceed; return row;
 });
 const pending = analytics.getProjectAnalytics(actor, project.id, { period: 'day', date: day });
 try {
   await loaded;
   await updateTask(actor, t.id, { version: t.version, projectId: target.id });
   release();
   expect(await pending).toMatchObject({ plannedCount: 1, missingResultCount: 1, storedResultCount: 0 });
   expect((await analytics.getProjectAnalytics(actor, project.id, { period: 'day', date: day })).plannedCount).toBe(0);
 } finally { release(); await pending.catch(() => {}); spy.mockRestore(); }
});
it('includes every due task beyond a UI page and excludes superseded scores from the average', async () => {
 const { actor, project } = await fixture();
 const measured = await task(actor, project.id);
 const done = await completeTask(actor, measured.id, measured.version, `${day}T11:00:00Z`);
 await updateTask(actor, measured.id, { version: done.version, dueAt: `${day}T05:00:00Z` });
 // The new timing component is 76 (six hours late); completion stays 100.
 await getDb().insert(tasks).values(Array.from({ length: 51 }, () => ({ id: randomUUID(), workspaceId: actor.workspaceId, projectId: project.id, title: 'Bulk due fixture', dueAt: new Date(`${day}T12:00:00Z`) })));
 const summary = await analytics.getProjectAnalytics(actor, project.id, { period: 'day', date: day });
 expect(summary).toMatchObject({ plannedCount: 52, completedCount: 1, onTimeCount: 0, lateCount: 1, rescheduledCount: 1, scoredCount: 1, storedResultCount: 1, missingResultCount: 51 });
 const rows = await getDb().select().from(trackingResults).where(eq(trackingResults.taskId, measured.id));
 expect(rows).toHaveLength(2);
 expect(summary.averageScore).toBe(Number(rows.find((r) => !r.supersededAt)!.score));
 expect(summary.averageScore).toBeLessThan(100);
});
