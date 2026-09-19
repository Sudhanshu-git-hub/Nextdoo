import { applyTrackingCorrectionSchema, uuid } from '@nextdoo/contracts';
import { authedRoute, parseBody } from '@/server/http';
import { applyTrackingCorrection } from '@/server/services/tracking-corrections';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/**
 * PRD §7.7 score corrections: due-date correction, externally blocked,
 * untracked completion, analytics exclusion. Every row is immutable; the
 * latest per (task, kind) is effective; undo inserts a new CLEAR row.
 */
export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  return authedRoute({ routeName: 'tracking.correction.apply', idempotent: true, rateLimitPerMinute: 60 }, async (r, ctx) => {
    const input = await parseBody(r, applyTrackingCorrectionSchema);
    return applyTrackingCorrection({ ...ctx.auth, requestId: ctx.requestId }, uuid.parse(id), input);
  })(request);
}
