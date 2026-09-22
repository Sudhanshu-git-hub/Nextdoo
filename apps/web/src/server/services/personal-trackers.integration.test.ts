import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { createTrackerSchema, trackerDefinitionSchema } from '@nextdoo/contracts';
import { createTrackerDefinition, trackerDate } from '@nextdoo/core';
import { personalTrackers, personalTrackerEntries, personalTrackerLinks, personalTrackerSources, personalTrackerReports, tasks, trackingEvents, users, auditLogs, syncChanges, ingestPersonalTrackerEvents, schedulePersonalTrackerReports, purgeAccount, openSecret } from '@nextdoo/db';
import { requireTestDatabase } from '../../../../../tests/database';
import { getDb } from '../db';
import { registerUser } from './accounts';
import { createTask, completeTask, reopenTask, deleteTask } from './tasks';
import { createGoal } from './goals';
import { buildExport } from './data-rights';
import * as service from './personal-trackers';

await requireTestDatabase();
afterEach(() => vi.restoreAllMocks());
const today = () => trackerDate(new Date(), 'UTC');
async function fixture(automatic = false) {
  const user = await registerUser({ email: `personal-tracker-${randomUUID()}@test.local`, passwordHash: 'test', name: null, timeZone: 'UTC' });
  const actor = { userId: user.id, workspaceId: user.workspaceId };
  const definition = createTrackerDefinition('Exercise', 'minutes');
  if (automatic) {
    definition.fields[0] = { ...definition.fields[0]!, type: 'checkbox', source: 'task_completed', unit: '' };
    definition.rules = [{ id: 'completed', match: 'all', statusId: 'excellent', conditions: [{ fieldId: 'input', operator: 'eq', value: true }] }];
  }
  const tracker = await service.createTracker(actor, createTrackerSchema.parse({ workspaceId: actor.workspaceId, name: 'Exercise', startDate: '2026-01-01', timeZone: 'UTC', definition }));
  return { actor, tracker };
}
const taskFor = (actor: { userId: string; workspaceId: string }) => createTask(actor, { workspaceId: actor.workspaceId, title: 'Workout', priority: 'NONE', tagIds: [] });
const reportConfig = { smtpConfigured: false, authSecret: 'tracker-test-key', mailFrom: 'test@nextdoo.local', appUrl: 'http://localhost:3100' };

it('persists typed custom columns and settings without silently changing historical definitions', async () => {
  const { actor, tracker } = await fixture();
  const row = await service.createTrackerEntry(actor, tracker.id, { day: '2026-01-01', values: { input: 90 }, notes: 'A real observation' });
  expect(row).toMatchObject({ stars: 5, statusName: 'Excellent' });
  const definition = structuredClone(tracker.definition); definition.columns[0]!.label = 'My day'; definition.statuses[3]!.stars = 4;
  await service.updateTracker(actor, tracker.id, { version: tracker.version, definition, name: 'Daily exercise' });
  const detail = await service.trackerDetail(actor.workspaceId, tracker.id, { from: '2026-01-01', to: '2026-01-10' });
  expect(detail.tracker.name).toBe('Daily exercise'); expect(detail.tracker.definition.columns[0]!.label).toBe('My day');
  expect(detail.entries[0]!.stars).toBe(5); expect(detail.entries[0]!.definition.statuses[3]!.stars).toBe(5);
  expect((await service.createTrackerEntry(actor, tracker.id, { day: '2026-01-02', values: { input: 90 } })).stars).toBe(4);
  await expect(service.createTrackerEntry(actor, tracker.id, { day: '2026-01-03', values: { unknown: 1 } })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  await expect(service.createTrackerEntry(actor, tracker.id, { day: '2026-01-03', values: { input: 'invalid' } })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
});

it('enforces tenant ownership for reads, goals, tasks, entries and direct database references', async () => {
  const a = await fixture(), b = await fixture(), task = await taskFor(b.actor);
  const goal = await createGoal(b.actor, { workspaceId: b.actor.workspaceId, title: 'Private', priority: 'NONE' });
  await expect(service.trackerDetail(a.actor.workspaceId, b.tracker.id, {})).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(service.updateTracker(a.actor, a.tracker.id, { version: 1, goalId: goal.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(service.linkTrackerTask(a.actor, a.tracker.id, { version: 1, taskId: task.id, linked: true })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(getDb().insert(personalTrackerLinks).values({ workspaceId: a.actor.workspaceId, trackerId: a.tracker.id, taskId: task.id })).rejects.toThrow();
  await expect(getDb().insert(personalTrackerEntries).values({ id: randomUUID(), workspaceId: a.actor.workspaceId, trackerId: b.tracker.id, day: today(), definition: a.tracker.definition })).rejects.toThrow();
  const row = await service.createTrackerEntry(b.actor, b.tracker.id, { day: today(), values: { input: 60 } });
  await expect(service.changeTrackerEntry(a.actor, row.id, { day: today(), values: { input: 90 }, version: row.version })).rejects.toMatchObject({ code: 'NOT_FOUND' });
});

it('calculates the exact calendar-day and tracked-day denominators and never inserts missing days', async () => {
  const { actor, tracker } = await fixture();
  for (const day of [1, 2, 3, 5, 6, 9]) await service.createTrackerEntry(actor, tracker.id, { day: `2026-01-0${day}`, values: { input: 90 } });
  const detail = await service.trackerDetail(actor.workspaceId, tracker.id, { from: '2026-01-01', to: '2026-01-10' });
  expect(detail.entries).toHaveLength(6); expect(detail.report).toMatchObject({ totalStars: 30, calendarDays: 10, trackedDays: 6, nonTrackingDays: 4, averageStars: 3, relativeStars: 5 });
  expect((await service.trackerDetail(actor.workspaceId, tracker.id, { from: '2026-02-01', to: '2026-02-10' })).report).toMatchObject({ totalStars: 0, averageStars: 0, relativeStars: null, trackedDays: 0 });
  await expect(service.createTrackerEntry(actor, tracker.id, { day: '2025-12-31', values: { input: 10 } })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  await expect(service.updateTracker(actor, tracker.id, { version: 1, startDate: '2026-01-05' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
});

it('supports correction, version conflicts, deletion and restoration without losing notes', async () => {
  const { actor, tracker } = await fixture();
  const row = await service.createTrackerEntry(actor, tracker.id, { day: today(), values: { input: 30 }, notes: 'Private note' });
  const results = await Promise.allSettled([60, 90].map((input) => service.changeTrackerEntry(actor, row.id, { day: today(), values: { input }, notes: 'Corrected', version: 1 })));
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  const deleted = await service.deleteTrackerEntry(actor, row.id, 2);
  expect((await service.trackerDetail(actor.workspaceId, tracker.id, {})).report.trackedDays).toBe(0);
  await expect(service.createTrackerEntry(actor, tracker.id, { day: today(), values: { input: 10 } })).rejects.toMatchObject({ code: 'RESOURCE_VERSION_CONFLICT' });
  expect(await service.restoreTrackerEntry(actor, row.id, deleted.version)).toMatchObject({ notes: 'Corrected', deletedAt: null });
  expect((await service.trackerDetail(actor.workspaceId, tracker.id, {})).report.trackedDays).toBe(1);
  const audit = await getDb().select().from(auditLogs).where(eq(auditLogs.targetId, row.id));
  expect(JSON.stringify(audit)).not.toContain('Private note'); expect(JSON.stringify(audit)).not.toContain('Corrected');
});

it('consumes durable task completions once under concurrent workers and keeps task history unchanged', async () => {
  const { actor, tracker } = await fixture(true), task = await taskFor(actor);
  const linked = await service.linkTrackerTask(actor, tracker.id, { version: 1, taskId: task.id, linked: true });
  expect((await service.linkTrackerTask(actor, tracker.id, { version: linked.version, taskId: task.id, linked: true })).version).toBe(linked.version);
  const completed = await completeTask(actor, task.id, task.version);
  const before = await getDb().select().from(trackingEvents).where(eq(trackingEvents.taskId, task.id));
  await Promise.all([ingestPersonalTrackerEvents(getDb(), actor.workspaceId), ingestPersonalTrackerEvents(getDb(), actor.workspaceId)]);
  const detail = await service.trackerDetail(actor.workspaceId, tracker.id, {});
  expect(detail.entries).toHaveLength(1); expect(detail.entries[0]).toMatchObject({ stars: 5, notes: null, inputValues: { input: true } });
  expect(detail.entries[0]!.sources).toHaveLength(1);
  expect(await ingestPersonalTrackerEvents(getDb(), actor.workspaceId)).toMatchObject({ processed: 0 });
  expect(await getDb().select().from(trackingEvents).where(eq(trackingEvents.taskId, task.id))).toEqual(before);
  expect((await getDb().select().from(tasks).where(eq(tasks.id, task.id)))[0]!.version).toBe(completed.version);
  const reopened = await reopenTask(actor, task.id, completed.version); await completeTask(actor, task.id, reopened.version);
  await ingestPersonalTrackerEvents(getDb(), actor.workspaceId);
  expect((await service.trackerDetail(actor.workspaceId, tracker.id, {})).report).toMatchObject({ totalStars: 5, trackedDays: 1, linkedTaskCompletions: 1 });
});

it('combines manual and automatic inputs while preserving notes and definition snapshots', async () => {
  const { actor, tracker } = await fixture(), task = await taskFor(actor);
  const definition = structuredClone(tracker.definition); definition.fields.push({ id: 'done', label: 'Task done', type: 'checkbox', source: 'task_completed', unit: '', options: [] });
  const updated = await service.updateTracker(actor, tracker.id, { version: 1, definition });
  await service.linkTrackerTask(actor, tracker.id, { version: updated.version, taskId: task.id, linked: true });
  const manual = await service.createTrackerEntry(actor, tracker.id, { day: today(), values: { input: 60 }, notes: 'Keep this note' });
  await completeTask(actor, task.id, task.version); await ingestPersonalTrackerEvents(getDb(), actor.workspaceId);
  const row = (await service.trackerDetail(actor.workspaceId, tracker.id, {})).entries[0]!;
  expect(row).toMatchObject({ id: manual.id, inputValues: { input: 60, done: true }, notes: 'Keep this note', stars: 3 });
  await expect(service.changeTrackerEntry(actor, row.id, { version: row.version, day: today(), values: { done: false } })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  const changed = await service.changeTrackerEntry(actor, row.id, { version: row.version, day: today(), values: { input: 90 } });
  expect(changed).toMatchObject({ inputValues: { input: 90, done: true }, stars: 5 });
});

it('does not backfill unlinked or paused completions and redacts deleted task titles', async () => {
  const { actor, tracker } = await fixture(true), task = await taskFor(actor);
  const completed = await completeTask(actor, task.id, task.version);
  const linked = await service.linkTrackerTask(actor, tracker.id, { version: 1, taskId: task.id, linked: true });
  expect(await ingestPersonalTrackerEvents(getDb(), actor.workspaceId)).toMatchObject({ processed: 0 });
  const paused = await service.updateTracker(actor, tracker.id, { version: linked.version, state: 'PAUSED' });
  const reopened = await reopenTask(actor, task.id, completed.version); const again = await completeTask(actor, task.id, reopened.version);
  await service.updateTracker(actor, tracker.id, { version: paused.version, state: 'ACTIVE' });
  expect(await ingestPersonalTrackerEvents(getDb(), actor.workspaceId)).toMatchObject({ processed: 0 });
  const active = await reopenTask(actor, task.id, again.version); await completeTask(actor, task.id, active.version);
  await ingestPersonalTrackerEvents(getDb(), actor.workspaceId); await deleteTask(actor, task.id);
  const detail = await service.trackerDetail(actor.workspaceId, tracker.id, {});
  expect(detail.entries[0]!.sources[0]!.title).toBeNull(); expect(detail.links[0]!.title).toBe('Deleted task');
});

it('preserves known duration evidence and marks unavailable duration unmeasured', async () => {
  const { actor, tracker } = await fixture(), task = await taskFor(actor);
  const definition = structuredClone(tracker.definition); definition.fields[0]!.type = 'duration'; definition.fields[0]!.source = 'task_duration';
  const updated = await service.updateTracker(actor, tracker.id, { version: 1, definition });
  await service.linkTrackerTask(actor, tracker.id, { version: updated.version, taskId: task.id, linked: true });
  await getDb().update(tasks).set({ actualMinutes: 60 }).where(eq(tasks.id, task.id));
  const completed = await completeTask(actor, task.id, task.version); await ingestPersonalTrackerEvents(getDb(), actor.workspaceId);
  expect((await service.trackerDetail(actor.workspaceId, tracker.id, {})).entries[0]).toMatchObject({ stars: 3, inputValues: { input: 60 } });
  const reset = await reopenTask(actor, task.id, completed.version); await getDb().update(tasks).set({ actualMinutes: 0 }).where(eq(tasks.id, task.id));
  await completeTask(actor, task.id, reset.version); await ingestPersonalTrackerEvents(getDb(), actor.workspaceId);
  expect((await service.trackerDetail(actor.workspaceId, tracker.id, {})).entries[0]).toMatchObject({ stars: null, inputValues: { input: null } });
});

it('schedules per-tracker monthly reports with exact summaries, durable deduplication and explicit provider blocking', async () => {
  const { actor, tracker } = await fixture();
  const row = await service.createTrackerEntry(actor, tracker.id, { day: '2026-01-01', values: { input: 90 } });
  const task = await taskFor(actor);
  await getDb().insert(personalTrackerSources).values({ id: randomUUID(), workspaceId: actor.workspaceId, trackerId: tracker.id, entryId: row.id, taskId: task.id, taskIdentity: task.id, sourceEventId: randomUUID(), completedAt: new Date('2026-01-01T12:00Z') });
  const enabled = await service.updateTracker(actor, tracker.id, { version: 1, delivery: { enabled: true, channel: 'EMAIL', dayOfMonth: 2, hour: 9, minute: 0 } });
  expect(await schedulePersonalTrackerReports(getDb(), reportConfig, new Date('2026-02-02T08:59:00Z'), actor.workspaceId)).toMatchObject({ queued: 0, blocked: 0 });
  expect(await schedulePersonalTrackerReports(getDb(), reportConfig, new Date('2026-02-02T09:00:00Z'), actor.workspaceId)).toMatchObject({ blocked: 1 });
  const [blocked] = await getDb().select().from(personalTrackerReports).where(eq(personalTrackerReports.trackerId, tracker.id));
  expect(blocked).toMatchObject({ status: 'BLOCKED', reason: 'SMTP_NOT_CONFIGURED', summary: { calendarDays: 31, trackedDays: 1, totalStars: 5, relativeStars: 5, linkedTaskCompletions: 1 } });
  const configured = { ...reportConfig, smtpConfigured: true };
  await Promise.all([1, 2].map(() => schedulePersonalTrackerReports(getDb(), configured, new Date('2026-02-02T09:00:00Z'), actor.workspaceId)));
  const [queued] = await getDb().select().from(personalTrackerReports).where(eq(personalTrackerReports.trackerId, tracker.id));
  expect(queued!.status).toBe('QUEUED');
  const mail = await getDb().execute(sql`select encrypted_message from mail_deliveries where id=${queued!.mailDeliveryId}`);
  expect(openSecret(String(mail[0]!.encrypted_message), reportConfig.authSecret, 'mail')).toContain('Calendar days: 31');
  expect(await schedulePersonalTrackerReports(getDb(), configured, new Date('2026-02-02T09:00:00Z'), actor.workspaceId)).toMatchObject({ queued: 0 });
  await service.updateTracker(actor, tracker.id, { version: enabled.version, delivery: { enabled: true, channel: 'WHATSAPP', dayOfMonth: 1, hour: 9, minute: 0 } });
  expect(await schedulePersonalTrackerReports(getDb(), configured, new Date('2026-03-01T09:00:00Z'), actor.workspaceId)).toMatchObject({ blocked: 1 });
  expect((await getDb().select().from(personalTrackerReports).where(and(eq(personalTrackerReports.trackerId, tracker.id), eq(personalTrackerReports.period, '2026-02'))))[0]).toMatchObject({ status: 'BLOCKED', reason: 'PROVIDER_NOT_IMPLEMENTED' });
});

it('supports archive/restore and exports/purges all owned tracker data', async () => {
  const { actor, tracker } = await fixture(); const foreign = await fixture();
  const goal = await createGoal(actor, { workspaceId: actor.workspaceId, title: 'Learn', priority: 'NONE' });
  const changed = await service.updateTracker(actor, tracker.id, { version: 1, goalId: goal.id, state: 'ARCHIVED' });
  expect((await service.listTrackers(actor.workspaceId, {})).data).toHaveLength(0);
  expect((await service.listTrackers(actor.workspaceId, { includeArchived: true })).data).toHaveLength(1);
  await expect(service.createTrackerEntry(actor, tracker.id, { day: today(), values: {} })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  await service.updateTracker(actor, tracker.id, { version: changed.version, state: 'ACTIVE' });
  await service.createTrackerEntry(actor, tracker.id, { day: today(), values: {} });
  const bundle = await buildExport(actor.userId); expect(bundle.personalTrackers).toHaveLength(1); expect(bundle.personalTrackerEntries).toHaveLength(1);
  expect(JSON.stringify(bundle.personalTrackers)).not.toContain(foreign.tracker.id);
  const cutoff = new Date(Date.now() - 31 * 86400000); await getDb().update(users).set({ deletionRequestedAt: cutoff }).where(eq(users.id, actor.userId));
  expect(await purgeAccount(getDb(), actor.userId, cutoff)).toBe(true);
  for (const table of [personalTrackers, personalTrackerEntries, personalTrackerLinks, personalTrackerSources, personalTrackerReports]) expect(await getDb().select().from(table).where(eq(table.workspaceId, actor.workspaceId))).toHaveLength(0);
  expect(await service.loadTracker(foreign.actor.workspaceId, foreign.tracker.id)).toBeTruthy();
});

it('keeps deletion tombstones during ingestion and restores all retained evidence after task purging', async () => {
  const { actor, tracker } = await fixture(true), task = await taskFor(actor);
  await service.linkTrackerTask(actor, tracker.id, { version: 1, taskId: task.id, linked: true });
  const completed = await completeTask(actor, task.id, task.version); await ingestPersonalTrackerEvents(getDb(), actor.workspaceId);
  const row = (await service.trackerDetail(actor.workspaceId, tracker.id, {})).entries[0]!;
  const deleted = await service.deleteTrackerEntry(actor, row.id, row.version);
  const reopened = await reopenTask(actor, task.id, completed.version); await completeTask(actor, task.id, reopened.version);
  expect(await ingestPersonalTrackerEvents(getDb(), actor.workspaceId)).toMatchObject({ processed: 1 });
  expect((await service.trackerDetail(actor.workspaceId, tracker.id, {})).report.trackedDays).toBe(0);
  await getDb().delete(tasks).where(eq(tasks.id, task.id));
  expect((await service.restoreTrackerEntry(actor, row.id, deleted.version)).stars).toBe(5);
  const detail = await service.trackerDetail(actor.workspaceId, tracker.id, {});
  expect(detail.report).toMatchObject({ trackedDays: 1, linkedTaskCompletions: 1 });
  expect(detail.entries[0]!.sources).toHaveLength(2);
  expect(detail.entries[0]!.sources.every((s) => s.taskId === null && s.title === null)).toBe(true);
});

it('cancels pending monthly mail on disable and reflects completed worker delivery states', async () => {
  const { actor, tracker } = await fixture();
  const delivery = { enabled: true, channel: 'EMAIL' as const, dayOfMonth: 1, hour: 0, minute: 0 };
  const enabled = await service.updateTracker(actor, tracker.id, { version: 1, delivery });
  const config = { ...reportConfig, smtpConfigured: true };
  await schedulePersonalTrackerReports(getDb(), config, new Date('2026-02-01T00:00Z'), actor.workspaceId);
  const [queued] = await getDb().select().from(personalTrackerReports).where(eq(personalTrackerReports.trackerId, tracker.id));
  const disabled = await service.updateTracker(actor, tracker.id, { version: enabled.version, delivery: { ...delivery, enabled: false } });
  const mail = await getDb().execute(sql`select status,encrypted_message from mail_deliveries where id=${queued!.mailDeliveryId}`);
  expect(mail[0]).toMatchObject({ status: 'EXPIRED', encrypted_message: '' });
  await service.updateTracker(actor, tracker.id, { version: disabled.version, delivery });
  await schedulePersonalTrackerReports(getDb(), config, new Date('2026-03-01T00:00Z'), actor.workspaceId);
  const [next] = await getDb().select().from(personalTrackerReports).where(and(eq(personalTrackerReports.trackerId, tracker.id), eq(personalTrackerReports.period, '2026-02')));
  await getDb().execute(sql`update mail_deliveries set status='SENT' where id=${next!.mailDeliveryId}`);
  await schedulePersonalTrackerReports(getDb(), config, new Date('2026-03-01T00:00Z'), actor.workspaceId);
  expect((await service.trackerDetail(actor.workspaceId, tracker.id, {})).deliveries[0]!.status).toBe('SENT');
});

it('paginates tracker lists and record tables without narrowing the report totals', async () => {
  const { actor, tracker } = await fixture();
  for (let i = 0; i < 2; i++) await service.createTracker(actor, createTrackerSchema.parse({ workspaceId: actor.workspaceId, name: `Tracker ${i}`, startDate: '2026-01-01', timeZone: 'UTC', definition: createTrackerDefinition() }));
  const first = await service.listTrackers(actor.workspaceId, { limit: 2 });
  const next = await service.listTrackers(actor.workspaceId, { limit: 2, after: first.nextCursor });
  expect(new Set([...first.data, ...next.data].map((t) => t.id)).size).toBe(3); expect(next.nextCursor).toBeNull();
  for (let i = 0; i < 51; i++) await service.createTrackerEntry(actor, tracker.id, { day: new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10), values: { input: 90 } });
  const a = await service.trackerDetail(actor.workspaceId, tracker.id, {});
  const b = await service.trackerDetail(actor.workspaceId, tracker.id, { after: a.nextCursor });
  expect(a.entries).toHaveLength(50); expect(b.entries).toHaveLength(1);
  expect(new Set([...a.entries, ...b.entries].map((r) => r.id)).size).toBe(51);
  expect(a.report.totalStars).toBe(255); expect(b.report.totalStars).toBe(255);
});

it('rolls back the record and its source receipt if scoring cannot commit', async () => {
  const { actor, tracker } = await fixture(true), task = await taskFor(actor);
  await service.linkTrackerTask(actor, tracker.id, { version: 1, taskId: task.id, linked: true }); await completeTask(actor, task.id, task.version);
  const tableName = `tracker_failure_${randomUUID().replaceAll('-', '')}`;
  await getDb().execute(sql.raw(`CREATE FUNCTION ${tableName}() RETURNS trigger AS $$ BEGIN IF NEW.workspace_id='${actor.workspaceId}'::uuid AND NEW.target_type='tracker_entry' THEN RAISE EXCEPTION 'injected'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql; CREATE TRIGGER ${tableName} BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION ${tableName}();`));
  try {
    expect(await ingestPersonalTrackerEvents(getDb(), actor.workspaceId)).toMatchObject({ processed: 0, deferred: 1 });
    expect(await getDb().select().from(personalTrackerSources).where(eq(personalTrackerSources.trackerId, tracker.id))).toHaveLength(0);
    expect(await getDb().select().from(personalTrackerEntries).where(eq(personalTrackerEntries.trackerId, tracker.id))).toHaveLength(0);
  } finally { await getDb().execute(sql.raw(`DROP TRIGGER ${tableName} ON audit_logs; DROP FUNCTION ${tableName}();`)); }
  expect(await ingestPersonalTrackerEvents(getDb(), actor.workspaceId)).toMatchObject({ processed: 1 });
  const row = (await service.trackerDetail(actor.workspaceId, tracker.id, {})).entries[0]!;
  expect(await getDb().select().from(syncChanges).where(and(eq(syncChanges.entityId, row.id), eq(syncChanges.entityType, 'tracker_entry')))).toHaveLength(1);
  expect(trackerDefinitionSchema.safeParse(tracker.definition).success).toBe(true);
});
