import { updateWorkspaceSchema, uuid } from '@nextdoo/contracts';
import { authedRoute, parseBody } from '@/server/http';
import { loadWorkspaceSettings, updateWorkspaceSettings } from '@/server/services/workspaces';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Params = { params: Promise<{ id: string }> };
export async function GET(request: Request, { params }: Params) {
 const { id } = await params;
 return authedRoute({ routeName: 'workspaces.get' }, async (_r, ctx) => loadWorkspaceSettings(ctx.auth.workspaceId, uuid.parse(id)))(request);
}
export async function PATCH(request: Request, { params }: Params) {
 const { id } = await params;
 return authedRoute({ routeName: 'workspaces.update', idempotent: true, rateLimitPerMinute: 30 }, async (r, ctx) => updateWorkspaceSettings({ userId: ctx.auth.userId, workspaceId: ctx.auth.workspaceId, requestId: ctx.requestId }, uuid.parse(id), await parseBody(r, updateWorkspaceSchema)))(request);
}
