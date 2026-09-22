import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { evaluatePersonalTracker, trackerSourceValues, trackerDate } from '@nextdoo/core';
import { type Database } from './client';
import { personalTrackers, personalTrackerEntries, personalTrackerSources, personalTrackerLinks, auditLogs, outbox, syncChanges, trackingEvents } from './schema';

export async function recordPersonalTrackerChange(db: Database, workspaceId: string, entity: 'tracker' | 'tracker_entry', row: { id: string; version: number } & Record<string, unknown>, action: 'created' | 'updated' | 'deleted', actorId: string | null, requestId?: string) {
  const eventType = `${entity}.${action}`;
  await db.insert(syncChanges).values({ workspaceId, entityType: entity, entityId: row.id, operation: action === 'created' ? 'create' : action === 'deleted' ? 'delete' : 'update', version: row.version, payload: action === 'deleted' ? { id: row.id } : JSON.parse(JSON.stringify(row)) });
  await db.insert(outbox).values({ id: randomUUID(), workspaceId, actorId, entityType: entity, entityId: row.id, eventType, schemaVersion: 1, payload: { version: row.version } });
  await db.insert(auditLogs).values({ id: randomUUID(), workspaceId, actorId, action: eventType, targetType: entity, targetId: row.id, requestId, metadata: { version: row.version } });
}
export function personalTrackerScore(definition: Parameters<typeof evaluatePersonalTracker>[0], values: Parameters<typeof evaluatePersonalTracker>[1]) {
  const score = evaluatePersonalTracker(definition, values);
  return { statusId: score.statusId, statusName: score.statusName, stars: score.stars, ruleId: score.ruleId, missingFields: score.missing };
}

/** Bounded, independently acknowledged consumer; never edits task history. */
export async function ingestPersonalTrackerEvents(db: Database, workspaceId?: string) {
  const candidates = await db.execute<{ tracker_id: string; workspace_id: string; event_id: string }>(sql`
    select tracker_id,workspace_id,event_id from (
      select tr.id tracker_id,tr.workspace_id,e.id event_id,e.created_at,
        row_number() over(partition by tr.workspace_id order by e.created_at,e.id,tr.id) turn
      from personal_trackers tr join personal_tracker_links l on l.tracker_id=tr.id and l.workspace_id=tr.workspace_id
      join tracking_events e on e.task_id=l.task_id and e.workspace_id=tr.workspace_id
      join tasks t on t.id=e.task_id and t.workspace_id=tr.workspace_id
      join workspaces w on w.id=tr.workspace_id join users u on u.id=w.owner_id
      where tr.state='ACTIVE' and t.status<>'DELETED' and e.type='TASK_COMPLETED'
        and e.created_at>=greatest(l.created_at,tr.ingest_after)
        and (e.occurred_at at time zone tr.time_zone)::date>=tr.start_date
        and (e.occurred_at at time zone tr.time_zone)::date<=(now() at time zone tr.time_zone)::date
        and u.status='ACTIVE' and u.deleted_at is null and u.deletion_requested_at is null and w.deleted_at is null
        and (${workspaceId ? sql`tr.workspace_id=${workspaceId}` : sql`true`})
        and not exists(select 1 from personal_tracker_sources s where s.tracker_id=tr.id and s.source_event_id=e.id)
    ) eligible order by turn,created_at,event_id limit 100`);
  let processed = 0, deferred = 0;
  const started = performance.now();
  for (const candidate of candidates) {
    if (performance.now() - started > 20000) break;
    try {
      processed += await db.transaction(async (tx) => {
        const work = tx as unknown as Database;
        await work.execute(sql`set local lock_timeout='500ms'`); await work.execute(sql`set local statement_timeout='8s'`);
        await work.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'workspace:' + candidate.workspace_id},0))`);
        const owner = await work.execute(sql`select u.id from users u join workspaces w on w.owner_id=u.id where w.id=${candidate.workspace_id} and u.status='ACTIVE' and u.deletion_requested_at is null and u.deleted_at is null and w.deleted_at is null for share of u`);
        if (!owner.length) return 0;
        const [tracker] = await work.select().from(personalTrackers).where(and(eq(personalTrackers.id, candidate.tracker_id), eq(personalTrackers.workspaceId, candidate.workspace_id)));
        const [event] = await work.select().from(trackingEvents).where(and(eq(trackingEvents.id, candidate.event_id), eq(trackingEvents.workspaceId, candidate.workspace_id)));
        if (!tracker || tracker.state !== 'ACTIVE' || !event) return 0;
        const task = await work.execute(sql`select id from tasks where id=${event.taskId} and workspace_id=${tracker.workspaceId} and status<>'DELETED'`);
        if (!task.length) return 0;
        const [link] = await work.select().from(personalTrackerLinks).where(and(eq(personalTrackerLinks.trackerId, tracker.id), eq(personalTrackerLinks.taskId, event.taskId)));
        if (!link || event.createdAt < link.createdAt || event.createdAt < tracker.ingestAfter) return 0;
        const day = trackerDate(event.occurredAt, tracker.timeZone);
        if (day < tracker.startDate || day > trackerDate(new Date(), tracker.timeZone)) return 0;
        const created = await work.insert(personalTrackerEntries).values({ id: randomUUID(), workspaceId: tracker.workspaceId, trackerId: tracker.id, day, definition: tracker.definition, inputValues: {} }).onConflictDoNothing().returning();
        const [entry] = await work.select().from(personalTrackerEntries).where(and(eq(personalTrackerEntries.trackerId, tracker.id), eq(personalTrackerEntries.day, day)));
        if (!entry) throw new Error('Tracker day unavailable');
        const seconds = (event.payload as Record<string, unknown>).actualSeconds;
        const inserted = await work.insert(personalTrackerSources).values({ id: randomUUID(), workspaceId: tracker.workspaceId, trackerId: tracker.id, entryId: entry.id, taskId: event.taskId, taskIdentity: event.taskId, sourceEventId: event.id, completedAt: event.occurredAt,
          durationMinutes: typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0 ? (seconds / 60).toFixed(6) : null,
          createdAt: event.createdAt }).onConflictDoNothing().returning();
        if (!inserted.length) return 0;
        // Explicit deletion suppresses automatic resurrection, while receipts prevent replay.
        if (entry.deletedAt) return 1;
        const sources = await work.select().from(personalTrackerSources).where(eq(personalTrackerSources.entryId, entry.id));
        const inputValues = { ...entry.inputValues, ...trackerSourceValues(entry.definition, sources) };
        const [updated] = await work.update(personalTrackerEntries).set({ inputValues, ...personalTrackerScore(entry.definition, inputValues), version: created.length ? 1 : entry.version + 1, updatedAt: new Date() }).where(eq(personalTrackerEntries.id, entry.id)).returning();
        await recordPersonalTrackerChange(work, tracker.workspaceId, 'tracker_entry', updated!, created.length ? 'created' : 'updated', null);
        return 1;
      });
    } catch { deferred++; }
  }
  return { processed, deferred };
}
