import { startTimerSchema } from '@nextdoo/contracts';
import { authedRoute, parseBody } from '@/server/http';
import { getActiveTimer, startTimer } from '@/server/services/timers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = authedRoute({ routeName: 'timers.active' }, async (_r, ctx) => ({
  timer: await getActiveTimer(ctx.auth.userId),
}));

export const POST = authedRoute({ routeName: 'timers.start', rateLimitPerMinute: 120 }, async (request, ctx) => {
  const input = await parseBody(request, startTimerSchema);
  return startTimer(
    { userId: ctx.auth.userId, workspaceId: ctx.auth.workspaceId, requestId: ctx.requestId },
    input.taskId,
    input.deviceId,
    input.startedAt,
  );
});
