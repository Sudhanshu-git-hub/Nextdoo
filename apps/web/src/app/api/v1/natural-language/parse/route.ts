import { parseTextSchema } from '@nextdoo/contracts';
import { parseTaskText } from '@nextdoo/core';
import { authedRoute, parseBody } from '@/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Deterministic parse — no model call, no network, works offline.
 * Returns structured fields with confidence; the client must confirm when
 * `requiresConfirmation` is true (PRD §6.10).
 */
export const POST = authedRoute({ routeName: 'nl.parse', rateLimitPerMinute: 120 }, async (request) => {
  const input = await parseBody(request, parseTextSchema);
  return parseTaskText(input.text, input.timeZone, input.now ? new Date(input.now) : undefined);
});
