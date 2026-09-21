import { optionalTaskVersionSchema } from '@nextdoo/contracts';
import { authedRoute, parseOptionalBody } from '@/server/http';
import { restoreTask } from '@/server/services/tasks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';


export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return authedRoute({ routeName: 'tasks.restore', rateLimitPerMinute: 120, idempotent: true }, async (r, ctx) => {
    const actor = { userId: ctx.auth.userId, workspaceId: ctx.auth.workspaceId, requestId: ctx.requestId };
    const input = await parseOptionalBody(r, optionalTaskVersionSchema);
    return restoreTask(actor, id, input?.version);
  })(request);
}
