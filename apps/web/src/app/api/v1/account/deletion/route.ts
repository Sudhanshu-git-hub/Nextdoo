import { accountDeletionSchema } from '@nextdoo/contracts';
import { authedRoute, parseBody } from '@/server/http';
import { cancelAccountDeletion, getDeletionStatus, requestAccountDeletion } from '@/server/services/data-rights';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = authedRoute({ routeName: 'account.deletion_status' }, async (_r, ctx) =>
  getDeletionStatus(ctx.auth.userId),
);

/**
 * Schedules deletion after a 30-day grace period. Requires the password again,
 * so a hijacked session alone cannot destroy the account.
 */
export const POST = authedRoute({ routeName: 'account.deletion_request', rateLimitPerMinute: 5 }, async (request, ctx) => {
  const input = await parseBody(request, accountDeletionSchema);
  return requestAccountDeletion(ctx.auth.userId, input.password);
});

/** Cancels a pending deletion. */
export const DELETE = authedRoute({ routeName: 'account.deletion_cancel', rateLimitPerMinute: 10 }, async (_r, ctx) => {
  await cancelAccountDeletion(ctx.auth.userId);
  return { scheduled: false, requestedAt: null, purgeAfter: null };
});
