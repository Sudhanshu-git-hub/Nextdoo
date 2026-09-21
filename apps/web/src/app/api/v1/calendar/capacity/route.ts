import { z } from 'zod';
import { assertWorkspaceAccess } from '@/server/auth';
import { authedRoute, parseQuery } from '@/server/http';
import { getDayCapacity } from '@/server/services/capacity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const querySchema = z.object({
  workspaceId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).strict();

/**
 * PRD §8.3 (daily planning) — daily capacity for one workspace day. Added to
 * the core endpoints (PRD §14.3): the screen must show estimated workload and
 * available work capacity computed over the full collection, which only the
 * server can do.
 */
export async function GET(request: Request) {
  return authedRoute({ routeName: 'calendar.capacity.get', rateLimitPerMinute: 600 }, async (r, ctx) => {
    const query = parseQuery(r, querySchema);
    await assertWorkspaceAccess(ctx.auth.userId, query.workspaceId);
    return getDayCapacity(ctx.auth.userId, query.workspaceId, query.date);
  })(request);
}
