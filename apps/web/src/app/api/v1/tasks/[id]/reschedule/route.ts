import { rescheduleTaskSchema } from '@nextdoo/contracts';
import { authedRoute, parseBody } from '@/server/http';
import { rescheduleTask } from '@/server/services/tasks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';


export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return authedRoute({ routeName: 'tasks.reschedule', rateLimitPerMinute: 120, idempotent: true }, async (r, ctx) => {
    const actor = { userId: ctx.auth.userId, workspaceId: ctx.auth.workspaceId, requestId: ctx.requestId };
    const input = await parseBody(r, rescheduleTaskSchema);
    return rescheduleTask(actor, id, input.version, input.dueAt, input.reason);
  })(request);
}
