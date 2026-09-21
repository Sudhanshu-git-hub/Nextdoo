import { updateGoalSchema } from '@nextdoo/contracts';
import { authedRoute, parseBody } from '@/server/http';
import { goalDetail, updateGoal } from '@/server/services/goals';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
  const { id } = await params;
  return authedRoute({ routeName: 'goals.get' }, async (_r, ctx) => goalDetail(ctx.auth.workspaceId, id))(request);
}
export async function PATCH(request: Request, { params }: Params) {
  const { id } = await params;
  return authedRoute({ routeName: 'goals.update', rateLimitPerMinute: 120, idempotent: true }, async (r, ctx) =>
    updateGoal({ userId: ctx.auth.userId, workspaceId: ctx.auth.workspaceId, requestId: ctx.requestId }, id, await parseBody(r, updateGoalSchema)),
  )(request);
}
