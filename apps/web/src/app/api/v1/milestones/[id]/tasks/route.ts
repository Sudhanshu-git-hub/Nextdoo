import { taskLinkSchema } from '@nextdoo/contracts';
import { authedRoute, parseBody } from '@/server/http';
import { linkMilestoneTask } from '@/server/services/goals';
export const runtime = 'nodejs';
type Params = { params: Promise<{ id: string }> };
export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  return authedRoute({ routeName: 'milestones.tasks.link', idempotent: true, rateLimitPerMinute: 120 }, async (r, ctx) =>
    linkMilestoneTask({ userId: ctx.auth.userId, workspaceId: ctx.auth.workspaceId, requestId: ctx.requestId }, id, await parseBody(r, taskLinkSchema)),
  )(request);
}
