import { updateProjectSchema } from '@nextdoo/contracts';
import { authedRoute, parseBody } from '@/server/http';
import { loadProject, updateProject } from '@/server/services/projects';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Params = { params: Promise<{ id: string }> };
export async function GET(request: Request, { params }: Params) {
  const { id } = await params;
  return authedRoute({ routeName: 'projects.get' }, async (_r, ctx) => loadProject(ctx.auth.workspaceId, id))(request);
}
export async function PATCH(request: Request, { params }: Params) {
  const { id } = await params;
  return authedRoute({ routeName: 'projects.update', idempotent: true, rateLimitPerMinute: 120 }, async (r, ctx) =>
    updateProject({ userId: ctx.auth.userId, workspaceId: ctx.auth.workspaceId, requestId: ctx.requestId }, id, await parseBody(r, updateProjectSchema)),
  )(request);
}
