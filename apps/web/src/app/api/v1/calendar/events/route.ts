import { z } from 'zod';
import { authedRoute, parseQuery } from '@/server/http';
import { listCalendarEvents } from '@/server/services/calendar-connections';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const query = z.object({
  start: z.string().datetime({ offset: true }).or(z.string().datetime()),
  end: z.string().datetime({ offset: true }).or(z.string().datetime()),
});

/**
 * PRD §14.3 GET /calendar/events — normalized provider events for a window
 * (the read-only provider data behind the day view). Scope: the caller's
 * ACTIVE connections only; never tokens, never other tenants.
 */
export async function GET(request: Request) {
  return authedRoute({ routeName: 'calendar.events.list', rateLimitPerMinute: 600 }, async (_r, ctx) => {
    const { start, end } = parseQuery(request, query);
    return { events: await listCalendarEvents(ctx.auth.userId, start, end) };
  })(request);
}
