import { authedRoute } from '@/server/http';
import { disconnectConnection } from '@/server/services/calendar-connections';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/** PRD §14.3: disconnect a calendar (soft state change, tenant-scoped). */
export async function DELETE(request: Request, { params }: Params) {
  const { id } = await params;
  return authedRoute({ routeName: 'calendar.connections.disconnect', rateLimitPerMinute: 120, idempotent: true }, async (_r, ctx) =>
    disconnectConnection(ctx.auth.userId, id),
  )(request);
}
