import { createGoalSchema, goalQuerySchema } from '@nextdoo/contracts';
import { assertWorkspaceAccess } from '@/server/auth';
import { authedRoute, parseBody, parseQuery } from '@/server/http';
import { createGoal, listGoals } from '@/server/services/goals';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = authedRoute({ routeName: 'goals.list' }, async (request, ctx) => {
  const query = parseQuery(request, goalQuerySchema);
  return listGoals(ctx.auth.workspaceId, query);
});

export const POST = authedRoute({ routeName: 'goals.create', rateLimitPerMinute: 60, idempotent: true }, async (request, ctx) => {
  const input = await parseBody(request, createGoalSchema);
  await assertWorkspaceAccess(ctx.auth.userId, input.workspaceId);
  return createGoal({ userId: ctx.auth.userId, workspaceId: ctx.auth.workspaceId, requestId: ctx.requestId }, input);
});
