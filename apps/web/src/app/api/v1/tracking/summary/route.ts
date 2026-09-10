import { summaryQuerySchema, type DayPoint } from '@nextdoo/contracts';

/** A day point with the score figure optional so scores can be stripped (PRD §7.2). */
type ScoreOptionalDay = Omit<DayPoint, 'score'> & { score?: number | null };
import { assertWorkspaceAccess } from '@/server/auth';
import { authedRoute, parseQuery } from '@/server/http';
import { assertHistoryWindow } from '@/server/services/entitlements';
import { getSummary } from '@/server/services/tracking';
import { scoresEnabled } from '@/server/services/tracking-freshness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = authedRoute({ routeName: 'tracking.summary', rateLimitPerMinute: 300 }, async (request, ctx) => {
  const query = parseQuery(request, summaryQuerySchema);
  await assertWorkspaceAccess(ctx.auth.userId, query.workspaceId);
  // PRD §18.1: Free historical analytics are bounded to 30 days.
  await assertHistoryWindow(ctx.auth.userId, query.workspaceId, query.date ?? null);
  // `date` is a local calendar date in the workspace zone (or today).
  const summary = await getSummary(query.workspaceId, query.period, query.date ?? null);
  const enabled = await scoresEnabled(ctx.auth.userId);
  // Scores off: strip the score figures everywhere (PRD §7.2), including the
  // per-day trend. `undefined` values drop out of the JSON response.
  const days: ScoreOptionalDay[] = summary.days.map(({ score, ...rest }) => ({ ...rest, score: enabled ? score : undefined }));
  return { ...summary, days, scoresEnabled: enabled, ...(enabled ? { averageScore: summary.averageScore } : {}) };
});
