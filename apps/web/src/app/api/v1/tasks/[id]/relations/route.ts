import { updateTaskRelationsSchema } from '@nextdoo/contracts';
import { authedRoute, parseBody } from '@/server/http';
import { getTaskRelations, updateTaskRelations } from '@/server/services/task-relations';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Params = { params: Promise<{ id: string }> };
export async function GET(request: Request, { params }: Params) {
  const { id } = await params;
  return authedRoute({ routeName: 'tasks.relations' }, (_r, ctx) => getTaskRelations(ctx.auth.workspaceId, id))(request);
}
export async function PATCH(request: Request, { params }: Params) {
  const { id } = await params;
  return authedRoute({ routeName: 'tasks.relations.update', idempotent: true, rateLimitPerMinute: 120 }, async (r, ctx) =>
    updateTaskRelations({ ...ctx.auth, requestId: ctx.requestId }, id, await parseBody(r, updateTaskRelationsSchema)),
  )(request);
}
