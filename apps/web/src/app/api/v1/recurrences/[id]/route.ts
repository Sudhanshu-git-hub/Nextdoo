import { changeRecurrenceSchema, uuid } from '@nextdoo/contracts';
import { authedRoute, parseBody } from '@/server/http';
import { changeRecurrence, getRecurrence } from '@/server/services/recurrence';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
 const { id } = await params;
 return authedRoute({ routeName: 'recurrence.get' }, async (r, ctx) => getRecurrence(ctx.auth.workspaceId, uuid.parse(id), new URL(r.url).searchParams.get('cursor') ?? undefined))(request);
}
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
 const { id } = await params;
 return authedRoute({ routeName: 'recurrence.update', rateLimitPerMinute: 20, idempotent: true }, async (r, ctx) => changeRecurrence({ userId: ctx.auth.userId, workspaceId: ctx.auth.workspaceId, requestId: ctx.requestId }, uuid.parse(id), await parseBody(r, changeRecurrenceSchema)))(request);
}
