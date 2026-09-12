import { createSubtaskSchema } from '@nextdoo/contracts';
import { authedRoute, parseBody } from '@/server/http';
import { createSubtask } from '@/server/services/task-relations';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return authedRoute({ routeName: 'tasks.subtasks.create', idempotent: true, rateLimitPerMinute: 120 }, async (r, ctx) =>
    createSubtask({ ...ctx.auth, requestId: ctx.requestId }, id, await parseBody(r, createSubtaskSchema)),
  )(request);
}
