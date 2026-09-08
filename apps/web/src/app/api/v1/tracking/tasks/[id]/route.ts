import { authedRoute } from '@/server/http';
import { getResultForTask, listTrackingEvents } from '@/server/services/tracking';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Returns the result plus the source events, so every score is explainable. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return authedRoute({ routeName: 'tracking.task' }, async (_r, ctx) => {
    const [result, events] = await Promise.all([
      getResultForTask(ctx.auth.workspaceId, id),
      listTrackingEvents(ctx.auth.workspaceId, id),
    ]);
    return { result, events };
  })(request);
}
