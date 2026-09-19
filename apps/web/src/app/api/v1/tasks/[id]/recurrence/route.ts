import { attachRecurrenceSchema } from '@nextdoo/contracts';
import { authedRoute, parseBody } from '@/server/http';
import { attachRecurrence } from '@/server/services/recurrence';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
 const { id } = await params;
 return authedRoute({ routeName: 'recurrence.attach', rateLimitPerMinute: 20, idempotent: true }, async (r, ctx) => attachRecurrence({ userId: ctx.auth.userId, workspaceId: ctx.auth.workspaceId, requestId: ctx.requestId }, id, await parseBody(r, attachRecurrenceSchema)))(request);
}
