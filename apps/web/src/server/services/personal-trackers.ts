import { and, asc, eq, gt, gte, isNull, lte, ne, sql } from 'drizzle-orm';
import { AppError, createTrackerSchema, updateTrackerSchema, trackerEntrySchema, updateTrackerEntrySchema, trackerEntryVersionSchema, trackerTaskLinkSchema, trackerListSchema, trackerRangeSchema, uuid, notFound, versionConflict, type CreateTrackerInput, type UpdateTrackerInput, type TrackerEntryInput } from '@nextdoo/contracts';
import { personalTrackers as trackers, personalTrackerEntries as entries, personalTrackerLinks as links, personalTrackerSources as sources, personalTrackerReports as reports, tasks, recordPersonalTrackerChange, personalTrackerScore } from '@nextdoo/db';
import { personalTrackerReport, trackerDate, validateTrackerValues, personalTrackerTemplates, trackerSourceValues } from '@nextdoo/core';
import { getDb, withTransaction } from '../db';
import { newId } from '../ids';
import { withWorkspaceTransaction } from './transactions';
import { loadGoal, type GoalActor } from './goals';
import { loadTask } from './tasks';

const serialise = <T>(row: T): T => JSON.parse(JSON.stringify(row));
export async function loadTracker(workspaceId: string, id: string) {
  uuid.parse(id); const [row] = await getDb().select().from(trackers).where(and(eq(trackers.workspaceId, workspaceId), eq(trackers.id, id)));
  if (!row) throw notFound('tracker', id); return row;
}
export async function createTracker(actor: GoalActor, input: CreateTrackerInput) {
  input = createTrackerSchema.parse(input);
  if (input.workspaceId !== actor.workspaceId) throw new AppError('FORBIDDEN', 'Choose your current workspace.');
  return withWorkspaceTransaction(actor.workspaceId, async (db) => {
    if (input.goalId) await loadGoal(actor.workspaceId, input.goalId);
    const [row] = await db.insert(trackers).values({ ...input, id: newId() }).returning();
    await recordPersonalTrackerChange(db, actor.workspaceId, 'tracker', row!, 'created', actor.userId, actor.requestId); return serialise(row!);
  });
}
export async function updateTracker(actor: GoalActor, id: string, input: UpdateTrackerInput) {
  input = updateTrackerSchema.parse(input);
  return withWorkspaceTransaction(actor.workspaceId, async (db) => {
    const current = await loadTracker(actor.workspaceId, id);
    if (current.version !== input.version) throw versionConflict('tracker', id);
    if (input.goalId) await loadGoal(actor.workspaceId, input.goalId);
    if (input.startDate && input.startDate > current.startDate) {
      const [earliest] = await db.select({ day: sql<string>`min(${entries.day})` }).from(entries).where(eq(entries.trackerId, id));
      if (earliest?.day && earliest.day < input.startDate) throw new AppError('VALIDATION_FAILED', 'Start date cannot exclude existing tracking history.');
    }
    const [row] = await db.update(trackers).set({ ...input, ...(input.state === 'ACTIVE' && current.state !== 'ACTIVE' ? { ingestAfter: new Date() } : {}), version: current.version + 1, updatedAt: new Date() }).where(and(eq(trackers.id, id), eq(trackers.workspaceId, actor.workspaceId))).returning();
    if ((input.state && input.state !== 'ACTIVE') || input.delivery?.enabled === false) {
      await db.execute(sql`with canceled as (update mail_deliveries m set status='EXPIRED',encrypted_message='',last_error='TRACKER_DELIVERY_DISABLED'
        where m.status='PENDING' and m.id in (select r.mail_delivery_id from personal_tracker_reports r where r.tracker_id=${id} and r.workspace_id=${actor.workspaceId} and r.status='QUEUED') returning m.id)
        update personal_tracker_reports r set status='EXPIRED',reason='TRACKER_DELIVERY_DISABLED',updated_at=now() from canceled c where r.mail_delivery_id=c.id`);
    }
    await recordPersonalTrackerChange(db, actor.workspaceId, 'tracker', row!, 'updated', actor.userId, actor.requestId); return serialise(row!);
  });
}
export async function listTrackers(workspaceId: string, query: unknown) {
  const input = trackerListSchema.parse(query);
  const rows = await getDb().select().from(trackers).where(and(eq(trackers.workspaceId, workspaceId), input.includeArchived ? undefined : ne(trackers.state, 'ARCHIVED'), input.after ? gt(trackers.id, input.after) : undefined)).orderBy(asc(trackers.id)).limit(input.limit + 1);
  return { data: rows.slice(0, input.limit).map(serialise), nextCursor: rows.length > input.limit ? rows[input.limit - 1]!.id : null };
}
export async function linkTrackerTask(actor: GoalActor, id: string, data: unknown) {
  const input = trackerTaskLinkSchema.parse(data);
  return withWorkspaceTransaction(actor.workspaceId, async (db) => {
    const tracker = await loadTracker(actor.workspaceId, id);
    if (tracker.version !== input.version) throw versionConflict('tracker', id);
    if (input.linked) { if (tracker.state !== 'ACTIVE') throw new AppError('VALIDATION_FAILED', 'Activate the tracker before linking tasks.'); await loadTask(actor.workspaceId, input.taskId); }
    const changed = input.linked ? await db.insert(links).values({ workspaceId: actor.workspaceId, trackerId: id, taskId: input.taskId }).onConflictDoNothing().returning()
      : await db.delete(links).where(and(eq(links.trackerId, id), eq(links.workspaceId, actor.workspaceId), eq(links.taskId, input.taskId))).returning();
    if (!changed.length) return serialise(tracker);
    const [row] = await db.update(trackers).set({ version: tracker.version + 1, updatedAt: new Date() }).where(eq(trackers.id, id)).returning();
    await recordPersonalTrackerChange(db, actor.workspaceId, 'tracker', { ...row!, relation: { taskId: input.taskId, linked: input.linked } }, 'updated', actor.userId, actor.requestId); return serialise(row!);
  });
}
function validateDay(tracker: Awaited<ReturnType<typeof loadTracker>>, day: string) {
  if (tracker.state !== 'ACTIVE') throw new AppError('VALIDATION_FAILED', 'Activate this tracker before editing records.');
  if (day < tracker.startDate || day > trackerDate(new Date(), tracker.timeZone)) throw new AppError('VALIDATION_FAILED', 'Choose a tracking day from the start date through today.');
}
function checkValues(definition: Awaited<ReturnType<typeof loadTracker>>['definition'], values: TrackerEntryInput['values']) {
  try { validateTrackerValues(definition, values, true); } catch (error) { throw new AppError('VALIDATION_FAILED', error instanceof Error ? error.message : 'Invalid observations'); }
}
export async function createTrackerEntry(actor: GoalActor, trackerId: string, input: TrackerEntryInput) {
  input = trackerEntrySchema.parse(input);
  return withWorkspaceTransaction(actor.workspaceId, async (db) => {
    const tracker = await loadTracker(actor.workspaceId, trackerId); validateDay(tracker, input.day); checkValues(tracker.definition, input.values);
    const [prior] = await db.select().from(entries).where(and(eq(entries.trackerId, trackerId), eq(entries.day, input.day)));
    if (prior) throw new AppError('RESOURCE_VERSION_CONFLICT', 'This day already has a record. Edit or restore that record instead.');
    const [row] = await db.insert(entries).values({ id: newId(), workspaceId: actor.workspaceId, trackerId, day: input.day, definition: tracker.definition, inputValues: input.values, notes: input.notes ?? null, ...personalTrackerScore(tracker.definition, input.values) }).returning();
    await recordPersonalTrackerChange(db, actor.workspaceId, 'tracker_entry', row!, 'created', actor.userId, actor.requestId); return serialise(row!);
  });
}
export async function changeTrackerEntry(actor: GoalActor, id: string, input: TrackerEntryInput & { version: number }) {
  input = updateTrackerEntrySchema.parse(input); uuid.parse(id);
  return withWorkspaceTransaction(actor.workspaceId, async (db) => {
    const [current] = await db.select().from(entries).where(and(eq(entries.id, id), eq(entries.workspaceId, actor.workspaceId), isNull(entries.deletedAt)));
    if (!current) throw notFound('tracker record', id);
    if (current.version !== input.version) throw versionConflict('tracker record', id);
    const tracker = await loadTracker(actor.workspaceId, current.trackerId); validateDay(tracker, input.day); checkValues(current.definition, input.values);
    if (input.day !== current.day) throw new AppError('VALIDATION_FAILED', 'Record dates are fixed to preserve source identity. Delete and enter the correct day.');
    const automatic = Object.fromEntries(Object.entries(current.inputValues).filter(([field]) => current.definition.fields.find((f) => f.id === field)?.source !== 'manual'));
    const inputValues = { ...automatic, ...input.values };
    const [row] = await db.update(entries).set({ inputValues, notes: input.notes ?? null, ...personalTrackerScore(current.definition, inputValues), version: current.version + 1, updatedAt: new Date() }).where(eq(entries.id, id)).returning();
    await recordPersonalTrackerChange(db, actor.workspaceId, 'tracker_entry', row!, 'updated', actor.userId, actor.requestId); return serialise(row!);
  });
}
export async function deleteTrackerEntry(actor: GoalActor, id: string, version: number) {
  uuid.parse(id); trackerEntryVersionSchema.parse({ version });
  return withWorkspaceTransaction(actor.workspaceId, async (db) => {
    const [current] = await db.select().from(entries).where(and(eq(entries.id, id), eq(entries.workspaceId, actor.workspaceId), isNull(entries.deletedAt)));
    if (!current) throw notFound('tracker record', id); if (current.version !== version) throw versionConflict('tracker record', id);
    const [row] = await db.update(entries).set({ deletedAt: new Date(), version: version + 1, updatedAt: new Date() }).where(eq(entries.id, id)).returning();
    await recordPersonalTrackerChange(db, actor.workspaceId, 'tracker_entry', row!, 'deleted', actor.userId, actor.requestId); return { id, version: row!.version };
  });
}
export async function restoreTrackerEntry(actor: GoalActor, id: string, version: number) {
  uuid.parse(id); trackerEntryVersionSchema.parse({ version });
  return withWorkspaceTransaction(actor.workspaceId, async (db) => {
    const [current] = await db.select().from(entries).where(and(eq(entries.id, id), eq(entries.workspaceId, actor.workspaceId)));
    if (!current) throw notFound('tracker record', id); if (current.version !== version) throw versionConflict('tracker record', id);
    const tracker = await loadTracker(actor.workspaceId, current.trackerId); validateDay(tracker, current.day);
    if (!current.deletedAt) return serialise(current);
    const evidence = await db.select().from(sources).where(eq(sources.entryId, id));
    const inputValues = { ...current.inputValues, ...trackerSourceValues(current.definition, evidence) };
    const [row] = await db.update(entries).set({ deletedAt: null, inputValues, ...personalTrackerScore(current.definition, inputValues), version: version + 1, updatedAt: new Date() }).where(eq(entries.id, id)).returning();
    await recordPersonalTrackerChange(db, actor.workspaceId, 'tracker_entry', row!, 'updated', actor.userId, actor.requestId); return serialise(row!);
  });
}
export async function trackerDetail(workspaceId: string, id: string, query: unknown) {
  return withTransaction(async (db) => {
    const tracker = await loadTracker(workspaceId, id), today = trackerDate(new Date(), tracker.timeZone);
    const input = trackerRangeSchema.parse({ from: tracker.startDate > today ? today : tracker.startDate, to: today, ...(query && typeof query === 'object' ? query : {}) });
    const to = input.to > today ? today : input.to;
    const scope = and(eq(entries.workspaceId, workspaceId), eq(entries.trackerId, id), gte(entries.day, input.from), lte(entries.day, to));
    const rows = await db.select().from(entries).where(and(scope, input.after ? gt(entries.id, input.after) : undefined)).orderBy(asc(entries.id)).limit(51);
    const scored = await db.select({ day: entries.day, stars: entries.stars, statusName: entries.statusName, sourceCount: sql<number>`(select count(distinct s.task_identity)::int from personal_tracker_sources s where s.entry_id=personal_tracker_entries.id)` }).from(entries).where(and(scope, isNull(entries.deletedAt)));
    const taskLinks = await db.select({ taskId: links.taskId, title: tasks.title, status: tasks.status }).from(links).innerJoin(tasks, and(eq(tasks.id, links.taskId), eq(tasks.workspaceId, workspaceId))).where(and(eq(links.trackerId, id), eq(links.workspaceId, workspaceId)));
    const evidence = await db.select({ source: sources, title: tasks.title, status: tasks.status }).from(sources).leftJoin(tasks, and(eq(tasks.id, sources.taskId), eq(tasks.workspaceId, workspaceId))).where(and(eq(sources.trackerId, id), eq(sources.workspaceId, workspaceId), rows.length ? sql`${sources.entryId} in (${sql.join(rows.slice(0, 50).map((r) => sql`${r.id}::uuid`), sql`,`)})` : sql`false`));
    const deliveries = await db.select().from(reports).where(and(eq(reports.trackerId, id), eq(reports.workspaceId, workspaceId))).orderBy(sql`${reports.period} desc`).limit(12);
    return serialise({ tracker, goal: tracker.goalId ? await loadGoal(workspaceId, tracker.goalId) : null,
      entries: rows.slice(0, 50).map((row) => ({ ...row, sources: evidence.filter((s) => s.source.entryId === row.id).map((s) => ({ ...s.source, title: s.status === 'DELETED' ? null : s.title, taskId: s.status === 'DELETED' ? null : s.source.taskId })) })),
      nextCursor: rows.length > 50 ? rows[49]!.id : null,
      links: taskLinks.map((link) => ({ ...link, title: link.status === 'DELETED' ? 'Deleted task' : link.title })),
      report: personalTrackerReport(tracker.startDate, input.from, to, scored), deliveries,
      deliveryCapabilities: { EMAIL: Boolean(process.env.SMTP_URL), WHATSAPP: false, TELEGRAM: false },
    });
  }, { isolationLevel: 'repeatable read' });
}
export const trackerTemplates = () => personalTrackerTemplates();
