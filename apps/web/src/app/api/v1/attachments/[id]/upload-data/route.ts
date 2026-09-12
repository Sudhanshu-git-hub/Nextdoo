import { authedRoute } from '@/server/http';
import { writeAttachmentData } from '@/server/services/attachments';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Direct upload of the file bytes (PRD §6.8: "direct PUT to storage" — the
 * client still never receives storage credentials; the PUT lands on this
 * authenticated, token-gated endpoint). The body must be exactly the declared
 * size; the signed upload token is single-purpose (this attachment, this size)
 * and expires in 15 minutes.
 */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const token = new URL(request.url).searchParams.get('token');
  return authedRoute(
    { routeName: 'attachments.uploadData', rateLimitPerMinute: 60 },
    async (r, ctx) => {
      if (!r.body) throw new Error('EMPTY_UPLOAD_BODY');
      await writeAttachmentData(ctx.auth, id, token, r.body);
      return { uploaded: true };
    },
  )(request);
}
