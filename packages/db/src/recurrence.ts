import { randomUUID } from 'node:crypto';
import { and, asc, count, eq, inArray, isNotNull, isNull, lt, lte, sql } from 'drizzle-orm';
import { createTaskSchema, limitsFor, recurrenceRuleSchema } from '@nextdoo/contracts';
import { generateOccurrences } from '@nextdoo/core';
import type { Database } from './client';
import { recurrenceRules, taskOccurrences, tasks, taskTags, tags, workspaces, users, projects, sections, syncChanges, outbox, auditLogs, trackingEvents } from './schema';
import { readEffectivePlan } from './effective-plan';
import { serialiseTaskRecord } from './task-record';
const DAY = 86400000;

/** Shared by web commands and the standalone worker; never imports app process internals. */
export async function generateRecurrenceInTransaction(db: Database, ruleId: string, now = new Date(), dueOnly = false) {
  const [source] = await db.select().from(recurrenceRules).where(eq(recurrenceRules.id, ruleId));
  if (!source) return { generated: 0 };
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'workspace:' + source.workspaceId}, 0))`);
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'recurrence:' + ruleId}, 0))`);
  const [series] = await db.select().from(recurrenceRules).where(eq(recurrenceRules.id, ruleId));
  if (!series?.active || !series.templateSnapshot || dueOnly && (series.nextRunAt > now || series.failureCount >= 5)) return { generated: 0 };
  const rule = recurrenceRuleSchema.parse(series.rule);
  const template = createTaskSchema.parse(series.templateSnapshot);
  if (template.workspaceId !== series.workspaceId) throw new Error('Invalid recurrence workspace');
  const [workspace] = await db.select().from(workspaces).where(and(eq(workspaces.id, series.workspaceId), isNull(workspaces.deletedAt)));
  const [owner] = workspace ? await db.select().from(users).where(and(eq(users.id, workspace.ownerId), isNull(users.deletionRequestedAt), isNull(users.deletedAt))).for('share') : [];
  if (!workspace || !owner || owner.status !== 'ACTIVE') {
    await db.update(recurrenceRules).set({ generationError: 'OWNER_UNAVAILABLE', nextRunAt: new Date(now.getTime() + 15 * 60000) }).where(eq(recurrenceRules.id, ruleId));
    return { generated: 0 };
  }
  let error: string | null = null;
  if (template.projectId && !(await db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, template.projectId), eq(projects.workspaceId, workspace.id), eq(projects.status, 'ACTIVE'), isNull(projects.deletedAt)))).length) error = 'PROJECT_UNAVAILABLE';
  if (template.sectionId && !(await db.select({ id: sections.id }).from(sections).where(and(eq(sections.id, template.sectionId), eq(sections.projectId, template.projectId ?? randomUUID()), eq(sections.workspaceId, workspace.id), isNull(sections.deletedAt)))).length) error = 'SECTION_UNAVAILABLE';
  if (template.parentTaskId && !(await db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.id, template.parentTaskId), eq(tasks.workspaceId, workspace.id), isNull(tasks.deletedAt)))).length) error = 'PARENT_UNAVAILABLE';
  if (template.tagIds.length && (await db.select({ id: tags.id }).from(tags).where(and(inArray(tags.id, template.tagIds), eq(tags.workspaceId, workspace.id)))).length !== template.tagIds.length) error = 'TAG_UNAVAILABLE';
  let generated = 0;
  if (!error) {
    const existing = await db.select().from(taskOccurrences).where(eq(taskOccurrences.recurrenceRuleId, ruleId));
    const future = existing.filter((o) => o.dueAt > now).length;
    const [usage] = await db.select({ n: count() }).from(tasks).where(and(eq(tasks.workspaceId, workspace.id), eq(tasks.status, 'ACTIVE'), isNull(tasks.deletedAt)));
    const limit = limitsFor(await readEffectivePlan(db, owner.id)).activeTasks;
    let capacity = limit === null ? 50 : Math.max(0, limit - (usage?.n ?? 0));
    const occurrences = generateOccurrences({ ruleId, rule, seriesStart: series.seriesStart,
      after: new Date((series.lastGeneratedAt ?? series.seriesStart).getTime() - 1), horizon: new Date(now.getTime() + 60 * DAY),
      maxCount: Math.max(0, 50 - future), existingKeys: new Set(existing.map((o) => o.occurrenceKey)) });
    for (const occurrence of occurrences) {
      if (!capacity) { error = 'ACTIVE_TASK_LIMIT'; break; }
      const id = randomUUID();
      const [task] = await db.insert(tasks).values({ id, workspaceId: workspace.id, title: template.title,
        description: template.description, location: template.location, priority: template.priority, projectId: template.projectId, sectionId: template.sectionId,
        parentTaskId: template.parentTaskId, estimateMinutes: template.estimateMinutes, dueAt: occurrence.dueAt,
        timeZone: rule.timeZone, recurrenceRuleId: ruleId, position: String(now.getTime()) }).returning();
      if (!task) throw new Error('Occurrence task was not created');
      await db.insert(taskOccurrences).values({ id: randomUUID(), recurrenceRuleId: ruleId, taskId: id, occurrenceKey: occurrence.occurrenceKey, dueAt: occurrence.dueAt });
      if (template.tagIds.length) await db.insert(taskTags).values(template.tagIds.map((tagId) => ({ tagId, taskId: id })));
      for (const type of ['TASK_CREATED', 'TASK_PLANNED', 'RECURRENCE_GENERATED'] as const) await db.insert(trackingEvents).values({ id: randomUUID(), workspaceId: workspace.id, taskId: id,
        occurrenceKey: occurrence.occurrenceKey, type, actorId: owner.id, actorKind: 'SYSTEM', occurredAt: now,
        payload: type === 'RECURRENCE_GENERATED' ? { ruleId, occurrenceKey: occurrence.occurrenceKey } : type === 'TASK_PLANNED' ? { dueAt: occurrence.dueAt.toISOString() } : { hasDueDate: true, hasEstimate: template.estimateMinutes != null },
        idempotencyKey: `${occurrence.occurrenceKey}:${type}` });
      await db.insert(syncChanges).values({ workspaceId: workspace.id, entityType: 'task', entityId: id, operation: 'create', version: 1, payload: { ...serialiseTaskRecord(task), tagIds: template.tagIds } });
      await db.insert(outbox).values({ id: randomUUID(), workspaceId: workspace.id, actorId: owner.id, entityType: 'task', entityId: id, eventType: 'recurrence.occurrence_generated', payload: { ruleId, occurrenceKey: occurrence.occurrenceKey } });
      await db.insert(auditLogs).values({ id: randomUUID(), workspaceId: workspace.id, actorId: owner.id, action: 'recurrence.occurrence_generated', targetType: 'task', targetId: id, metadata: { ruleId } });
      await db.update(recurrenceRules).set({ lastGeneratedAt: occurrence.dueAt }).where(eq(recurrenceRules.id, ruleId));
      capacity--; generated++;
    }
  }
  await db.update(recurrenceRules).set({ generationError: error, failureCount: 0, nextRunAt: new Date(now.getTime() + 15 * 60000) }).where(eq(recurrenceRules.id, ruleId));
  return { generated };
}
export function generateRecurrenceBatch(db: Database, ruleId: string, now = new Date(), dueOnly = false) {
  return db.transaction((tx) => generateRecurrenceInTransaction(tx as unknown as Database, ruleId, now, dueOnly));
}

/** Due work is bounded, claimed by workspace/rule locks, and retried at most five times on hard failure. */
export async function runRecurrenceGeneration(db: Database, now = new Date()) {
  const candidates = await db.select().from(recurrenceRules).where(and(eq(recurrenceRules.active, true), isNotNull(recurrenceRules.templateSnapshot), lte(recurrenceRules.nextRunAt, now), lt(recurrenceRules.failureCount, 5))).orderBy(asc(recurrenceRules.nextRunAt), asc(recurrenceRules.id)).limit(25);
  let generated = 0, failed = 0;
  for (const row of candidates) {
    try { generated += (await generateRecurrenceBatch(db, row.id, now, true)).generated; }
    catch {
      const failures = row.failureCount + 1;
      await db.update(recurrenceRules).set({ generationError: 'GENERATION_FAILED', failureCount: failures,
        nextRunAt: new Date(now.getTime() + Math.min(15, 2 ** (failures - 1)) * 60000) }).where(and(eq(recurrenceRules.id, row.id), eq(recurrenceRules.version, row.version), eq(recurrenceRules.failureCount, row.failureCount)));
      failed++;
    }
  }
  return { processed: generated, details: { examined: candidates.length, failed } };
}
