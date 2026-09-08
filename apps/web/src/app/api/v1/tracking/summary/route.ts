import { summaryQuerySchema } from '@nextdoo/contracts';
import { assertWorkspaceAccess } from '@/server/auth';
import { authedRoute, parseQuery } from '@/server/http';
import { getSummary } from '@/server/services/tracking';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = authedRoute({ routeName: 'tracking.summary', rateLimitPerMinute: 300 }, async (request, ctx) => {
  const query = parseQuery(request, summaryQuerySchema);
  await assertWorkspaceAccess(ctx.auth.userId, query.workspaceId);
  const reference = query.date ? new Date(`${query.date}T12:00:00Z`) : new Date();
  return getSummary(query.workspaceId, query.period, reference);
});
