import { createTaskSchema, taskQuerySchema } from '@nextdoo/contracts';
import { assertWorkspaceAccess } from '@/server/auth';
import { authedRoute, parseBody, parseQuery } from '@/server/http';
import { createTask, queryTasks } from '@/server/services/tasks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = authedRoute({ routeName: 'tasks.list', rateLimitPerMinute: 600 }, async (request, ctx) => {
  const query = parseQuery(request, taskQuerySchema);
  await assertWorkspaceAccess(ctx.auth.userId, query.workspaceId);
  const { data, nextCursor, hasMore } = await queryTasks(query.workspaceId, query);
  return { data, pagination: { next_cursor: nextCursor, has_more: hasMore } };
});

export const POST = authedRoute(
  { routeName: 'tasks.create', rateLimitPerMinute: 120, idempotent: true },
  async (request, ctx) => {
    const input = await parseBody(request, createTaskSchema);
    await assertWorkspaceAccess(ctx.auth.userId, input.workspaceId);
    return createTask(
      { userId: ctx.auth.userId, workspaceId: input.workspaceId, requestId: ctx.requestId },
      input,
    );
  },
);
