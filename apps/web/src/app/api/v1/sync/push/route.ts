import { syncPushSchema } from '@nextdoo/contracts';
import { authedRoute, parseBody } from '@/server/http';
import { pushMutations } from '@/server/services/sync';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = authedRoute({ routeName: 'sync.push', rateLimitPerMinute: 60 }, async (request, ctx) => {
  const input = await parseBody(request, syncPushSchema);
  return pushMutations({ userId: ctx.auth.userId, workspaceId: ctx.auth.workspaceId }, input);
});
