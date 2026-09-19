import { AppError, recalculateRangeSchema } from '@nextdoo/contracts';
import { rateLimit } from '@/server/auth';
import { authedRoute, parseBody } from '@/server/http';
import { getTrackingBackfillProgress, requestTrackingBackfill } from '@/server/services/tracking-corrections';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * PRD §7.6 recalculation strategy: bounded backfill (default: last 90 days,
 * chunked by workspace and day, rate-limited). Historical results are
 * superseded, never mutated, and remain queryable.
 */
export async function POST(request: Request) {
  return authedRoute({ routeName: 'tracking.recalculate_range', idempotent: true, rateLimitPerMinute: 120 }, async (r, ctx) => {
    const input = await parseBody(r, recalculateRangeSchema);
    // PRD §14.8: "Recalculation jobs — 10 requests/hour/user". A distinct
    // bucket from the per-minute limiter; throwing (never returning a Response)
    // keeps the idempotency key unconsumed and the 429 intact — the replay
    // ledger only stores plain data.
    const { ok } = rateLimit(`tracking.recalculate_range.hour:${ctx.auth.userId}`, 10, 3_600_000);
    if (!ok) throw new AppError('RATE_LIMITED', 'Too many recalculation requests. Please slow down.');
    return requestTrackingBackfill({ ...ctx.auth, requestId: ctx.requestId }, input);
  })(request);
}

export const GET = authedRoute({ routeName: 'tracking.recalculate_range.status', rateLimitPerMinute: 300 }, async (_r, ctx) => {
  return getTrackingBackfillProgress({ ...ctx.auth, requestId: ctx.requestId });
});
