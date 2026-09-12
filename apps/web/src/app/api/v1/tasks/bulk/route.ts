import { bulkTaskSchema } from '@nextdoo/contracts';
import { authedRoute, parseBody } from '@/server/http';
import { bulkTasks } from '@/server/services/task-bulk';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const POST = authedRoute({ routeName: 'tasks.bulk', rateLimitPerMinute: 10, idempotent: true }, async (request, ctx) => {
  const input = await parseBody(request, bulkTaskSchema);
  return bulkTasks({ userId: ctx.auth.userId, workspaceId: ctx.auth.workspaceId, requestId: ctx.requestId }, input);
});
