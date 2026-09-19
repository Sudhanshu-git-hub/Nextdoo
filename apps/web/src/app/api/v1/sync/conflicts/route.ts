import { authedRoute } from '@/server/http';
import { listConflicts } from '@/server/services/sync';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Unresolved conflict snapshots for the signed-in workspace (PRD §8.6/§10.6).
 *
 * Tenant isolation is structural: the service reads only rows of the
 * authenticated workspace, so no other tenant's content can be enumerated.
 */
export const GET = authedRoute({ routeName: 'sync.conflicts.list', rateLimitPerMinute: 600 }, async (_request, ctx) => ({
  data: await listConflicts(ctx.auth.workspaceId),
}));
