import { z } from 'zod';
import { publicRoute, parseBody } from '@/server/http';
import { handleCalendarWebhook } from '@/server/services/calendar-connections';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const body = z.object({
  channel: z.object({ token: z.string().uuid() }).optional(),
  resource: z.string().optional(),
  eventId: z.string().optional(),
});

/**
 * PRD §16.1 — the Google push-notification channel target. Unauthenticated
 * by design: the channel token (the connection id, which Google echoes
 * back) scopes the import to exactly that connection. Unknown tokens are
 * ignored (200, nothing done) so a stale channel cannot error-loop.
 */
export async function POST(request: Request) {
  return publicRoute({ routeName: 'calendar.webhook', rateLimitPerMinute: 300 }, async (_r) => {
    const input = await parseBody(request, body);
    const token = input.channel?.token;
    if (!token) return { ok: false, imported: 0 };
    return handleCalendarWebhook(token);
  })(request);
}
