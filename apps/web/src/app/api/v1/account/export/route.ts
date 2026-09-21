import { requireAuth } from '@/server/auth';
import { buildExport } from '@/server/services/data-rights';
import { newRequestId } from '@/server/observability';
import { reserveExport } from '@/server/export-quota';
import { problemResponse, toProblem } from '@/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Authenticated synchronous snapshot, NOT a publicly hosted expiring export file. */
export async function GET(): Promise<Response> {
  const requestId = newRequestId();
  try {
    const auth = await requireAuth();
    await reserveExport(auth.userId);
    const bundle = await buildExport(auth.userId);
    return new Response(JSON.stringify(bundle, null, 2), { headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="nextdoo-export-${new Date().toISOString().slice(0, 10)}.json"`,
      'Cache-Control': 'no-store, private', 'X-Request-Id': requestId,
    } });
  } catch (error) {
    const response = problemResponse(toProblem(error, requestId));
    response.headers.set('Cache-Control', 'no-store, private');
    if (error && typeof error === 'object' && 'retryAfter' in error) response.headers.set('Retry-After', String(error.retryAfter));
    return response;
  }
}
