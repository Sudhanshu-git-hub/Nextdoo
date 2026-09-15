import { updateSectionSchema } from '@nextdoo/contracts';
import { authedRoute, parseBody } from '@/server/http';
import { updateSection } from '@/server/services/projects';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return authedRoute({ routeName: 'sections.update', idempotent: true, rateLimitPerMinute: 120 }, async (r, ctx) =>
    updateSection({ userId: ctx.auth.userId, workspaceId: ctx.auth.workspaceId, requestId: ctx.requestId }, id, await parseBody(r, updateSectionSchema)),
  )(request);
}
