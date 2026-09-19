import { AppError, notFound, syncConflictResolveSchema, uuid } from '@nextdoo/contracts';
import { authedRoute, parseBody } from '@/server/http';
import { loadConflictSnapshot, resolveConflict } from '@/server/services/sync';
import { loadTask } from '@/server/services/tasks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Resolves one conflict snapshot (PRD §10.6).
 *
 * - `server` keeps the canonical row as-is and marks the snapshot resolved.
 * - `local` re-applies the preserved local payload through the same task
 *   command path the rest of the API uses, so task invariants, versioning and
 *   sync change emission are identical to an online edit.
 *
 * Idempotent: an unchanged retry with the same Idempotency-Key replays the
 * original acknowledgement, and resolving an already-resolved snapshot is a
 * safe no-op.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return authedRoute(
    { routeName: 'sync.conflicts.resolve', idempotent: true, rateLimitPerMinute: 120 },
    async (r, ctx) => {
      const { resolution } = await parseBody(r, syncConflictResolveSchema);
      if (uuid.safeParse(id).success === false) throw notFound('conflict', id);

      const snapshot = await loadConflictSnapshot(ctx.auth.workspaceId, id);
      if (!snapshot) throw notFound('conflict', id);

      if (resolution === 'local' && snapshot.entityType === 'task') {
        let target: { status: string } | null = null;
        try {
          target = await loadTask(ctx.auth.workspaceId, snapshot.entityId);
        } catch {
          target = null;
        }
        if (!target || target.status === 'DELETED') {
          throw new AppError(
            'RESOURCE_VERSION_CONFLICT',
            'The task was deleted on another device, so the local version cannot be applied. Keep the server state, or restore the task first.',
          );
        }
      }

      await resolveConflict(
        { userId: ctx.auth.userId, workspaceId: ctx.auth.workspaceId, requestId: ctx.requestId },
        snapshot.id,
        resolution,
      );
      return { conflictId: snapshot.id, resolution, resolved: true };
    },
  )(request);
}
