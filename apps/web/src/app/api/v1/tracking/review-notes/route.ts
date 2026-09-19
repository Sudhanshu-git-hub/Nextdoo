import { reviewNoteBodySchema, reviewNoteQuerySchema } from '@nextdoo/contracts';
import { authedRoute, parseBody, parseQuery } from '@/server/http';
import { deleteReviewNote, getReviewNote, saveReviewNote } from '@/server/services/review-notes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = authedRoute({ routeName: 'tracking.reviewNote.get', rateLimitPerMinute: 300 }, async (request, ctx) => {
  const query = parseQuery(request, reviewNoteQuerySchema);
  return getReviewNote(ctx.auth.userId, query.workspaceId, query.day);
});

export const PUT = authedRoute({ routeName: 'tracking.reviewNote.save', idempotent: true, rateLimitPerMinute: 120 }, async (request, ctx) => {
  const query = parseQuery(request, reviewNoteQuerySchema);
  const body = await parseBody(request, reviewNoteBodySchema);
  return saveReviewNote(ctx.auth.userId, query.workspaceId, query.day, body.body);
});

export const DELETE = authedRoute({ routeName: 'tracking.reviewNote.delete', idempotent: true, rateLimitPerMinute: 120 }, async (request, ctx) => {
  const query = parseQuery(request, reviewNoteQuerySchema);
  await deleteReviewNote(ctx.auth.userId, query.workspaceId, query.day);
});
