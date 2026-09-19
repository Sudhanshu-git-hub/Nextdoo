import { authedRoute } from '@/server/http';
import { listConnections } from '@/server/services/calendar-connections';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** PRD §14.3: list calendar connections (metadata only, never tokens). */
export async function GET(request: Request) {
  return authedRoute({ routeName: 'calendar.connections.list', rateLimitPerMinute: 600 }, async (_r, ctx) => ({
    connections: await listConnections(ctx.auth.userId),
  }))(request);
}
