import { summaryQuerySchema } from '@nextdoo/contracts';
import { assertWorkspaceAccess } from '@/server/auth';
import { authedRoute, parseQuery } from '@/server/http';
import { getSummary } from '@/server/services/tracking';
import { scoresEnabled } from '@/server/services/tracking-freshness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = authedRoute({ routeName: 'tracking.summary', rateLimitPerMinute: 300 }, async (request, ctx) => {
  const query = parseQuery(request, summaryQuerySchema);
  await assertWorkspaceAccess(ctx.auth.userId, query.workspaceId);
  const reference = query.date ? new Date(`${query.date}T12:00:00Z`) : new Date();
  const { averageScore, ...summary } = await getSummary(query.workspaceId, query.period, reference);
  const enabled = await scoresEnabled(ctx.auth.userId);
  return { ...summary, scoresEnabled: enabled, ...(enabled ? { averageScore } : {}) };
});
