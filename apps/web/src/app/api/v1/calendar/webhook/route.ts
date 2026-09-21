import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { AppError } from '@nextdoo/contracts';
import { rateLimit } from '@/server/auth';
import { assertRequestOrigin } from '@/server/request-security';
import { jsonResponse, problemResponse, toProblem } from '@/server/http';
import { logger, newRequestId } from '@/server/observability';
import { handleCalendarWebhook } from '@/server/services/calendar-connections';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CALENDAR_WEBHOOK_TOKEN_LIMIT_PER_MINUTE = 300;
const CALENDAR_WEBHOOK_INVALID_LIMIT_PER_MINUTE = 300;
// Global safety remains in place, but it is deliberately above the per-token
// quota and checked after the token bucket so one exhausted channel cannot keep
// spending the shared IP bucket and starve unrelated channels.
const CALENDAR_WEBHOOK_GLOBAL_SAFETY_LIMIT_PER_MINUTE = 3_000;
const WINDOW_MS = 60_000;

const body = z.object({
  channel: z.object({ token: z.string().uuid() }).optional(),
  resource: z.string().optional(),
  /**
   * Test/fixture-normalized provider notification identity. Live Google header
   * shape remains part of the blocked M8-i5 verification; M8-i6 only dedupes
   * an explicit normalized id when present.
   */
  eventId: z.string().trim().min(1).max(200).optional(),
});

function clientIp(request: Request): string {
  const fwd = request.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0]!.trim();
  return request.headers.get('x-real-ip') ?? '0.0.0.0';
}

function tokenBucket(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 32);
}

function rateLimitResponse(requestId: string, retryAfter: number, detail: string): NextResponse {
  const problem = new AppError('RATE_LIMITED', detail).toProblem(requestId);
  return NextResponse.json(problem, {
    status: 429,
    headers: { 'Retry-After': String(retryAfter), 'X-Request-Id': requestId },
  });
}

function invalidBucketExceeded(ip: string): { ok: boolean; retryAfter: number } {
  return rateLimit(`calendar.webhook.invalid:${ip}`, CALENDAR_WEBHOOK_INVALID_LIMIT_PER_MINUTE, WINDOW_MS);
}

function tokenBucketExceeded(token: string): { ok: boolean; retryAfter: number } {
  return rateLimit(`calendar.webhook.token:${tokenBucket(token)}`, CALENDAR_WEBHOOK_TOKEN_LIMIT_PER_MINUTE, WINDOW_MS);
}

function globalSafetyBucketExceeded(ip: string): { ok: boolean; retryAfter: number } {
  return rateLimit(`calendar.webhook.global:${ip}`, CALENDAR_WEBHOOK_GLOBAL_SAFETY_LIMIT_PER_MINUTE, WINDOW_MS);
}

/**
 * PRD §16.1 — Google push-channel target. Unauthenticated by design: the
 * channel token (currently the connection id; T3 remains deferred) scopes an
 * import to exactly that connection. M8-i6 changes only ingress hardening:
 *  - token-scoped buckets so one noisy channel cannot starve another;
 *  - optional normalized provider `eventId` replay dedupe.
 * No token value is logged or stored in the webhook-delivery ledger.
 */
export async function POST(request: Request) {
  const requestId = newRequestId();
  const ip = clientIp(request);
  const started = performance.now();
  try {
    assertRequestOrigin(request);
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      const limited = invalidBucketExceeded(ip);
      if (!limited.ok) return rateLimitResponse(requestId, limited.retryAfter, 'Too many invalid calendar webhook attempts. Please wait and try again.');
      throw new AppError('VALIDATION_FAILED', 'Request body must be valid JSON.');
    }
    const parsed = body.safeParse(raw);
    if (!parsed.success) {
      const limited = invalidBucketExceeded(ip);
      if (!limited.ok) return rateLimitResponse(requestId, limited.retryAfter, 'Too many invalid calendar webhook attempts. Please wait and try again.');
      throw new ZodError(parsed.error.issues);
    }

    const token = parsed.data.channel?.token;
    if (!token) {
      const limited = invalidBucketExceeded(ip);
      if (!limited.ok) return rateLimitResponse(requestId, limited.retryAfter, 'Too many invalid calendar webhook attempts. Please wait and try again.');
      const result = { ok: false, imported: 0 };
      logger.info('request.ok', { requestId, route: 'calendar.webhook', durationMs: Math.round(performance.now() - started) });
      return jsonResponse(result, requestId, 200);
    }

    const limited = tokenBucketExceeded(token);
    if (!limited.ok) return rateLimitResponse(requestId, limited.retryAfter, 'Too many calendar webhook deliveries for this channel. Please wait and try again.');
    const globalLimited = globalSafetyBucketExceeded(ip);
    if (!globalLimited.ok) return rateLimitResponse(requestId, globalLimited.retryAfter, 'Too many calendar webhook deliveries. Please wait and try again.');

    const result = await handleCalendarWebhook(token, { messageId: parsed.data.eventId });
    logger.info('request.ok', { requestId, route: 'calendar.webhook', durationMs: Math.round(performance.now() - started) });
    return jsonResponse(result, requestId, 200);
  } catch (error) {
    const problem = toProblem(error, requestId);
    logger.warn('request.failed', {
      requestId,
      route: 'calendar.webhook',
      code: problem.code,
      status: problem.status,
      durationMs: Math.round(performance.now() - started),
    });
    return problemResponse(problem);
  }
}
