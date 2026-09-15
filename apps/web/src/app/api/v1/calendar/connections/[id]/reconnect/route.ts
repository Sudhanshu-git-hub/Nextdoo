import { z } from 'zod';
import { authedRoute, parseBody } from '@/server/http';
import { reconnectGoogleAuthorization } from '@/server/services/calendar-connections';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };
const body = z.object({ mode: z.enum(['READ_ONLY', 'READ_WRITE']).optional() });

/**
 * PRD §14.3 (PATCH :id semantics) + PRD §16.6 — the reconnect flow, also
 * used to change the sync mode (a scope change requires fresh consent, so
 * the credential-bound fields of the connection are replaced by a new
 * verified exchange).
 */
export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  return authedRoute({ routeName: 'calendar.connections.reconnect', rateLimitPerMinute: 60 }, async (r, ctx) => {
    const input = await parseBody(request, body);
    return reconnectGoogleAuthorization(ctx.auth.userId, id, input.mode);
  })(request);
}
