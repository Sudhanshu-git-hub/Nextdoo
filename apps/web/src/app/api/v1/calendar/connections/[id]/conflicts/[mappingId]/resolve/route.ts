import { z } from 'zod';
import { authedRoute, parseBody } from '@/server/http';
import { resolveCalendarConflict } from '@/server/services/calendar-connections';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string; mappingId: string }> };
const body = z.object({ action: z.enum(['KEEP_TASK', 'KEEP_CALENDAR', 'UNLINK']) });

/**
 * PRD §16.4 — resolve a both-side conflict. KEEP_TASK patches the external
 * event to the task's current values; KEEP_CALENDAR reschedules the task
 * to the external time through the task invariants; UNLINK removes the
 * mapping (both sides keep their data). Every decision is audit-logged.
 * Idempotent at the route: client retries replay the recorded response.
 */
export async function POST(request: Request, { params }: Params) {
  const { id, mappingId } = await params;
  return authedRoute({ routeName: 'calendar.conflicts.resolve', rateLimitPerMinute: 120, idempotent: true }, async (r, ctx) => {
    const input = await parseBody(request, body);
    return resolveCalendarConflict(ctx.auth.userId, id, mappingId, input.action);
  })(request);
}
