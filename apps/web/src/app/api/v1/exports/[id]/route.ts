import { authedRoute } from '@/server/http';
import { getExport } from '@/server/services/exports';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return authedRoute({ routeName: 'exports.get', rateLimitPerMinute: 600 }, async (_request, ctx) => {
    return getExport(ctx.auth, id);
  })(request);
}
