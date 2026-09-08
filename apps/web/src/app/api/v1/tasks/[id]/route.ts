import { optionalTaskVersionSchema, updateTaskSchema } from '@nextdoo/contracts';
import { authedRoute, parseBody, parseOptionalBody } from '@/server/http';
import { deleteTask, getTaskDetails, updateTask } from '@/server/services/tasks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
  const { id } = await params;
  return authedRoute({ routeName: 'tasks.get' }, async (_r, ctx) =>
    getTaskDetails(ctx.auth.workspaceId, id),
  )(request);
}

export async function PATCH(request: Request, { params }: Params) {
  const { id } = await params;
  return authedRoute({ routeName: 'tasks.update', idempotent: true, rateLimitPerMinute: 120 }, async (r, ctx) => {
    const input = await parseBody(r, updateTaskSchema);
    return updateTask({ userId: ctx.auth.userId, workspaceId: ctx.auth.workspaceId, requestId: ctx.requestId }, id, input);
  })(request);
}

export async function DELETE(request: Request, { params }: Params) {
  const { id } = await params;
  return authedRoute({ routeName: 'tasks.delete', idempotent: true, rateLimitPerMinute: 120 }, async (r, ctx) => {
    const input = await parseOptionalBody(r, optionalTaskVersionSchema);
    await deleteTask({ userId: ctx.auth.userId, workspaceId: ctx.auth.workspaceId, requestId: ctx.requestId }, id, input?.version);
    return { ok: true };
  })(request);
}
