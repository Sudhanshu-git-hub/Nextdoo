import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import {
  recurrenceRules,
  syncChanges,
  tags,
  taskOccurrences,
  tasks,
  trackingCorrections,
  trackingEvents,
  trackingResults,
  userPreferences,
} from '@nextdoo/db';
import { requireTestDatabase } from '../../../../../tests/database';
import { getDb } from '../db';
import { registerUser } from './accounts';
import { completeTask, createTask, updateTask } from './tasks';
import { listSuggestions } from './suggestions';

/**
 * M8-i2 advisory suggestions — service-level guarantees: read-only (zero row
 * mutation), workspace-scoped, corrections-filtered, deterministic,
 * §7.9 toggle honored, and the single permitted mutation (S1 confirmation)
 * flows through the normal versioned task PATCH.
 */
await requireTestDatabase();

const db = getDb();
const DAY = '2026-09-08'; // Tuesday in a Monday-start week; fixed window, no clock drift.

async function fixture() {
  const user = await registerUser({ email: `sugg-${randomUUID()}@test.local`, passwordHash: 'test', name: null, timeZone: 'UTC' });
  return { user, actor: { userId: user.id, workspaceId: user.workspaceId } as const };
}

async function makeTag(actor: { workspaceId: string }, name: string) {
  const [row] = await db.insert(tags).values({ id: randomUUID(), workspaceId: actor.workspaceId, name }).returning();
  if (!row) throw new Error('tag insert failed');
  return row;
}

async function measuredTask(actor: { userId: string; workspaceId: string }, opts: { title: string; estimate: number; actual: number; tagId?: string }) {
  const task = await createTask(actor, {
    workspaceId: actor.workspaceId,
    title: opts.title,
    priority: 'NONE',
    tagIds: opts.tagId ? [opts.tagId] : [],
    dueAt: `${DAY}T12:00:00Z`,
    estimateMinutes: opts.estimate,
  });
  await db.update(tasks).set({ actualMinutes: opts.actual }).where(eq(tasks.id, task.id));
  await completeTask(actor, task.id, task.version, `${DAY}T12:30:00Z`);
  return task;
}

async function snapshotPlanningTables(actor: { workspaceId: string; userId: string }) {
  const ws = actor.workspaceId;
  const count = (table: string, scope: ReturnType<typeof sql>) =>
    db.select({ n: sql<number>`count(*)` }).from(sql.raw(table)).where(scope);
  return {
    tasks: await count('tasks', sql`workspace_id=${ws}`),
    projects: await count('projects', sql`workspace_id=${ws}`),
    tags: await count('tags', sql`workspace_id=${ws}`),
    taskTags: await count('task_tags', sql`task_id in (select id from tasks where workspace_id=${ws})`),
    trackingResults: await count('tracking_results', sql`workspace_id=${ws}`),
    trackingEvents: await count('tracking_events', sql`workspace_id=${ws}`),
    trackingCorrections: await count('tracking_corrections', sql`workspace_id=${ws}`),
    recurrenceRules: await count('recurrence_rules', sql`workspace_id=${ws}`),
    taskOccurrences: await count('task_occurrences', sql`recurrence_rule_id in (select id from recurrence_rules where workspace_id=${ws})`),
    userPreferences: await count('user_preferences', sql`user_id=${actor.userId}`),
    auditLogs: await count('audit_logs', sql`actor_id=${actor.userId}`),
    syncChanges: await count('sync_changes', sql`workspace_id=${ws}`),
  };
}

it('generates all five advisory themes from existing data with exact actions and evidence', async () => {
  const { actor } = await fixture();

  // S1: tag 'Deep' measured +50% over (n=2); one active tagged task at 60 min.
  const deep = await makeTag(actor, 'Deep');
  await measuredTask(actor, { title: 'Deep one', estimate: 60, actual: 90, tagId: deep.id });
  await measuredTask(actor, { title: 'Deep two', estimate: 60, actual: 90, tagId: deep.id });
  const candidate = await createTask(actor, {
    workspaceId: actor.workspaceId, title: 'Deep three', priority: 'NONE', tagIds: [deep.id], dueAt: `${DAY}T12:00:00Z`, estimateMinutes: 60,
  });

  // S2: active load 60 + 500 = 560 > 480 (default 09:00–17:00 workday).
  await createTask(actor, { workspaceId: actor.workspaceId, title: 'Heavy load', priority: 'NONE', tagIds: [], dueAt: `${DAY}T13:00:00Z`, estimateMinutes: 500 });

  // S3: series with 3 measured occurrences, each completed 45 min after due.
  const template = await createTask(actor, { workspaceId: actor.workspaceId, title: 'Standup follow-up', priority: 'NONE', tagIds: [], dueAt: `${DAY}T09:30:00Z` });
  const ruleId = randomUUID();
  await db.insert(recurrenceRules).values({
    id: ruleId,
    workspaceId: actor.workspaceId,
    templateTaskId: template.id,
    rule: { freq: 'WEEKLY', byWeekday: [2], timeZone: 'UTC' },
    timeZone: 'UTC',
    seriesStart: new Date(`${DAY}T09:30:00Z`),
    nextRunAt: new Date(`${DAY}T09:30:00Z`),
    templateSnapshot: { title: 'Standup follow-up' },
  });
  for (let i = 0; i < 3; i++) {
    const due = new Date(`${DAY}T09:30:00Z`).getTime() + i * 3600_000;
    const lateBy = 45 * 60_000;
    const occurrence = await createTask(actor, {
      workspaceId: actor.workspaceId, title: `Standup follow-up #${i}`, priority: 'NONE', tagIds: [], dueAt: new Date(due).toISOString(), estimateMinutes: 30,
    });
    await db.update(tasks).set({ recurrenceRuleId: ruleId, actualMinutes: 30 }).where(eq(tasks.id, occurrence.id));
    await completeTask(actor, occurrence.id, occurrence.version, new Date(due + lateBy).toISOString());
    await db.insert(taskOccurrences).values({ id: randomUUID(), recurrenceRuleId: ruleId, occurrenceKey: `${ruleId}:${DAY}-${i}`, taskId: occurrence.id, dueAt: new Date(due) });
    await db.insert(trackingResults).values({
      id: randomUUID(),
      workspaceId: actor.workspaceId,
      taskId: occurrence.id,
      occurrenceKey: String(i),
      score: '90',
      outcome: 'LATE',
      components: [{ key: 'recurrence', value: 0.9, weight: 0.25, measured: true, reason: 'completed' }],
      explanation: 'fixture',
      measuredWeight: '0.25',
      calculationVersion: 1,
      inputHash: 'b'.repeat(64),
    });
  }

  // S4: big active task without subtasks. S5: frequently rescheduled active task.
  await createTask(actor, { workspaceId: actor.workspaceId, title: 'Huge migration', priority: 'NONE', tagIds: [], dueAt: `${DAY}T15:00:00Z`, estimateMinutes: 300 });
  const shuffled = await createTask(actor, { workspaceId: actor.workspaceId, title: 'Shuffle', priority: 'NONE', tagIds: [], dueAt: `${DAY}T16:00:00Z` });
  await db.update(tasks).set({ rescheduleCount: 4 }).where(eq(tasks.id, shuffled.id));

  const response = await listSuggestions(actor, { period: 'day', dateKey: DAY });
  const byType = Object.fromEntries(response.suggestions.map((s) => [s.type, s])) as Record<string, (typeof response.suggestions)[number]>;

  expect(response.ruleVersion).toBe(1);
  expect(Object.keys(byType).sort()).toEqual(['S1_ESTIMATE', 'S2_OVERLOAD', 'S3_RECURRING', 'S4_SPLIT', 'S5_REVIEW']);
  expect(byType['S1_ESTIMATE']!.action).toEqual({ kind: 'raise_estimate', taskId: candidate.id, suggestedMinutes: 90, taskVersion: candidate.version });
  expect(byType['S1_ESTIMATE']!.evidence).toEqual({ estimateMinutes: 60, variancePct: 50, taskCount: 2 });
  // Planned load = 60+60+60 (Deep) + 500 (Heavy load) + 90 (3×30 occurrences) + 300 (Huge) = 1070.
  expect(byType['S2_OVERLOAD']!.action).toEqual({ kind: 'open_day', dayKey: DAY });
  expect(byType['S2_OVERLOAD']!.evidence).toEqual({ plannedMinutes: 1070, workdayMinutes: 480, overByMinutes: 590 });
  expect(byType['S3_RECURRING']!.action).toEqual({ kind: 'open_recurrence', recurrenceRuleId: ruleId });
  expect(byType['S3_RECURRING']!.evidence).toMatchObject({ measuredOccurrences: 3, medianLateMinutes: 45 });
  expect(byType['S4_SPLIT']!.target.taskId).toBeDefined();
  expect(byType['S4_SPLIT']!.action.kind).toBe('open_task');
  expect(byType['S5_REVIEW']!.target.taskId).toBe(shuffled.id);
  for (const s of response.suggestions) {
    expect(s.message.length).toBeLessThanOrEqual(200);
    expect(s.ruleVersion).toBe(1);
  }
});

it('is deterministic for identical state and mutates zero rows (read-only guarantee)', async () => {
  const { actor } = await fixture();
  const tag = await makeTag(actor, 'Ops');
  await measuredTask(actor, { title: 'Ops one', estimate: 30, actual: 45, tagId: tag.id });
  await measuredTask(actor, { title: 'Ops two', estimate: 30, actual: 45, tagId: tag.id });
  await createTask(actor, { workspaceId: actor.workspaceId, title: 'Ops three', priority: 'NONE', tagIds: [tag.id], dueAt: `${DAY}T10:00:00Z`, estimateMinutes: 30 });

  const first = await listSuggestions(actor, { period: 'day', dateKey: DAY });
  const afterRead = await snapshotPlanningTables(actor);
  const second = await listSuggestions(actor, { period: 'day', dateKey: DAY });
  const afterSecond = await snapshotPlanningTables(actor);

  expect(second).toEqual(first);
  expect(afterRead).toEqual(afterSecond);
});

it('hides tasks whose latest correction excludes them from analytics (corrections-filtered cohorts)', async () => {
  const { actor } = await fixture();
  const deep = await makeTag(actor, 'Deep');
  const kept = await measuredTask(actor, { title: 'Kept', estimate: 60, actual: 90, tagId: deep.id });
  const excluded = await measuredTask(actor, { title: 'Excluded', estimate: 60, actual: 90, tagId: deep.id });
  const candidate = await createTask(actor, {
    workspaceId: actor.workspaceId, title: 'Deep candidate', priority: 'NONE', tagIds: [deep.id], dueAt: `${DAY}T12:00:00Z`, estimateMinutes: 60,
  });
  const [correction] = await db
    .insert(trackingCorrections)
    .values({
      id: randomUUID(),
      workspaceId: actor.workspaceId,
      taskId: excluded.id,
      actorId: actor.userId,
      kind: 'EXCLUDED_FROM_ANALYTICS',
      payload: { state: 'SET' },
    })
    .returning();
  if (!correction) throw new Error('correction insert failed');

  // Cohort drops to n=1 (<2) → no S1; the excluded task's title never appears.
  const response = await listSuggestions(actor, { period: 'day', dateKey: DAY });
  expect(response.suggestions.filter((s) => s.type === 'S1_ESTIMATE')).toHaveLength(0);
  expect(JSON.stringify(response)).not.toContain('Excluded');
  // …and without the correction the cohort is n=2 and S1 fires for the candidate.
  await db.delete(trackingCorrections).where(eq(trackingCorrections.id, correction.id));
  const again = await listSuggestions(actor, { period: 'day', dateKey: DAY });
  expect(again.suggestions.find((s) => s.type === 'S1_ESTIMATE')?.target.taskId).toBe(candidate.id);
  expect(kept.id).toBeTruthy();
});

it('never returns another workspace’s data (tenant isolation)', async () => {
  const a = await fixture();
  const b = await fixture();
  const tag = await makeTag(a.actor, 'Secret');
  await measuredTask(a.actor, { title: 'Secret alpha', estimate: 60, actual: 120, tagId: tag.id });
  await measuredTask(a.actor, { title: 'Secret beta', estimate: 60, actual: 120, tagId: tag.id });
  await createTask(a.actor, { workspaceId: a.actor.workspaceId, title: 'Secret gamma', priority: 'NONE', tagIds: [tag.id], dueAt: `${DAY}T10:00:00Z`, estimateMinutes: 60 });
  // B's own window is empty.
  const response = await listSuggestions(b.actor, { period: 'day', dateKey: DAY });
  expect(response.suggestions).toHaveLength(0);
  expect(JSON.stringify(response)).not.toContain('Secret');
  // And A still sees its own suggestions.
  const own = await listSuggestions(a.actor, { period: 'day', dateKey: DAY });
  expect(own.suggestions.find((s) => s.type === 'S1_ESTIMATE')?.target.label).toBe('Secret gamma');
});

it('suppresses S2 (and only S2) when the §7.9 overload toggle is set', async () => {
  const { actor } = await fixture();
  await createTask(actor, { workspaceId: actor.workspaceId, title: 'Heavy one', priority: 'NONE', tagIds: [], dueAt: `${DAY}T10:00:00Z`, estimateMinutes: 500 });
  const big = await createTask(actor, { workspaceId: actor.workspaceId, title: 'Heavy two', priority: 'NONE', tagIds: [], dueAt: `${DAY}T11:00:00Z`, estimateMinutes: 300 });

  const on = await listSuggestions(actor, { period: 'day', dateKey: DAY });
  expect(on.suggestions.some((s) => s.type === 'S2_OVERLOAD')).toBe(true);
  expect(on.suggestions.some((s) => s.type === 'S4_SPLIT')).toBe(true);

  await db.insert(userPreferences).values({ userId: actor.userId, key: 'disableOverloadWarnings', value: true });
  const off = await listSuggestions(actor, { period: 'day', dateKey: DAY });
  expect(off.suggestions.filter((s) => s.type === 'S2_OVERLOAD')).toHaveLength(0);
  expect(off.suggestions.some((s) => s.type === 'S4_SPLIT')).toBe(true);
  expect(big.id).toBeTruthy();
});

it('S1 confirmation is the only mutation and it flows through the normal versioned task update path', async () => {
  const { actor } = await fixture();
  const tag = await makeTag(actor, 'Deep');
  await measuredTask(actor, { title: 'Deep one', estimate: 60, actual: 90, tagId: tag.id });
  await measuredTask(actor, { title: 'Deep two', estimate: 60, actual: 90, tagId: tag.id });
  const candidate = await createTask(actor, {
    workspaceId: actor.workspaceId, title: 'Deep three', priority: 'NONE', tagIds: [tag.id], dueAt: `${DAY}T12:00:00Z`, estimateMinutes: 60,
  });

  const response = await listSuggestions(actor, { period: 'day', dateKey: DAY });
  const s1 = response.suggestions.find((s) => s.type === 'S1_ESTIMATE')!;
  expect(s1.action.kind).toBe('raise_estimate');

  // The user explicitly confirms: normal versioned PATCH, nothing else touched.
  const updated = await updateTask(actor, candidate.id, {
    estimateMinutes: (s1.action as { suggestedMinutes: number }).suggestedMinutes,
    version: (s1.action as { taskVersion: number }).taskVersion,
  });
  expect(updated.estimateMinutes).toBe(90);
  expect(updated.version).toBe(candidate.version + 1);

  const [event] = await db
    .select()
    .from(trackingEvents)
    .where(and(eq(trackingEvents.workspaceId, actor.workspaceId), eq(trackingEvents.taskId, candidate.id), eq(trackingEvents.type, 'ESTIMATE_CHANGED')))
    .orderBy(sql`created_at desc`);
  expect(event).toMatchObject({ payload: { from: 60, to: 90 } });

  // The change went through the normal sync pipeline (no bespoke suggestion write).
  const [sync] = await db
    .select({ operation: syncChanges.operation })
    .from(syncChanges)
    .where(and(eq(syncChanges.workspaceId, actor.workspaceId), eq(syncChanges.entityId, candidate.id)))
    .orderBy(sql`created_at desc`);
  expect(sync?.operation).toBe('update');
});

it('rejects impossible dateKeys and never leaks data outside the window', async () => {
  const { actor } = await fixture();
  await expect(listSuggestions(actor, { period: 'day', dateKey: '2026-02-30' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

  // A frequently-rescheduled task due far outside the window must not surface.
  const outside = await createTask(actor, { workspaceId: actor.workspaceId, title: 'Future shuffle', priority: 'NONE', tagIds: [], dueAt: '2027-01-01T09:00:00Z' });
  await db.update(tasks).set({ rescheduleCount: 9 }).where(eq(tasks.id, outside.id));
  const response = await listSuggestions(actor, { period: 'day', dateKey: DAY });
  expect(JSON.stringify(response)).not.toContain('Future shuffle');
});

it('treats Unmeasured actuals as unknown, never as zero (no fabricated cohorts)', async () => {
  const { actor } = await fixture();
  const tag = await makeTag(actor, 'T');
  // Two "measured-looking" tasks, but one has no tracked time at all.
  const unmeasured = await createTask(actor, {
    workspaceId: actor.workspaceId, title: 'No timer time', priority: 'NONE', tagIds: [tag.id], dueAt: `${DAY}T10:00:00Z`, estimateMinutes: 60,
  });
  await completeTask(actor, unmeasured.id, unmeasured.version, `${DAY}T11:00:00Z`);
  await measuredTask(actor, { title: 'Measured', estimate: 60, actual: 90, tagId: tag.id });
  const candidate = await createTask(actor, {
    workspaceId: actor.workspaceId, title: 'Candidate', priority: 'NONE', tagIds: [tag.id], dueAt: `${DAY}T12:00:00Z`, estimateMinutes: 60,
  });

  const response = await listSuggestions(actor, { period: 'day', dateKey: DAY });
  // Cohort is n=1 (the unmeasured task never counts) → S1 must not fire.
  expect(response.suggestions.filter((s) => s.type === 'S1_ESTIMATE')).toHaveLength(0);
  // The unmeasured task's zero actual never triggers S4.
  expect(response.suggestions.filter((s) => s.type === 'S4_SPLIT' && s.target.taskId === unmeasured.id)).toHaveLength(0);
  expect(candidate.id).toBeTruthy();
});

it('workspace-scoped reads fail closed for unknown workspaces (auth-safe service contract)', async () => {
  const { actor } = await fixture();
  await expect(listSuggestions({ userId: actor.userId, workspaceId: randomUUID() }, { period: 'day', dateKey: DAY })).rejects.toMatchObject({ code: 'NOT_FOUND' });
});
