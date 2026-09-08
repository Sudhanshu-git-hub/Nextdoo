import { and, asc, eq, gt, sql } from 'drizzle-orm';
import type { MutationInput, SyncPushInput } from '@nextdoo/contracts';
import { mergeEntity } from '@nextdoo/core';
import { conflictSnapshots, syncChanges, syncMutations, syncTombstones, tasks } from '@nextdoo/db';
import { getDb } from '../db';
import { newId } from '../ids';
import { logger } from '../observability';
import { recordSyncChange } from './events';
import { serialiseTask } from './tasks';

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
  'dueAt', 'timeZone', 'estimateMinutes', 'position', 'status',
]);

function sanitiseTaskPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (WRITABLE_TASK_FIELDS.has(k)) out[k] = v;
  }
  return out;
}

function toColumnValues(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (k === 'dueAt') out[k] = v ? new Date(v as string) : null;
    else if (k === 'position') out[k] = String(v);
    else out[k] = v;
  }
  return out;
}

export async function pushMutations(
  actor: { userId: string; workspaceId: string },
  input: SyncPushInput,
): Promise<{ results: MutationResult[]; cursor: number }> {
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
        error: { code: 'INTERNAL_ERROR', detail: 'This change could not be applied and has been kept locally.' },
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
  const db = getDb();

  // Replay protection: return the original outcome verbatim.
  const prior = await db
    .select()
    .from(syncMutations)
    .where(eq(syncMutations.mutationId, mutation.mutationId))
    .limit(1);
  if (prior[0]) {
    return { mutationId: mutation.mutationId, status: 'duplicate', entity: prior[0].result as Record<string, unknown> };
  }

  if (mutation.entityType !== 'task') {
    return {
      mutationId: mutation.mutationId,
      status: 'rejected',
      error: { code: 'VALIDATION_FAILED', detail: `Unsupported entity type: ${mutation.entityType}` },
    };
  }

  return db.transaction(async (tx) => {
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
      const payload = toColumnValues(sanitiseTaskPayload(mutation.payload));
      const [created] = await tx
        .insert(tasks)
        .values({
          id: mutation.entityId,
          workspaceId: actor.workspaceId,
          title: (payload.title as string) ?? 'Untitled task',
          ...payload,
          position: String(payload.position ?? Date.now()),
        } as never)
        .onConflictDoNothing()
        .returning();

      if (!created) {
        const existing = await tx.select().from(tasks).where(eq(tasks.id, mutation.entityId)).limit(1);
        const result = existing[0] ? (serialiseTask(existing[0]) as unknown as Record<string, unknown>) : {};
        await recordMutation(tx, actor.workspaceId, deviceId, mutation, 'duplicate', result);
        return { mutationId: mutation.mutationId, status: 'duplicate' as const, entity: result };
      }

      const result = serialiseTask(created) as unknown as Record<string, unknown>;
      await recordSyncChange(tx, {
        workspaceId: actor.workspaceId,
        entityType: 'task',
        entityId: created.id,
        operation: 'create',
        payload: result,
        version: created.version,
        deviceId,
      });
      await recordMutation(tx, actor.workspaceId, deviceId, mutation, 'applied', result);
      return { mutationId: mutation.mutationId, status: 'applied' as const, entity: result };
    }

    // ---- delete
    if (mutation.operation === 'delete') {
      if (!server) {
        await recordMutation(tx, actor.workspaceId, deviceId, mutation, 'duplicate', {});
        return { mutationId: mutation.mutationId, status: 'duplicate' as const };
      }
      const now = new Date();
      await tx
        .update(tasks)
        .set({ status: 'DELETED', deletedAt: now, updatedAt: now, version: sql`${tasks.version} + 1` })
        .where(eq(tasks.id, mutation.entityId));
      await tx
        .insert(syncTombstones)
        .values({
          id: newId(),
          workspaceId: actor.workspaceId,
          entityType: 'task',
          entityId: mutation.entityId,
          deletedAt: now,
          purgeAfter: new Date(now.getTime() + 30 * 86_400_000),
        })
        .onConflictDoNothing();
      await recordSyncChange(tx, {
        workspaceId: actor.workspaceId,
        entityType: 'task',
        entityId: mutation.entityId,
        operation: 'delete',
        payload: { id: mutation.entityId },
        version: server.version + 1,
        deviceId,
      });
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
      const [updated] = await tx
        .update(tasks)
        .set({ ...toColumnValues(merge.apply), updatedAt: new Date(), version: sql`${tasks.version} + 1` } as never)
        .where(eq(tasks.id, mutation.entityId))
        .returning();
      if (updated) {
        updatedEntity = serialiseTask(updated) as unknown as Record<string, unknown>;
        await recordSyncChange(tx, {
          workspaceId: actor.workspaceId,
          entityType: 'task',
          entityId: mutation.entityId,
          operation: 'update',
          payload: updatedEntity,
          version: updated.version,
          deviceId,
        });
      }
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
  workspaceId: string,
  conflictId: string,
  resolution: 'local' | 'server',
): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(conflictSnapshots)
      .where(and(eq(conflictSnapshots.id, conflictId), eq(conflictSnapshots.workspaceId, workspaceId)))
      .limit(1);
    const snapshot = rows[0];
    if (!snapshot) return;

    if (resolution === 'local') {
      const payload = toColumnValues(sanitiseTaskPayload(snapshot.localPayload as Record<string, unknown>));
      if (Object.keys(payload).length) {
        const [updated] = await tx
          .update(tasks)
          .set({ ...payload, updatedAt: new Date(), version: sql`${tasks.version} + 1` } as never)
          .where(eq(tasks.id, snapshot.entityId))
          .returning();
        if (updated) {
          await recordSyncChange(tx, {
            workspaceId,
            entityType: 'task',
            entityId: snapshot.entityId,
            operation: 'update',
            payload: serialiseTask(updated) as unknown as Record<string, unknown>,
            version: updated.version,
          });
        }
      }
    }

    await tx
      .update(conflictSnapshots)
      .set({ resolvedAt: new Date(), resolution })
      .where(eq(conflictSnapshots.id, conflictId));
  });
}
