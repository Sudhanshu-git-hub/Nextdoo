import { updateTrackerSchema } from '@nextdoo/contracts';
import { authedRoute, parseBody } from '@/server/http';
import { trackerDetail, updateTracker } from '@/server/services/personal-trackers';
export const runtime = 'nodejs';
type Params = { params: Promise<{ id: string }> };
export async function GET(request: Request, { params }: Params) {
  const { id } = await params;
  return authedRoute({ routeName: 'trackers.detail' }, async (r, ctx) => trackerDetail(ctx.auth.workspaceId, id, Object.fromEntries(new URL(r.url).searchParams)))(request);
}
export async function PATCH(request: Request, { params }: Params) {
  const { id } = await params;
  return authedRoute({ routeName: 'trackers.update', idempotent: true, rateLimitPerMinute: 120 }, async (r, ctx) => updateTracker({ ...ctx.auth, requestId: ctx.requestId }, id, await parseBody(r, updateTrackerSchema)))(request);
}
