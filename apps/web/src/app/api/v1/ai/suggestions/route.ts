import { z } from 'zod';
import { authedRoute, parseBody } from '@/server/http';
import { listSuggestions } from '@/server/services/suggestions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const suggestionsBody = z
  .object({
    period: z.enum(['day', 'week']).optional(),
    /** Local date (YYYY-MM-DD) for the window; omitted = the current day/week. */
    dateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })
  .strict();

/**
 * PRD §14.3/§5.5 — generate advisory suggestions (deterministic heuristic
 * provider; model-backed variants are deferred per §17). Read-only: identical
 * state yields identical suggestions and the call mutates no task, project,
 * calendar or reminder data.
 */
export const POST = authedRoute({ routeName: 'ai.suggestions', rateLimitPerMinute: 120 }, async (request, ctx) => {
  const body = await parseBody(request, suggestionsBody);
  return listSuggestions(
    { userId: ctx.auth.userId, workspaceId: ctx.auth.workspaceId },
    { period: body.period ?? 'day', dateKey: body.dateKey ?? null },
  );
});
