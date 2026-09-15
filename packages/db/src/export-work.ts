import { gzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Database } from './client';
import {
  exports,
  notifications,
  tasks,
  trackingCorrections,
  trackingEvents,
  trackingResults,
  workspaces,
} from './schema';
import type { ExportArtifactStore } from './export-storage';

/**
 * Durable asynchronous export generation (PRD §7.10, §12.4, §13, §13.5).
 *
 * Content: the user's tracking events, active execution results, correction
 * history and read-time daily/weekly rollups, in JSON or typed-union CSV.
 * Delivery: a READY row carries a 24-hour download window; the artifact lives
 * in an ExportArtifactStore (durable local files by default, managed object
 * storage is the documented switching point). Attempt/lease semantics mirror
 * the tracking jobs: an attempt is committed before work, a claim token fences
 * a delayed worker, and the initial attempt plus two retries are the budget
 * (PRD §12.4: export.generate, retries 2, "notify user with retry link").
 */

export type ExportFormat = 'json' | 'csv';
export type ExportStatus = 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED' | 'EXPIRED';

const ROLLUP_DAYS = 90;
const ROLLUP_WEEKS = 8;
/** Initial attempt plus two retries, with 1/2-minute backoff. */
const BACKOFF_MINUTES = [1, 2];
const clock = sql`clock_timestamp()`;

function objectKeyFor(userId: string, id: string, format: ExportFormat): string {
  return `export-${userId}/${id}.${format}.gz`;
}

async function ownedWorkspaces(db: Database, userId: string): Promise<string[]> {
  const rows = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(eq(workspaces.ownerId, userId), isNull(workspaces.deletedAt)));
  return rows.map((r) => r.id);
}

export interface DailyRollup {
  day: string;
  trackedTaskCount: number;
  completedTaskCount: number;
  recordedSeconds: number;
  measuredResultCount: number;
  averageScore: number | null;
}

interface RollupRow {
  label: string;
  tasks: number;
  completed: number;
  seconds: number;
  measured: number;
  avg: string | null;
}

/**
 * Read-time rollups (repeatable-read snapshot, same UTC cohort semantics as the
 * existing summaries): per-UTC-day aggregates for the last 90 days plus
 * contiguous 7-day windows for the last 8 weeks ending today. Distinct task
 * counts are aggregated per bucket in SQL, so weekly figures are exact, not
 * sums of daily distincts.
 */
export async function computeRollups(
  db: Database,
  userId: string,
): Promise<{ daily: DailyRollup[]; weekly: (DailyRollup & { window: string })[] }> {
  const workspaceIds = await ownedWorkspaces(db, userId);
  if (!workspaceIds.length) return { daily: [], weekly: [] };

  const workspaceList = sql.join(workspaceIds.map((id) => sql`${id}`), sql`, `);

  const dailyRows = (await db.execute(sql`
    with days as (select (current_date - (${ROLLUP_DAYS - 1} - g)) as day from generate_series(0, ${ROLLUP_DAYS - 1}) g),
    ev as (
      select date(e.occurred_at at time zone 'UTC') as day,
             count(distinct e.task_id) as tasks,
             count(distinct e.task_id) filter (where e.type = 'TASK_COMPLETED') as completed,
             coalesce(sum((e.payload->>'seconds')::bigint) filter (where e.type = 'TIME_LOGGED'), 0) as seconds
      from tracking_events e
      join tasks t on t.id = e.task_id and t.workspace_id = e.workspace_id
      where e.workspace_id in (${workspaceList})
      group by 1
    ),
    res as (
      select date(r.updated_at at time zone 'UTC') as day,
             count(r.score) filter (where r.score is not null) as measured,
             avg(r.score) filter (where r.score is not null) as avg
      from tracking_results r
      join tasks t on t.id = r.task_id and t.workspace_id = r.workspace_id
      where r.workspace_id in (${workspaceList}) and r.superseded_at is null
      group by 1
    )
    select to_char(d.day, 'YYYY-MM-DD') as label,
           coalesce(ev.tasks, 0) as tasks,
           coalesce(ev.completed, 0) as completed,
           coalesce(ev.seconds, 0) as seconds,
           coalesce(res.measured, 0) as measured,
           res.avg
    from days d
    left join ev on ev.day = d.day
    left join res on res.day = d.day
    order by d.day`)) as unknown as RollupRow[];

  const weeklyRows = (await db.execute(sql`
    with weeks as (select g as window_idx from generate_series(0, ${ROLLUP_WEEKS - 1}) g),
    ev as (
      select floor((current_date - date(e.occurred_at at time zone 'UTC')) / 7) as window_idx,
             count(distinct e.task_id) as tasks,
             count(distinct e.task_id) filter (where e.type = 'TASK_COMPLETED') as completed,
             coalesce(sum((e.payload->>'seconds')::bigint) filter (where e.type = 'TIME_LOGGED'), 0) as seconds
      from tracking_events e
      join tasks t on t.id = e.task_id and t.workspace_id = e.workspace_id
      where e.workspace_id in (${workspaceList})
        and date(e.occurred_at at time zone 'UTC') >= current_date - (${ROLLUP_WEEKS * 7 - 1}::int)
      group by 1
    ),
    res as (
      select floor((current_date - date(r.updated_at at time zone 'UTC')) / 7) as window_idx,
             count(r.score) filter (where r.score is not null) as measured,
             avg(r.score) filter (where r.score is not null) as avg
      from tracking_results r
      join tasks t on t.id = r.task_id and t.workspace_id = r.workspace_id
      where r.workspace_id in (${workspaceList}) and r.superseded_at is null
        and date(r.updated_at at time zone 'UTC') >= current_date - (${ROLLUP_WEEKS * 7 - 1}::int)
      group by 1
    )
    select w.window_idx::text as label,
           coalesce(ev.tasks, 0) as tasks,
           coalesce(ev.completed, 0) as completed,
           coalesce(ev.seconds, 0) as seconds,
           coalesce(res.measured, 0) as measured,
           res.avg
    from weeks w
    left join ev on ev.window_idx = w.window_idx
    left join res on res.window_idx = w.window_idx
    order by w.window_idx`)) as unknown as RollupRow[];

  const toRollup = (r: RollupRow, label: string): DailyRollup => ({
    day: label,
    trackedTaskCount: Number(r.tasks),
    completedTaskCount: Number(r.completed),
    recordedSeconds: Number(r.seconds),
    measuredResultCount: Number(r.measured),
    averageScore: r.avg === null ? null : Number(r.avg),
  });

  const daily = dailyRows.map((r) => toRollup(r, r.label));
  const weekly = weeklyRows.map((r) => {
    const k = Number(r.label) + 1;
    const end = new Date(Date.now() - (k - 1) * 7 * 86400000).toISOString().slice(0, 10);
    return { ...toRollup(r, `7d-ending-${end}`), window: `7d-ending-${end}` };
  });

  return { daily, weekly };
}

interface EventRecord {
  id: string;
  workspaceId: string;
  taskId: string;
  occurrenceKey: string | null;
  type: string;
  actorId: string | null;
  actorKind: string;
  occurredAt: Date;
  clientTimestamp: Date | null;
  deviceId: string | null;
  sequence: number;
  idempotencyKey: string;
  schemaVersion: number;
  payload: Record<string, unknown>;
}

interface ResultRecord {
  id: string;
  workspaceId: string;
  taskId: string;
  occurrenceKey: string | null;
  score: number | null;
  outcome: string;
  measuredWeight: number;
  calculationVersion: number;
  inputHash: string;
  recalculated: boolean;
  updatedAt: Date;
  components: Record<string, unknown>;
  explanation: string;
  inputSnapshot: Record<string, unknown>;
}

interface CorrectionRecord {
  id: string;
  workspaceId: string;
  taskId: string;
  kind: string;
  reason: string | null;
  createdAt: Date;
}

export const CSV_COLUMNS = [
  'record_type', 'id', 'workspace_id', 'task_id', 'occurrence_key', 'type', 'outcome', 'score',
  'measured_weight', 'recalculated', 'sequence', 'actor_id', 'actor_kind', 'occurred_at',
  'client_timestamp', 'device_id', 'schema_version', 'idempotency_key', 'payload', 'components',
  'explanation', 'input_hash', 'calculation_version', 'input_snapshot', 'correction_kind',
  'correction_reason', 'task_title', 'task_status', 'estimate_minutes', 'actual_minutes',
  'rollup_date', 'rollup_window', 'tracked_task_count', 'completed_task_count',
  'recorded_seconds', 'measured_result_count', 'average_score',
] as const;

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

interface ArtifactData {
  events: EventRecord[];
  results: ResultRecord[];
  corrections: CorrectionRecord[];
  rollups: { daily: DailyRollup[]; weekly: (DailyRollup & { window: string })[] };
  taskTitles: Map<string, { title: string; status: string; estimateMinutes: number | null; actualMinutes: number }>;
}

/** Builds and gzips the artifact; the JSON document is the canonical shape. */
export function buildExportArtifact(
  userId: string,
  format: ExportFormat,
  data: ArtifactData,
  generatedAt = new Date(),
): Uint8Array {
  if (format === 'json') {
    const body = {
      formatVersion: 1,
      kind: 'nextdoo-tracking-export',
      generatedAt: generatedAt.toISOString(),
      account: { id: userId },
      tasks: [...data.taskTitles.entries()].map(([id, t]) => ({ id, ...t })),
      events: data.events,
      results: data.results,
      corrections: data.corrections,
      rollups: data.rollups,
    };
    return gzipSync(new TextEncoder().encode(JSON.stringify(body, null, 2)));
  }

  const lines = [CSV_COLUMNS.join(',')];
  const push = (cells: Record<string, unknown>) => {
    lines.push(CSV_COLUMNS.map((c) => csvEscape(cells[c] ?? null)).join(','));
  };
  for (const e of data.events) {
    const t = data.taskTitles.get(e.taskId);
    push({
      record_type: 'event', id: e.id, workspace_id: e.workspaceId, task_id: e.taskId,
      occurrence_key: e.occurrenceKey, type: e.type, actor_id: e.actorId, actor_kind: e.actorKind,
      occurred_at: e.occurredAt.toISOString(), client_timestamp: e.clientTimestamp?.toISOString() ?? null,
      device_id: e.deviceId, sequence: e.sequence, idempotency_key: e.idempotencyKey,
      schema_version: e.schemaVersion, payload: e.payload,
      task_title: t?.title ?? null, task_status: t?.status ?? null,
      estimate_minutes: t?.estimateMinutes ?? null, actual_minutes: t?.actualMinutes ?? null,
    });
  }
  for (const r of data.results) {
    push({
      record_type: 'result', id: r.id, workspace_id: r.workspaceId, task_id: r.taskId,
      occurrence_key: r.occurrenceKey, outcome: r.outcome, score: r.score,
      measured_weight: r.measuredWeight, recalculated: r.recalculated,
      occurred_at: r.updatedAt.toISOString(), explanation: r.explanation,
      input_hash: r.inputHash, calculation_version: r.calculationVersion,
      components: r.components, input_snapshot: r.inputSnapshot,
    });
  }
  for (const c of data.corrections) {
    push({
      record_type: 'correction', id: c.id, workspace_id: c.workspaceId, task_id: c.taskId,
      correction_kind: c.kind, correction_reason: c.reason, occurred_at: c.createdAt.toISOString(),
    });
  }
  for (const d of data.rollups.daily) {
    push({
      record_type: 'rollup_daily', rollup_date: d.day, tracked_task_count: d.trackedTaskCount,
      completed_task_count: d.completedTaskCount, recorded_seconds: d.recordedSeconds,
      measured_result_count: d.measuredResultCount, average_score: d.averageScore,
    });
  }
  for (const w of data.rollups.weekly) {
    push({
      record_type: 'rollup_weekly', rollup_window: w.window, rollup_date: w.day,
      tracked_task_count: w.trackedTaskCount, completed_task_count: w.completedTaskCount,
      recorded_seconds: w.recordedSeconds, measured_result_count: w.measuredResultCount,
      average_score: w.averageScore,
    });
  }
  return gzipSync(new TextEncoder().encode(lines.join('\n') + '\n'));
}

function insertExportNotification(
  db: Database,
  input: { userId: string; workspaceId: string | null; kind: 'export_ready' | 'export_failed'; exportId: string; format: ExportFormat },
) {
  const [title, body] = input.kind === 'export_ready'
    ? ['Data export ready', 'Your tracking data export is ready to download. The link stays available for 24 hours.']
    : ['Export could not be completed', 'Your tracking data export failed. Open Settings, Data export, and request a new export.'];
  return db.insert(notifications).values({
    id: randomUUID(),
    userId: input.userId,
    workspaceId: input.workspaceId,
    type: input.kind,
    title,
    body: `${body} Reference: export-${input.exportId.slice(0, 8)}.${input.format}`,
  }).onConflictDoNothing();
}

/**
 * Recovers exports left claimed by a worker that died mid-generation. The
 * consumed attempt keeps its budget; an exhausted budget is terminal and
 * notifies the owner (PRD §12.4 DLQ action: "notify user with retry link").
 */
export async function recoverStaleExportClaims(db: Database): Promise<{ recovered: number; failed: number }> {
  const expired = await db.execute(sql`update exports
    set status = case when attempts >= 3 then 'FAILED' else 'PENDING' end,
        error = case when attempts >= 3 then 'STALE_EXPORT_CLAIM' else error end,
        claim_token = null, lease_expires_at = null,
        next_attempt_at = clock_timestamp(), updated_at = clock_timestamp()
    where status = 'PROCESSING' and lease_expires_at <= clock_timestamp()
    returning id, user_id, workspace_id, format, attempts`);
  let failed = 0;
  for (const row of expired as unknown as { id: string; user_id: string; workspace_id: string | null; format: string; attempts: number }[]) {
    if (row.attempts >= 3) {
      failed += 1;
      await insertExportNotification(db, {
        userId: row.user_id, workspaceId: row.workspace_id, kind: 'export_failed',
        exportId: row.id, format: row.format as ExportFormat,
      });
    }
  }
  return { recovered: expired.length, failed };
}

export interface ExportGenerationFailure {
  exportId: string;
  userId: string;
  attempts: number;
  error: string;
}

export interface ExportGenerationResult {
  processed: number;
  failed: number;
  retrying: number;
  deferred: number;
  failures: ExportGenerationFailure[];
}

/**
 * One bounded generation pass (worker job export.generate): reclaim stale
 * leases, then claim and generate at most `limit` exports. Crashes between the
 * claim commit and the READY commit are harmless: the object key is stable per
 * export, so a retry overwrites the same artifact exactly.
 */
export async function runExportGeneration(
  db: Database,
  opts: { store: ExportArtifactStore; limit?: number },
): Promise<ExportGenerationResult> {
  const limit = opts.limit ?? 5;
  const recovered = await recoverStaleExportClaims(db);
  const result: ExportGenerationResult = { processed: 0, failed: 0, retrying: 0, deferred: 0, failures: [] };
  result.failed += recovered.failed;

  const started = Date.now();
  const candidates = await db.transaction(async (tx) => {
    await tx.execute(sql`set local statement_timeout='8s'`);
    const rows = await tx.execute(sql`select c.id, c.user_id from (
      select e.id, e.user_id, row_number() over (partition by e.user_id order by e.next_attempt_at, e.created_at, e.id) as turn
      from exports e
      join users u on u.id = e.user_id
      where e.status = 'PENDING' and e.claim_token is null and e.attempts < 3
        and e.next_attempt_at <= clock_timestamp()
        and u.deleted_at is null
    ) c order by c.turn, c.id, c.user_id limit ${limit}`) as unknown as { id: string; user_id: string }[];
    return rows;
  });

  for (const candidate of candidates) {
    if (Date.now() - started > 20_000) { result.deferred += 1; continue; }
    try {
      const claimed = await db.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout='500ms'`);
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'export:' + candidate.user_id}, 0))`);
        const rows = await tx
          .update(exports)
          .set({
            claimToken: randomUUID(),
            leaseExpiresAt: sql`clock_timestamp() + interval '2 minutes'`,
            status: 'PROCESSING',
            attempts: sql`${exports.attempts} + 1`,
            updatedAt: clock,
          })
          .where(and(
            eq(exports.id, candidate.id),
            eq(exports.userId, candidate.user_id),
            eq(exports.status, 'PENDING'),
            isNull(exports.claimToken),
            sql`${exports.attempts} < 3`,
            sql`${exports.nextAttemptAt} <= clock_timestamp()`,
          ))
          .returning();
        return rows[0];
      });
      if (!claimed) continue;

      try {
        const workspaceIds = await ownedWorkspaces(db, claimed.userId);
        const data: ArtifactData = { events: [], results: [], corrections: [], rollups: { daily: [], weekly: [] }, taskTitles: new Map() };
        if (workspaceIds.length) {
          const [events, results, corrections, taskRows] = await Promise.all([
            db.select().from(trackingEvents).where(inArray(trackingEvents.workspaceId, workspaceIds))
              .orderBy(sql`${trackingEvents.workspaceId}, ${trackingEvents.taskId}, ${trackingEvents.sequence}`),
            db.select().from(trackingResults)
              .where(and(inArray(trackingResults.workspaceId, workspaceIds), isNull(trackingResults.supersededAt))),
            db.select().from(trackingCorrections).where(inArray(trackingCorrections.workspaceId, workspaceIds)),
            db.select({ id: tasks.id, title: tasks.title, status: tasks.status, estimateMinutes: tasks.estimateMinutes, actualMinutes: tasks.actualMinutes })
              .from(tasks).where(inArray(tasks.workspaceId, workspaceIds)),
          ]);
          data.events = events.map((e) => ({
            id: e.id, workspaceId: e.workspaceId, taskId: e.taskId, occurrenceKey: e.occurrenceKey,
            type: e.type, actorId: e.actorId, actorKind: e.actorKind, occurredAt: e.occurredAt,
            clientTimestamp: e.clientTimestamp, deviceId: e.deviceId, sequence: Number(e.sequence),
            idempotencyKey: e.idempotencyKey, schemaVersion: e.schemaVersion, payload: e.payload as Record<string, unknown>,
          }));
          data.results = results.map((r) => ({
            id: r.id, workspaceId: r.workspaceId, taskId: r.taskId, occurrenceKey: r.occurrenceKey,
            score: r.score === null ? null : Number(r.score), outcome: r.outcome,
            measuredWeight: Number(r.measuredWeight), calculationVersion: r.calculationVersion,
            inputHash: r.inputHash, recalculated: r.recalculated, updatedAt: r.updatedAt,
            components: r.components as Record<string, unknown>, explanation: r.explanation, inputSnapshot: (r.inputSnapshot ?? {}) as Record<string, unknown>,
          }));
          data.corrections = corrections.map((c) => ({
            id: c.id, workspaceId: c.workspaceId, taskId: c.taskId, kind: c.kind, reason: c.reason, createdAt: c.createdAt,
          }));
          for (const t of taskRows) {
            data.taskTitles.set(t.id, { title: t.title, status: t.status, estimateMinutes: t.estimateMinutes, actualMinutes: t.actualMinutes });
          }
          data.rollups = await computeRollups(db, claimed.userId);
        }

        const format = claimed.format as ExportFormat;
        const artifact = buildExportArtifact(claimed.userId, format, data);
        const objectKey = objectKeyFor(claimed.userId, claimed.id, format);
        await opts.store.write(objectKey, artifact);

        await db.transaction(async (tx) => {
          await tx.update(exports).set({
            status: 'READY',
            objectKey,
            sizeBytes: artifact.byteLength,
            expiresAt: sql`clock_timestamp() + interval '24 hours'`,
            completedAt: clock,
            claimToken: null,
            leaseExpiresAt: null,
            error: null,
            updatedAt: clock,
          }).where(and(eq(exports.id, claimed.id), eq(exports.claimToken, claimed.claimToken as string)));
          await insertExportNotification(tx as unknown as Database, { userId: claimed.userId, workspaceId: claimed.workspaceId, kind: 'export_ready', exportId: claimed.id, format });
        });
        result.processed += 1;
      } catch (error) {
        const code = (error instanceof Error && error.message
          ? error.message
          : error instanceof Error && error.name
            ? error.name
            : 'EXPORT_GENERATION_FAILED').slice(0, 80);
        const attempt = claimed.attempts;
        const exhausted = attempt >= 3;
        await db.transaction(async (tx) => {
          await tx.update(exports).set({
            status: exhausted ? 'FAILED' : 'PENDING',
            error: code.slice(0, 300),
            claimToken: null,
            leaseExpiresAt: null,
            nextAttemptAt: exhausted
              ? clock
              : sql`clock_timestamp() + make_interval(mins => ${BACKOFF_MINUTES[Math.min(attempt - 1, BACKOFF_MINUTES.length - 1)]})`,
            updatedAt: clock,
          }).where(and(eq(exports.id, claimed.id), eq(exports.claimToken, claimed.claimToken as string)));
          if (exhausted) {
            await insertExportNotification(tx as unknown as Database, { userId: claimed.userId, workspaceId: claimed.workspaceId, kind: 'export_failed', exportId: claimed.id, format: claimed.format as ExportFormat });
          }
        });
        if (exhausted) {
          result.failed += 1;
          result.failures.push({ exportId: claimed.id, userId: claimed.userId, attempts: attempt, error: code });
        } else {
          result.retrying += 1;
        }
      }
    } catch { result.deferred += 1; }
  }
  return result;
}

/**
 * Expiry sweep (PRD §13.5: export files retained 24 hours). Deletes the
 * artifact and marks the row EXPIRED so downloads return 410 afterwards.
 */
export async function expireExports(
  db: Database,
  opts: { store: ExportArtifactStore; limit?: number },
): Promise<{ expired: number }> {
  const limit = opts.limit ?? 100;
  const due = await db.execute(sql`update exports
    set status = 'EXPIRED', updated_at = clock_timestamp()
    where id in (select id from exports where status = 'READY' and expires_at is not null
      and expires_at <= clock_timestamp() order by expires_at limit ${limit} for update skip locked)
    returning id, object_key`);
  let expired = 0;
  for (const row of due as unknown as { id: string; object_key: string | null }[]) {
    if (row.object_key) {
      try { await opts.store.remove(row.object_key); } catch { /* one bad file must not stall the sweep */ }
    }
    expired += 1;
  }
  return { expired };
}


