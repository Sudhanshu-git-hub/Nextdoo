import { captureTelemetrySchema } from '@nextdoo/contracts';
import { authedRoute, parseBody } from '@/server/http';
import { recordCapture } from '@/server/metrics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Client-reported capture latency (PRD §20.3, §21.3 M2 instrumentation).
 * Content-free and strictly validated: the schema rejects any extra field,
 * so task content can never reach the telemetry event.
 */
export async function POST(request: Request) {
  return authedRoute({ routeName: 'telemetry.capture', rateLimitPerMinute: 60 }, async (r) => {
    const input = await parseBody(r, captureTelemetrySchema);
    recordCapture(input.latencyMs, input.success, input.confirmed);
    return { ok: true };
  })(request);
}
