import { authedRoute } from '@/server/http';
import { listSessions } from '@/server/services/account-sessions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * PRD §6.1/§14.3 — the caller's active sessions (owner-scoped). Display
 * fields only: device label, last seen, created, current-session flag.
 * Raw tokens and IP digests are never returned.
 */
export const GET = authedRoute({ routeName: 'me.sessions.list', rateLimitPerMinute: 120 }, async (_request, ctx) =>
  listSessions(ctx.auth.userId, ctx.auth.sessionId),
);
