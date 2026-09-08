import { createProjectSchema } from '@nextdoo/contracts';
import { assertWorkspaceAccess } from '@/server/auth';
import { authedRoute, parseBody } from '@/server/http';
import { createProject, listProjects } from '@/server/services/projects';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = authedRoute({ routeName: 'projects.list' }, async (_r, ctx) => ({
  data: await listProjects(ctx.auth.workspaceId),
}));

export const POST = authedRoute({ routeName: 'projects.create', rateLimitPerMinute: 60, idempotent: true }, async (request, ctx) => {
  const input = await parseBody(request, createProjectSchema);
  await assertWorkspaceAccess(ctx.auth.userId, input.workspaceId);
  return createProject({ userId: ctx.auth.userId, workspaceId: input.workspaceId, requestId: ctx.requestId }, input);
});
