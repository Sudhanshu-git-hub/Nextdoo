import { syncPullSchema } from '@nextdoo/contracts';
import { assertWorkspaceAccess } from '@/server/auth';
import { authedRoute, parseQuery } from '@/server/http';
import { pullChanges } from '@/server/services/sync';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = authedRoute({ routeName: 'sync.pull', rateLimitPerMinute: 600 }, async (request, ctx) => {
  const query = parseQuery(request, syncPullSchema);
  await assertWorkspaceAccess(ctx.auth.userId, query.workspaceId);
  return pullChanges(query.workspaceId, query.cursor, query.limit);
});
