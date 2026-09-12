import { authedRoute } from '@/server/http';
import { getEntitlementSnapshot } from '@/server/services/entitlements';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * PRD §18.1: the server-configured entitlement snapshot — plan, configured
 * limits, and current usage. Clients display and pre-warn from this, but the
 * server re-checks every limit on every mutating request; this endpoint is
 * informational, never the source of truth for access.
 */
export const GET = authedRoute({ routeName: 'entitlements.get', rateLimitPerMinute: 120 }, async (_request, ctx) => {
  return getEntitlementSnapshot(ctx.auth.userId, ctx.auth.workspaceId);
});
