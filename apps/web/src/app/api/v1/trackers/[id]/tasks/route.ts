import { trackerTaskLinkSchema } from '@nextdoo/contracts';
import { authedRoute, parseBody } from '@/server/http';
import { linkTrackerTask } from '@/server/services/personal-trackers';
export const runtime = 'nodejs';
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return authedRoute({ routeName: 'trackers.tasks', idempotent: true, rateLimitPerMinute: 120 }, async (r, ctx) => linkTrackerTask({ ...ctx.auth, requestId: ctx.requestId }, id, await parseBody(r, trackerTaskLinkSchema)))(request);
}
