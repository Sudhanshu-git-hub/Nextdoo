import { trackerEntryVersionSchema } from '@nextdoo/contracts';
import { authedRoute, parseBody } from '@/server/http';
import { restoreTrackerEntry } from '@/server/services/personal-trackers';
export const runtime = 'nodejs';
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return authedRoute({ routeName: 'tracker_entries.restore', idempotent: true, rateLimitPerMinute: 120 }, async (r, ctx) => restoreTrackerEntry({ ...ctx.auth, requestId: ctx.requestId }, id, (await parseBody(r, trackerEntryVersionSchema)).version))(request);
}
