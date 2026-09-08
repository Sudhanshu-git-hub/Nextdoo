import { z } from 'zod';
import { completeTaskSchema, rescheduleTaskSchema } from '@nextdoo/contracts';
import { authedRoute, parseBody } from '@/server/http';
import { archiveTask, completeTask, reopenTask, rescheduleTask, restoreTask } from '@/server/services/tasks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const versionSchema = z.object({ version: z.number().int().min(1) });

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return authedRoute({ routeName: 'tasks.reopen', rateLimitPerMinute: 120, idempotent: true }, async (r, ctx) => {
    const actor = { userId: ctx.auth.userId, workspaceId: ctx.auth.workspaceId, requestId: ctx.requestId };
    const input = await parseBody(r, versionSchema);
    return reopenTask(actor, id, input.version);
  })(request);
}
