import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { attachmentScannerHealthy, defaultClamavBin } from '@nextdoo/db';
import { newRequestId } from '@/server/observability';
import { getDb } from '@/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Readiness probe: reports dependency health, not just process liveness.
 * The attachment scanner (PRD §19: "scanner health check") is reported, not
 * probe-fatal: when the engine is unavailable, scans fail closed (no file is
 * ever served without a successful scan), so the probe must not mask a
 * running, safe API.
 */
// Probe cadence guard: `clamscan --version` spawns a process, so the result
// is cached for 30 s — fresh enough for readiness, cheap enough for polling.
let scannerProbe: { at: number; ok: boolean } | null = null;
const SCANNER_PROBE_TTL_MS = 30_000;

async function scannerAvailable(): Promise<boolean> {
  if (scannerProbe && Date.now() - scannerProbe.at < SCANNER_PROBE_TTL_MS) return scannerProbe.ok;
  const ok = await attachmentScannerHealthy(defaultClamavBin()).catch(() => false);
  scannerProbe = { at: Date.now(), ok };
  return ok;
}

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
  checks.attachmentScanner = (await scannerAvailable()) ? 'ok' : 'unavailable';
  return NextResponse.json(
    { status: healthy ? 'ok' : 'degraded', checks, timestamp: new Date().toISOString() },
    { status: healthy ? 200 : 503, headers: { 'X-Request-Id': newRequestId(), 'Cache-Control': 'no-store' } },
  );
}
