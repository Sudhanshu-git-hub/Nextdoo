import { authedRoute } from '@/server/http';
import { requestAttachmentDownload } from '@/server/services/attachments';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Issues a short-lived signed download URL (PRD §11.4: ≤ 15 minutes).
 * Refused with ATTACHMENT_NOT_CLEAN (409) until the malware scan is CLEAN —
 * PENDING, INFECTED and FAILED are all blocked.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return authedRoute({ routeName: 'attachments.downloadUrl', rateLimitPerMinute: 600 }, async (_r, ctx) => {
    return requestAttachmentDownload(ctx.auth, id);
  })(request);
}
