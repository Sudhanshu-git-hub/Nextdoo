import { createMilestoneSchema } from '@nextdoo/contracts';
import { authedRoute, parseBody } from '@/server/http';
import { createMilestone } from '@/server/services/goals';
export const runtime = 'nodejs';
type Params = { params: Promise<{ id: string }> };
export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  return authedRoute({ routeName: 'goals.milestones.create', idempotent: true, rateLimitPerMinute: 60 }, async (r, ctx) =>
    createMilestone({ userId: ctx.auth.userId, workspaceId: ctx.auth.workspaceId, requestId: ctx.requestId }, id, await parseBody(r, createMilestoneSchema)))(request);
}
