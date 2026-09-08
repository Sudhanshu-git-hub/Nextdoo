import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { newRequestId } from '@/server/observability';
import { getDb } from '@/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Readiness probe: reports dependency health, not just process liveness. */
export async function GET() {
  const checks: Record<string, string> = {};
  let healthy = true;
  try {
    await getDb().execute(sql`SELECT 1`);
    checks.database = 'ok';
  } catch {
    checks.database = 'unavailable';
    healthy = false;
  }
  return NextResponse.json(
    { status: healthy ? 'ok' : 'degraded', checks, timestamp: new Date().toISOString() },
    { status: healthy ? 200 : 503, headers: { 'X-Request-Id': newRequestId(), 'Cache-Control': 'no-store' } },
  );
}
