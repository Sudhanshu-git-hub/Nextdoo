import { requireAuth } from '@/server/auth';
import { newRequestId } from '@/server/observability';
import { problemResponse, toProblem } from '@/server/http';
import { streamAttachmentDownload } from '@/server/services/attachments';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Streams the attachment (PRD §6.8: "GET /v1/attachments/:id/download as a
 * short-lived signed URL … blocked until CLEAN").
 *
 * Authorisation: session + attachment CLEAN status + signed token
 * (signature, binding to this attachment and user, 15-minute expiry). The
 * stored content type comes from the upload-time allowlist; the response is
 * always an attachment download with nosniff — no inline rendering path.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = newRequestId();
  try {
    const auth = await requireAuth();
    const { id } = await params;
    const url = new URL(request.url);
    const { data, fileName, contentType } = await streamAttachmentDownload(auth, id, url.searchParams.get('token'));
    const safeName = fileName.replace(/["\\\r\n]/g, '_');
    return new Response(data, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${safeName}"`,
        'Content-Length': String(data.byteLength),
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store, private',
        'X-Request-Id': requestId,
      },
    });
  } catch (error) {
    const response = problemResponse(toProblem(error, requestId));
    response.headers.set('Cache-Control', 'no-store, private');
    return response;
  }
}
