import { AppError } from '@nextdoo/contracts';
import { createDurableFileExportStore } from '@nextdoo/db';
import { requireAuth } from '@/server/auth';
import { newRequestId } from '@/server/observability';
import { problemResponse, toProblem } from '@/server/http';
import { authorizeExportDownload } from '@/server/services/exports';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Streams the generated artifact (PRD §7.10: signed URL expiring in 24 hours).
 * Authorisation (row state, ownership, signed token) happens in the service;
 * a missing artifact is a consistency failure, never a silent 200.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = newRequestId();
  try {
    const auth = await requireAuth();
    const { id } = await params;
    const url = new URL(request.url);
    const authorized = await authorizeExportDownload(auth, id, url.searchParams.get('token'), requestId);
    const data = await createDurableFileExportStore().read(authorized.objectKey);
    if (data === null) throw new AppError('INTERNAL_ERROR', 'The export artifact is missing. Request a new export.');
    return new Response(data, {
      status: 200,
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="nextdoo-tracking-export-${authorized.id.slice(0, 8)}.${authorized.format}.gz"`,
        'Cache-Control': 'no-store, private',
        'Content-Length': String(data.byteLength),
        'X-Request-Id': requestId,
      },
    });
  } catch (error) {
    const response = problemResponse(toProblem(error, requestId));
    response.headers.set('Cache-Control', 'no-store, private');
    return response;
  }
}
