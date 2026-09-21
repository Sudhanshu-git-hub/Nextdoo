import { createTagSchema } from '@nextdoo/contracts';
import { assertWorkspaceAccess } from '@/server/auth';
import { authedRoute, parseBody } from '@/server/http';
import { createTag, listTags } from '@/server/services/projects';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = authedRoute({ routeName: 'tags.list', rateLimitPerMinute: 600 }, async (_r, ctx) => ({ data: await listTags(ctx.auth.workspaceId) }));
export const POST = authedRoute({ routeName: 'tags.create', rateLimitPerMinute: 120, idempotent: true }, async (r, ctx) => {
  const input = await parseBody(r, createTagSchema);
  await assertWorkspaceAccess(ctx.auth.userId, input.workspaceId);
  return createTag(input.workspaceId, input.name, input.color);
});
