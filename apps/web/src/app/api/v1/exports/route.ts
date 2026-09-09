import { exportQuerySchema, requestExportSchema } from '@nextdoo/contracts';
import { authedRoute, parseBody, parseQuery } from '@/server/http';
import { listExports, requestExport } from '@/server/services/exports';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = authedRoute({ routeName: 'exports.list', rateLimitPerMinute: 600 }, async (request, ctx) => {
  const query = parseQuery(request, exportQuerySchema);
  const { data, nextCursor, hasMore } = await listExports(ctx.auth, query);
  return { data, pagination: { next_cursor: nextCursor, has_more: hasMore } };
});

export const POST = authedRoute(
  { routeName: 'exports.create', rateLimitPerMinute: 120, idempotent: true },
  async (request, ctx) => {
    const input = await parseBody(request, requestExportSchema);
    return requestExport(ctx.auth, { ...input, requestId: ctx.requestId });
  },
);
