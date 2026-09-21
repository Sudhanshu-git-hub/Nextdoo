import { authedRoute } from '@/server/http';
import { completeAttachment, deleteAttachment } from '@/server/services/attachments';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Confirms the upload (PRD §6.8): verifies the stored object matches the
 * declared size, stamps it uploaded, and queues the async malware scan.
 * Idempotent — completing an already-completed attachment returns its state.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return authedRoute(
    { routeName: 'attachments.complete', rateLimitPerMinute: 120, idempotent: true },
    async (_r, ctx) => ({ attachment: await completeAttachment(ctx.auth, id) }),
  )(request);
}

/** Soft-deletes the attachment, removes its file, and releases quota. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return authedRoute(
    { routeName: 'attachments.delete', rateLimitPerMinute: 120 },
    async (_r, ctx) => {
      await deleteAttachment(ctx.auth, id);
      return { deleted: true };
    },
  )(request);
}
