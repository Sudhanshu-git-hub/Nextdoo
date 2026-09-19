import { attachmentListQuerySchema, attachmentUploadSchema } from '@nextdoo/contracts';
import { authedRoute, parseBody, parseQuery } from '@/server/http';
import { authorizeAttachmentUpload, listAttachments } from '@/server/services/attachments';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Metadata for the task's attachments (PRD §6.8). */
export const GET = authedRoute({ routeName: 'attachments.list', rateLimitPerMinute: 600 }, async (request, ctx) => {
  const query = parseQuery(request, attachmentListQuerySchema);
  return { data: await listAttachments(ctx.auth, query.taskId) };
});

/**
 * Upload authorization (PRD §6.8): plan file-size and storage-quota limits,
 * content-type allowlist, and a server-generated object key. Returns a
 * short-lived signed upload URL — never storage credentials.
 */
export const POST = authedRoute(
  { routeName: 'attachments.upload', rateLimitPerMinute: 120, idempotent: true },
  async (request, ctx) => {
    const input = await parseBody(request, attachmentUploadSchema);
    return authorizeAttachmentUpload(ctx.auth, input);
  },
);
