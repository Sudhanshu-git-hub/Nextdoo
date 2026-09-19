import { z } from 'zod';
import { authedRoute, parseBody } from '@/server/http';
import { startGoogleAuthorization } from '@/server/services/calendar-connections';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const body = z.object({ mode: z.enum(['READ_ONLY', 'READ_WRITE']) });

/**
 * PRD §14.3 POST /calendar/connections/google/start — the sync mode is
 * chosen BEFORE authorization (PRD §16.2). Returns the OAuth redirect URL;
 * the client navigates to it. 503 PROVIDER_UNAVAILABLE when the deployment
 * has no Google credentials (the UI degrades honestly).
 */
export async function POST(request: Request) {
  return authedRoute({ routeName: 'calendar.google.start', rateLimitPerMinute: 60 }, async (r, ctx) => {
    const input = await parseBody(request, body);
    return startGoogleAuthorization(ctx.auth.userId, ctx.auth.workspaceId, input.mode);
  })(request);
}
