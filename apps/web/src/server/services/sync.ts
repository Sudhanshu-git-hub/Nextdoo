import { createHash } from 'node:crypto';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { AppError, createTaskSchema, updateTaskSchema, completeTaskSchema, type MutationInput, type SyncPushInput } from '@nextdoo/contracts';
import { mergeEntity } from '@nextdoo/core';
import { conflictSnapshots, syncChanges, syncMutations, tasks } from '@nextdoo/db';
import { getDb } from '../db';
import { newId } from '../ids';
import { logger } from '../observability';
import { serialiseTask, createTask, updateTask, completeTask, reopenTask, archiveTask, deleteTask, type TaskActor, type SerialisedTask } from './tasks';
import { withTransaction } from '../db';
import { withWorkspaceTransaction } from './transactions';
import { assertTaskReferences } from './task-references';

/**
 * Sync protocol (PRD §10).
 *
 * Push semantics per mutation:
 *   applied   — written, new version returned
 *   duplicate — already processed; original result replayed
 *   conflict  — user must choose; local content preserved in conflict_snapshots
 *   rejected  — invalid or superseded; local content still preserved
 *
 * A poison mutation can never block the batch: each is processed independently.
 */

export interface MutationResult {
  mutationId: string;
  status: 'applied' | 'duplicate' | 'conflict' | 'rejected';
  entity?: Record<string, unknown>;
  serverEntity?: Record<string, unknown>;
  error?: { code: string; detail: string };
}

/** Fields a client may write. Anything else is ignored rather than trusted. */
const WRITABLE_TASK_FIELDS = new Set([
  'title', 'description', 'projectId', 'sectionId', 'priority',
  'dueAt', 'timeZone', 'estimateMinutes', 'position', 'status', 'tagIds', 'parentTaskId', 'completedAt',
]);

function sanitiseTaskPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (WRITABLE_TASK_FIELDS.has(k)) out[k] = v;
  }
  return out;
}

function mutationHash(mutation: MutationInput): string {
  const stable = (v: unknown): unknown => Array.isArray(v) ? v.map(stable)
    : v !== null && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, value]) => [k, stable(value)])) : v;
  return createHash('sha256').update(JSON.stringify(stable({ operation: mutation.operation, entityType: mutation.entityType, entityId: mutation.entityId, baseVersion: mutation.baseVersion, payload: mutation.payload, createdAt: mutation.createdAt }))).digest('hex');
}

/** Sync changes are commands, never raw writes that bypass task invariants. */
async function applyTaskPatch(actor: TaskActor, current: SerialisedTask, payload: Record<string, unknown>, occurredAt?: string): Promise<SerialisedTask> {
  const { status, completedAt, ...fields } = payload;
  let result = current;
  if (status !== undefined && !['ACTIVE', 'COMPLETED', 'ARCHIVED', 'DELETED'].includes(String(status))) throw new AppError('VALIDATION_FAILED', 'Invalid task status.');
  // Parent changes are not supported by the online update contract either.
  if ('parentTaskId' in fields) throw new AppError('VALIDATION_FAILED', 'Parent cannot be changed through task updates.');
  if (Object.keys(fields).length) result = await updateTask(actor, result.id, updateTaskSchema.parse({ ...fields, version: result.version }));
  if (status !== undefined && status !== result.status) {
    if (status === 'COMPLETED') {
      const input = completeTaskSchema.parse({ version: result.version, completedAt: completedAt ?? occurredAt });
      result = await completeTask(actor, result.id, result.version, input.completedAt);
    } else if (status === 'ACTIVE') result = await reopenTask(actor, result.id, result.version);
    else if (status === 'ARCHIVED') result = await archiveTask(actor, result.id, result.version);
    else if (status === 'DELETED') {
      await deleteTask(actor, result.id);
      result = { ...result, status: 'DELETED', version: result.version + 1 };
    }
  }
  return result;
}

export async function pushMutations(
  actor: { userId: string; workspaceId: string },
  input: SyncPushInput,
): Promise<{ results: MutationResult[]; cursor: number }> {
  if (input.workspaceId !== undefined && input.workspaceId !== actor.workspaceId) throw new AppError('FORBIDDEN', 'The queued workspace is not the authenticated workspace.');
  const results: MutationResult[] = [];

  for (const mutation of input.mutations) {
    try {
      results.push(await applyMutation(actor, input.deviceId, mutation));
    } catch (error) {
      // Isolate the failure: the rest of the batch still applies.
      logger.warn('sync.mutation.failed', {
        workspaceId: actor.workspaceId,
        mutationId: mutation.mutationId,
        error: error instanceof Error ? error.message : 'unknown',
      });
      results.push({
        mutationId: mutation.mutationId,
        status: 'rejected',
        error: { code: error instanceof AppError ? error.code : error instanceof Error && error.name === 'ZodError' ? 'VALIDATION_FAILED' : 'INTERNAL_ERROR', detail: 'This change could not be applied and has been kept locally.' },
      });
    }
  }

  const cursor = await currentCursor(actor.workspaceId);
  return { results, cursor };
}

async function applyMutation(
  actor: { userId: string; workspaceId: string },
  deviceId: string,
  mutation: MutationInput,
): Promise<MutationResult> {
  return withTransaction(async (db) => {
    await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'mutation:' + mutation.mutationId}, 0))`);
    return withWorkspaceTransaction(actor.workspaceId, async (tx) => {
  // Replay protection: return the original outcome verbatim.
  const prior = await tx
    .select()
    .from(syncMutations)
    .where(eq(syncMutations.mutationId, mutation.mutationId))
    .limit(1);
  if (prior[0] && prior[0].workspaceId !== actor.workspaceId) {
    return { mutationId: mutation.mutationId, status: 'rejected', error: { code: 'NOT_FOUND', detail: 'The requested resource is not available.' } };
  }
  if (prior[0] && prior[0].requestHash !== mutationHash(mutation)) {
    return { mutationId: mutation.mutationId, status: 'rejected', error: { code: 'IDEMPOTENCY_CONFLICT', detail: 'This mutation ID cannot be replayed for this request.' } };
  }
  if (prior[0]) {
    return { mutationId: mutation.mutationId, status: prior[0].status === 'rejected' ? 'rejected' : prior[0].status === 'conflict' ? 'conflict' : 'duplicate', entity: prior[0].result as Record<string, unknown> };
  }

  if (mutation.entityType !== 'task') {
    return {
      mutationId: mutation.mutationId,
      status: 'rejected',
      error: { code: 'VALIDATION_FAILED', detail: `Unsupported entity type: ${mutation.entityType}` },
    };
  }

    const rows = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, mutation.entityId), eq(tasks.workspaceId, actor.workspaceId)))
      .limit(1);
    const server = rows[0];

    // ---- create
    if (mutation.operation === 'create') {
      if (server) {
        // Already exists — treat as a duplicate create, not an error.
        const result = serialiseTask(server) as unknown as Record<string, unknown>;
        await recordMutation(tx, actor.workspaceId, deviceId, mutation, 'duplicate', result);
        return { mutationId: mutation.mutationId, status: 'duplicate' as const, entity: result };
      }
      await assertTaskReferences(tx, actor.workspaceId, mutation.payload);
      const input = createTaskSchema.parse({ ...mutation.payload, workspaceId: actor.workspaceId });
      let created = await createTask({ ...actor, deviceId }, input, { id: mutation.entityId });
      if (mutation.payload.status !== undefined || mutation.payload.position !== undefined) {
        created = await applyTaskPatch({ ...actor, deviceId }, created, {
          ...(mutation.payload.status !== undefined ? { status: mutation.payload.status, completedAt: mutation.payload.completedAt } : {}),
          ...(mutation.payload.position !== undefined ? { position: mutation.payload.position } : {}),
        }, mutation.createdAt);
      }
      const result = created as unknown as Record<string, unknown>;
      await recordMutation(tx, actor.workspaceId, deviceId, mutation, 'applied', result);
      return { mutationId: mutation.mutationId, status: 'applied' as const, entity: result };
    }

    // ---- delete
    if (mutation.operation === 'delete') {
      if (!server || server.status === 'DELETED') {
        await recordMutation(tx, actor.workspaceId, deviceId, mutation, 'duplicate', {});
        return { mutationId: mutation.mutationId, status: 'duplicate' as const };
      }
      await deleteTask({ ...actor, deviceId }, mutation.entityId);
      await recordMutation(tx, actor.workspaceId, deviceId, mutation, 'applied', { id: mutation.entityId });
      return { mutationId: mutation.mutationId, status: 'applied' as const };
    }

    // ---- update
    const local = sanitiseTaskPayload(mutation.payload);

    if (!server) {
      // Deleted remotely, or never existed. Preserve the local content.
      await tx.insert(conflictSnapshots).values({
        id: newId(),
        workspaceId: actor.workspaceId,
        entityType: 'task',
        entityId: mutation.entityId,
        deviceId,
        localPayload: local as never,
        serverPayload: {} as never,
        expiresAt: new Date(Date.now() + 30 * 86_400_000),
      });
      await recordMutation(tx, actor.workspaceId, deviceId, mutation, 'rejected', {});
      return {
        mutationId: mutation.mutationId,
        status: 'rejected' as const,
        error: { code: 'NOT_FOUND', detail: 'This task no longer exists. Your edit was saved for recovery.' },
      };
    }

    await assertTaskReferences(tx, actor.workspaceId, mutation.payload, server.projectId);
    const serverSnapshot = serialiseTask(server) as unknown as Record<string, unknown>;
    const merge = mergeEntity({
      local,
      server: serverSnapshot,
      baseVersion: mutation.baseVersion,
      serverVersion: server.version,
      serverDeleted: server.status === 'DELETED',
      serverCompleted: server.status === 'COMPLETED',
    });

    // Anything not applied is retained so no user content is lost.
    if (Object.keys(merge.rejected).length > 0) {
      await tx.insert(conflictSnapshots).values({
        id: newId(),
        workspaceId: actor.workspaceId,
        entityType: 'task',
        entityId: mutation.entityId,
        deviceId,
        localPayload: merge.rejected as never,
        serverPayload: serverSnapshot as never,
        expiresAt: new Date(Date.now() + 30 * 86_400_000),
      });
    }

    if (merge.status === 'rejected') {
      await recordMutation(tx, actor.workspaceId, deviceId, mutation, 'rejected', serverSnapshot);
      return {
        mutationId: mutation.mutationId,
        status: 'rejected' as const,
        serverEntity: serverSnapshot,
        error: { code: 'NOT_FOUND', detail: merge.reason ?? 'This change could not be applied.' },
      };
    }

    let updatedEntity = serverSnapshot;
    if (Object.keys(merge.apply).length > 0) {
      updatedEntity = await applyTaskPatch({ ...actor, deviceId }, serialiseTask(server), merge.apply, mutation.createdAt) as unknown as Record<string, unknown>;
    }

    const status = merge.status === 'conflict' ? ('conflict' as const) : ('applied' as const);
    await recordMutation(tx, actor.workspaceId, deviceId, mutation, status, updatedEntity);

    return {
      mutationId: mutation.mutationId,
      status,
      entity: updatedEntity,
      ...(status === 'conflict' ? { serverEntity: serverSnapshot } : {}),
    };
    });
  });
}

async function recordMutation(
  tx: any,
  workspaceId: string,
  deviceId: string,
  mutation: MutationInput,
  status: string,
  result: Record<string, unknown>,
): Promise<void> {
  await tx
    .insert(syncMutations)
    .values({
      mutationId: mutation.mutationId,
      requestHash: mutationHash(mutation),
      workspaceId,
      deviceId,
      entityType: mutation.entityType,
      entityId: mutation.entityId,
      status,
      result: result as never,
    })
    .onConflictDoNothing();
}

export async function currentCursor(workspaceId: string): Promise<number> {
  const db = getDb();
  const rows = await db
    .select({ seq: sql<number>`coalesce(max(${syncChanges.sequence}), 0)` })
    .from(syncChanges)
    .where(eq(syncChanges.workspaceId, workspaceId));
  return Number(rows[0]?.seq ?? 0);
}

/** Pulls changes after the cursor, plus tombstones so deletions propagate. */
export async function pullChanges(workspaceId: string, cursor: number, limit: number) {
  const db = getDb();
  const rows = await db
    .select()
    .from(syncChanges)
    .where(and(eq(syncChanges.workspaceId, workspaceId), gt(syncChanges.sequence, cursor)))
    .orderBy(asc(syncChanges.sequence))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const next = page.length ? Number(page[page.length - 1]!.sequence) : cursor;

  return {
    changes: page.map((r) => ({
      sequence: Number(r.sequence),
      entityType: r.entityType,
      entityId: r.entityId,
      operation: r.operation,
      payload: r.payload,
      version: r.version,
    })),
    cursor: next,
    hasMore,
  };
}

/** Unresolved conflicts the UI must surface. */
export async function listConflicts(workspaceId: string) {
  const db = getDb();
  return db
    .select()
    .from(conflictSnapshots)
    .where(and(eq(conflictSnapshots.workspaceId, workspaceId), sql`${conflictSnapshots.resolvedAt} IS NULL`))
    .orderBy(asc(conflictSnapshots.createdAt))
    .limit(50);
}

export async function resolveConflict(
  actor: TaskActor,
  conflictId: string,
  resolution: 'local' | 'server',
): Promise<void> {
  const workspaceId = actor.workspaceId;
  await withWorkspaceTransaction(workspaceId, async (tx) => {
    const [snapshot] = await tx.select().from(conflictSnapshots)
      .where(and(eq(conflictSnapshots.id, conflictId), eq(conflictSnapshots.workspaceId, workspaceId)));
    if (!snapshot || snapshot.resolvedAt) return;
    if (resolution === 'local') {
      const [target] = await tx.select().from(tasks).where(and(eq(tasks.id, snapshot.entityId), eq(tasks.workspaceId, workspaceId)));
      if (!target || target.status === 'DELETED') return;
      await assertTaskReferences(tx, workspaceId, snapshot.localPayload as Record<string, unknown>, target.projectId);
      await applyTaskPatch(actor, serialiseTask(target), sanitiseTaskPayload(snapshot.localPayload as Record<string, unknown>));
    }
    await tx.update(conflictSnapshots).set({ resolvedAt: new Date(), resolution })
      .where(and(eq(conflictSnapshots.id, conflictId), eq(conflictSnapshots.workspaceId, workspaceId)));
  });
}
