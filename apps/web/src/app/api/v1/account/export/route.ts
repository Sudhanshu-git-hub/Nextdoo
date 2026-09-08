import { requireAuth } from '@/server/auth';
import { buildExport } from '@/server/services/data-rights';
import { logger } from '@/server/observability';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Downloads a complete JSON archive of the account (PRD §12.4).
 *
 * Not wrapped in `authedRoute` because that helper serialises to a JSON body,
 * and this needs to stream as a file attachment with its own headers.
 */
export async function GET(): Promise<Response> {
  let auth;
  try {
    auth = await requireAuth();
  } catch {
    return Response.json(
      {
        type: 'https://api.nextdoo.example/errors/unauthenticated',
        title: 'Authentication required',
        status: 401,
        code: 'UNAUTHENTICATED',
        detail: 'Authentication is required.',
      },
      { status: 401, headers: { 'Content-Type': 'application/problem+json' } },
    );
  }

  try {
    const bundle = await buildExport(auth.userId);
    const filename = `nextdoo-export-${new Date().toISOString().slice(0, 10)}.json`;

    return new Response(JSON.stringify(bundle, null, 2), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        // The archive contains everything the user owns; never let it sit in a cache.
        'Cache-Control': 'no-store, private',
      },
    });
  } catch (error) {
    logger.error('export.failed', { error: error instanceof Error ? error.message : 'unknown' });
    return Response.json(
      {
        type: 'https://api.nextdoo.example/errors/internal-error',
        title: 'Export failed',
        status: 500,
        code: 'INTERNAL_ERROR',
        detail: 'Your export could not be generated. Please try again.',
      },
      { status: 500, headers: { 'Content-Type': 'application/problem+json' } },
    );
  }
}
