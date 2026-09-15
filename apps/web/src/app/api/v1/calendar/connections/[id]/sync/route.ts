import { authedRoute } from '@/server/http';
import { syncConnectionNow } from '@/server/services/calendar-connections';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/**
 * PRD §14.3 POST /calendar/connections/:id/sync — a manual sync now: one
 * import pass plus (for READ_WRITE) one export pass. Rate-limited provider
 * responses are reported, not retried in-line.
 */
export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  return authedRoute({ routeName: 'calendar.connections.sync', rateLimitPerMinute: 60 }, async (_r, ctx) =>
    syncConnectionNow(ctx.auth.userId, id),
  )(request);
}
