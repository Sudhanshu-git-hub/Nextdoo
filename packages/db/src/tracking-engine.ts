import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { calculateScore, type ScoringInput } from '@nextdoo/core';
import { tasks, taskOccurrences, trackingEvents, trackingResults, trackingJobs, recurrenceRules, outbox } from './schema';
import type { Database } from './client';

/** Called inside the workspace transaction by both web fast path and standalone worker. */
export const CALCULATION_VERSION = 2; // Event-stream fingerprint and tenant-safe input assembly; score weights unchanged.

function hashInputs(input: ScoringInput, eventHash: string): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        eventHash,
        c: input.completed,
        d: input.dueAt?.toISOString() ?? null,
        ca: input.completedAt?.toISOString() ?? null,
        e: input.estimateMinutes,
        a: input.actualMinutes,
        eo: input.expectedOccurrences,
        co: input.completedOccurrences,
        r: input.rescheduleCount,
        s: input.skipped,
        overdue: input.dueAt !== null && input.dueAt < (input.evaluatedAt ?? new Date()),
      }),
    )
    .digest('hex')
    .slice(0, 64);
}

/** Assembles scoring inputs from the durable record. */
export async function buildScoringInput(db: Database, workspaceId: string, taskId: string, now = new Date()): Promise<ScoringInput | null> {
  const rows = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, workspaceId)))
    .limit(1);
  const task = rows[0];
  if (!task) return null;

  let occurrenceSkipped: boolean | undefined;
  let expected: number | null = null;
  let completed: number | null = null;
  if (task.recurrenceRuleId) {
    const occ = await db
      .select({ status: taskOccurrences.status, taskId: taskOccurrences.taskId })
      .from(taskOccurrences)
      .innerJoin(recurrenceRules, eq(recurrenceRules.id, taskOccurrences.recurrenceRuleId))
      .leftJoin(tasks, eq(tasks.id, taskOccurrences.taskId))
      .where(and(eq(taskOccurrences.recurrenceRuleId, task.recurrenceRuleId), eq(recurrenceRules.workspaceId, workspaceId),
        or(isNull(taskOccurrences.taskId), eq(tasks.workspaceId, workspaceId))));
    const own = occ.find((o) => o.taskId === taskId);
    if (own) occurrenceSkipped = own.status === 'SKIPPED';
    if (occ.length) {
      expected = occ.length;
      completed = occ.filter((o) => o.status === 'COMPLETED').length;
    }
  }

  const skipped = await db
    .select({ id: trackingEvents.id })
    .from(trackingEvents)
    .where(and(eq(trackingEvents.taskId, taskId), eq(trackingEvents.type, 'TASK_SKIPPED'), eq(trackingEvents.workspaceId, workspaceId)))
    .limit(1);

  return {
    completed: task.status === 'COMPLETED',
    dueAt: task.dueAt,
    completedAt: task.completedAt,
    estimateMinutes: task.estimateMinutes,
    actualMinutes: task.actualMinutes * 60 + task.actualSecondsRemainder > 0 ? task.actualMinutes + task.actualSecondsRemainder / 60 : null,
    expectedOccurrences: expected,
    completedOccurrences: completed,
    rescheduleCount: task.rescheduleCount,
    skipped: occurrenceSkipped ?? skipped.length > 0,
    evaluatedAt: now,
  };
}

export interface StoredResult {
  id: string;
  taskId: string;
  score: number | null;
  outcome: string;
  components: unknown;
  explanation: string;
  measuredWeight: number;
  calculationVersion: number;
  recalculated: boolean;
  createdAt: string;
}

/**
 * Computes and persists an execution result.
 * Idempotent: identical inputs return the existing row untouched.
 */
export async function evaluateTrackingInTransaction(
  db: Database,
  workspaceId: string,
  taskId: string,
  options: { recalculated?: boolean; now?: Date; acknowledge?: boolean; streamBudgetMs?: number } = {},
): Promise<StoredResult | null> {

    // Lock the durable task before assembling inputs, not after computing them.
    const [task] = await db.select().from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, workspaceId), isNull(tasks.deletedAt), sql`${tasks.status}<>'DELETED'`)).for('update');
  if (!task) return null;
  const input = await buildScoringInput(db, workspaceId, taskId, options.now);
  if (!input) return null;

  const result = calculateScore(input);
  const stream = await hashEventStream(db, workspaceId, taskId, options.streamBudgetMs);
  const inputHash = hashInputs(input, stream.hash);
  const [cohort] = task.recurrenceRuleId ? await db.select({ revision: recurrenceRules.trackingRevision }).from(recurrenceRules)
    .where(and(eq(recurrenceRules.id, task.recurrenceRuleId), eq(recurrenceRules.workspaceId, workspaceId))) : [];
  const [checkpoint] = await db.update(trackingJobs).set({ evaluatedRevision: sql`${trackingJobs.revision}`, evaluatedCohortRevision: cohort?.revision ?? 0,
    calculationVersion: CALCULATION_VERSION, evaluatedAt: input.evaluatedAt,
    nextEvaluationAt: input.dueAt && input.dueAt >= input.evaluatedAt! ? new Date(input.dueAt.getTime() + 1) : null,
    ...(options.acknowledge ? { acknowledgedRevision: sql`${trackingJobs.revision}`, attempts: 0, lastError: null, lastErrorAt: null, claimToken: null, leaseExpiresAt: null } : {}),
  }).where(and(eq(trackingJobs.taskId, taskId), eq(trackingJobs.workspaceId, workspaceId))).returning({ revision: trackingJobs.revision });
  if (!checkpoint) throw new Error('TRACKING_JOB_MISSING');

  const existing = await db
    .select()
    .from(trackingResults)
    .where(
      and(
        eq(trackingResults.taskId, taskId), eq(trackingResults.workspaceId, workspaceId),
        eq(trackingResults.calculationVersion, CALCULATION_VERSION),
        eq(trackingResults.inputHash, inputHash),
        isNull(trackingResults.supersededAt),
      ),
    )
    .limit(1);

  if (existing[0]) {
    const row = existing[0];
    return {
      id: row.id,
      taskId: row.taskId,
      score: row.score === null ? null : Number(row.score),
      outcome: row.outcome,
      components: row.components,
      explanation: row.explanation,
      measuredWeight: Number(row.measuredWeight),
      calculationVersion: row.calculationVersion,
      recalculated: row.recalculated,
      createdAt: row.createdAt.toISOString(),
    };
  }

    const [prior] = await db.select({ id: trackingResults.id }).from(trackingResults)
      .where(and(eq(trackingResults.taskId, taskId), eq(trackingResults.workspaceId, workspaceId), isNull(trackingResults.supersededAt))).limit(1);
    const [occurrence] = task.recurrenceRuleId ? await db.select({ key: taskOccurrences.occurrenceKey }).from(taskOccurrences)
      .innerJoin(recurrenceRules, eq(recurrenceRules.id, taskOccurrences.recurrenceRuleId))
      .where(and(eq(taskOccurrences.taskId,taskId), eq(taskOccurrences.recurrenceRuleId,task.recurrenceRuleId), eq(recurrenceRules.workspaceId,workspaceId))).limit(1) : [];
    const tx = db;
    // Supersede prior results rather than deleting them.
    await tx
      .update(trackingResults)
      .set({ supersededAt: new Date() })
      .where(and(eq(trackingResults.taskId, taskId), eq(trackingResults.workspaceId, workspaceId), isNull(trackingResults.supersededAt)));

    const [row] = await tx
      .insert(trackingResults)
      .values({
        id: randomUUID(),
        workspaceId,
        taskId,
        occurrenceKey: occurrence?.key ?? null,
        score: result.score === null ? null : String(result.score),
        outcome: result.outcome,
        components: result.components,
        explanation: result.explanation,
        measuredWeight: String(result.measuredWeight),
        calculationVersion: CALCULATION_VERSION,
        inputHash,
        inputSnapshot: JSON.parse(JSON.stringify({ ...input, sourceEventHash: stream.hash, sourceEventCount: stream.count, sourceEventSequence: stream.sequence, taskVersion: task.version, previousResultId: prior?.id ?? null })) as Record<string, unknown>,
        recalculated: Boolean(prior && options.recalculated),
      })
      .returning();

    if (!row) throw new Error('TRACKING_RESULT_MISSING');
    await tx.insert(outbox).values({ id: randomUUID(), workspaceId, entityType: 'tracking_result', entityId: row.id,
      eventType: row.recalculated ? 'tracking.result_recalculated' : 'tracking.result_created',
      correlationId: `tracking-${taskId}-${checkpoint.revision}`,
      payload: { taskId, calculationVersion: CALCULATION_VERSION, inputHash },
    });
    return {
      id: row.id,
      taskId: row.taskId,
      score: row.score === null ? null : Number(row.score),
      outcome: row.outcome,
      components: row.components,
      explanation: row.explanation,
      measuredWeight: Number(row.measuredWeight),
      calculationVersion: row.calculationVersion,
      recalculated: row.recalculated,
      createdAt: row.createdAt.toISOString(),
    };
}


/** Hash the complete accepted stream in bounded pages, never the first 200 events.
 * The authoritative task projection supplies legacy fields absent from old events.
 * The workspace lock makes all pages and the projection one ordered input snapshot.
 */
async function hashEventStream(db: Database, workspaceId: string, taskId: string, budgetMs = 8000) {
 const hash = createHash('sha256'); let sequence = 0, count = 0;
 const started = performance.now();
 for (;;) {
  if (performance.now() - started > budgetMs) throw new Error('TRACKING_STREAM_BUDGET_EXCEEDED');
  const page = await db.select().from(trackingEvents).where(and(eq(trackingEvents.workspaceId, workspaceId), eq(trackingEvents.taskId, taskId), gt(trackingEvents.sequence, sequence))).orderBy(asc(trackingEvents.sequence)).limit(200);
  for (const event of page) { if(event.schemaVersion!==1)throw new Error('TRACKING_EVENT_VERSION_UNSUPPORTED'); hash.update(JSON.stringify(event)); hash.update('\n'); sequence = event.sequence; count++; }
  if (page.length < 200) return { hash: hash.digest('hex'), sequence, count };
 }
}
