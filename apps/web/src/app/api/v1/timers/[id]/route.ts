import { updateTimerSchema } from '@nextdoo/contracts';
import { authedRoute, parseBody } from '@/server/http';
import { updateTimer } from '@/server/services/timers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return authedRoute({ routeName: 'timers.update', rateLimitPerMinute: 120 }, async (r, ctx) => {
    const input = await parseBody(r, updateTimerSchema);
    return updateTimer(
      { userId: ctx.auth.userId, workspaceId: ctx.auth.workspaceId, requestId: ctx.requestId },
      id,
      input.action,
      input.at,
    );
  })(request);
}
