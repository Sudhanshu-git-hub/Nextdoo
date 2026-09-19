import { authedRoute } from '@/server/http';
import { listCalendarConflicts } from '@/server/services/calendar-connections';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/**
 * PRD §16.4 — list a connection's both-side conflicts: both values are
 * shown so the user can choose keep-NEXTDOO / keep-calendar / unlink.
 */
export async function GET(request: Request, { params }: Params) {
  const { id } = await params;
  return authedRoute({ routeName: 'calendar.conflicts.list', rateLimitPerMinute: 300 }, async (_r, ctx) => ({
    conflicts: await listCalendarConflicts(ctx.auth.userId, id),
  }))(request);
}
