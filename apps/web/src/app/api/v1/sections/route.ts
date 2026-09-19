import { createSectionSchema, sectionQuerySchema } from '@nextdoo/contracts';
import { authedRoute, parseBody, parseQuery } from '@/server/http';
import { createSection, listSections } from '@/server/services/projects';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = authedRoute({ routeName: 'sections.list' }, async (r, ctx) => ({ data: await listSections(ctx.auth.workspaceId, parseQuery(r, sectionQuerySchema).projectId) }));
export const POST = authedRoute({ routeName: 'sections.create', idempotent: true, rateLimitPerMinute: 120 }, async (r, ctx) =>
  createSection({ userId: ctx.auth.userId, workspaceId: ctx.auth.workspaceId, requestId: ctx.requestId }, await parseBody(r, createSectionSchema)),
);
