import { projectAnalyticsQuerySchema } from '@nextdoo/contracts';
import { authedRoute, parseQuery } from '@/server/http';
import { getProjectAnalytics } from '@/server/services/project-analytics';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return authedRoute({ routeName: 'projects.analytics', rateLimitPerMinute: 120 }, async (r, ctx) =>
    getProjectAnalytics(ctx.auth, id, parseQuery(r, projectAnalyticsQuerySchema)),
  )(request);
}
