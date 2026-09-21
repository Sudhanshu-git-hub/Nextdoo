import { updateMilestoneSchema } from '@nextdoo/contracts';
import { authedRoute, parseBody } from '@/server/http';
import { updateMilestone } from '@/server/services/goals';
export const runtime = 'nodejs';
type Params = { params: Promise<{ id: string }> };
export async function PATCH(request: Request, { params }: Params) {
  const { id } = await params;
  return authedRoute({ routeName: 'milestones.update', idempotent: true, rateLimitPerMinute: 120 }, async (r, ctx) =>
    updateMilestone({ userId: ctx.auth.userId, workspaceId: ctx.auth.workspaceId, requestId: ctx.requestId }, id, await parseBody(r, updateMilestoneSchema)))(request);
}
