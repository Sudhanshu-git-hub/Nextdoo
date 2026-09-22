import { createTrackerSchema, trackerListSchema } from '@nextdoo/contracts';
import { authedRoute, parseBody, parseQuery } from '@/server/http';
import { createTracker, listTrackers } from '@/server/services/personal-trackers';
export const runtime = 'nodejs';
export const GET = authedRoute({ routeName: 'trackers.list' }, async (r, ctx) => listTrackers(ctx.auth.workspaceId, parseQuery(r, trackerListSchema)));
export const POST = authedRoute({ routeName: 'trackers.create', idempotent: true, rateLimitPerMinute: 60 }, async (r, ctx) =>
  createTracker({ ...ctx.auth, requestId: ctx.requestId }, await parseBody(r, createTrackerSchema)));
