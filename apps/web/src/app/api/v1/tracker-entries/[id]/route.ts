import { updateTrackerEntrySchema, trackerEntryVersionSchema } from '@nextdoo/contracts';
import { authedRoute, parseBody } from '@/server/http';
import { changeTrackerEntry, deleteTrackerEntry } from '@/server/services/personal-trackers';
export const runtime = 'nodejs';
type Params = { params: Promise<{ id: string }> };
export async function PATCH(request: Request, { params }: Params) {
  const { id } = await params;
  return authedRoute({ routeName: 'tracker_entries.update', idempotent: true, rateLimitPerMinute: 120 }, async (r, ctx) => changeTrackerEntry({ ...ctx.auth, requestId: ctx.requestId }, id, await parseBody(r, updateTrackerEntrySchema)))(request);
}
export async function DELETE(request: Request, { params }: Params) {
  const { id } = await params;
  return authedRoute({ routeName: 'tracker_entries.delete', idempotent: true, rateLimitPerMinute: 120 }, async (r, ctx) => deleteTrackerEntry({ ...ctx.auth, requestId: ctx.requestId }, id, (await parseBody(r, trackerEntryVersionSchema)).version))(request);
}
