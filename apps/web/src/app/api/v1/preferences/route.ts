import { wellbeingPreferencesPatchSchema } from '@nextdoo/contracts';
import { authedRoute, parseBody } from '@/server/http';
import { getWellbeingPreferences, setWellbeingPreferences } from '@/server/services/preferences';

/**
 * PRD §7.9 Wellbeing Controls — the user's own display preferences
 * (MVP: the independent "overload warnings" toggle). Preferences only
 * change what is shown to the user; they never change tracked data or
 * task plans.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = authedRoute({ routeName: 'preferences.get', rateLimitPerMinute: 120 }, async (_request, ctx) =>
  getWellbeingPreferences(ctx.auth.userId),
);

export const PATCH = authedRoute({ routeName: 'preferences.update', rateLimitPerMinute: 30, idempotent: true }, async (request, ctx) =>
  setWellbeingPreferences(ctx.auth.userId, await parseBody(request, wellbeingPreferencesPatchSchema)),
);
