import { updateTaskSchema } from '@nextdoo/contracts';
import { authedRoute, parseBody } from '@/server/http';
import { deleteTask, loadTask, serialiseTask, updateTask } from '@/server/services/tasks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
  const { id } = await params;
  return authedRoute({ routeName: 'tasks.get' }, async (_r, ctx) =>
    serialiseTask(await loadTask(ctx.auth.workspaceId, id)),
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
  return authedRoute({ routeName: 'tasks.delete', idempotent: true, rateLimitPerMinute: 120 }, async (_r, ctx) => {
    await deleteTask({ userId: ctx.auth.userId, workspaceId: ctx.auth.workspaceId, requestId: ctx.requestId }, id);
    return { ok: true };
  })(request);
}
