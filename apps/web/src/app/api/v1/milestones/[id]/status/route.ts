import { goalStatusSchema } from '@nextdoo/contracts';
import { authedRoute, parseBody } from '@/server/http';
import { setMilestoneStatus } from '@/server/services/goals';
export const runtime = 'nodejs';
type Params = { params: Promise<{ id: string }> };
export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  return authedRoute({ routeName: 'milestones.status', idempotent: true, rateLimitPerMinute: 120 }, async (r, ctx) => {
    const input = await parseBody(r, goalStatusSchema);
    return setMilestoneStatus({ userId: ctx.auth.userId, workspaceId: ctx.auth.workspaceId, requestId: ctx.requestId }, id, input.version, input.status);
  })(request);
}
