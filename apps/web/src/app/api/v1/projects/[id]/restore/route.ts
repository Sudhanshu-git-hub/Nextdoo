import { projectVersionSchema } from '@nextdoo/contracts';
import { authedRoute, parseBody } from '@/server/http';
import { setProjectArchived } from '@/server/services/projects';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return authedRoute({ routeName: 'projects.restore', idempotent: true, rateLimitPerMinute: 120 }, async (r, ctx) => {
    const input = await parseBody(r, projectVersionSchema);
    return setProjectArchived({ userId: ctx.auth.userId, workspaceId: ctx.auth.workspaceId, requestId: ctx.requestId }, id, input.version, false);
  })(request);
}
