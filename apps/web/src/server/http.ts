import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import { AppError, type ProblemDetails } from '@nextdoo/contracts';
import { eq, lt } from 'drizzle-orm';
import { idempotencyKeys } from '@nextdoo/db';
import { getDb } from './db';
import { logger, newRequestId } from './observability';
import { rateLimit, requireAuth, type AuthContext } from './auth';

/**
 * HTTP plumbing shared by every /v1 route (PRD §14.1).
 * Guarantees: request id on every response, RFC 7807 errors, validated input,
 * rate limiting, and replay-safe mutations via Idempotency-Key.
 */

export interface RouteContext {
  requestId: string;
  auth: AuthContext;
  ip: string;
}

function clientIp(request: Request): string {
  const fwd = request.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0]!.trim();
  return request.headers.get('x-real-ip') ?? '0.0.0.0';
}

export function problemResponse(problem: ProblemDetails): NextResponse {
  return NextResponse.json(problem, {
    status: problem.status,
    headers: {
      'Content-Type': 'application/problem+json',
      'X-Request-Id': problem.request_id ?? '',
    },
  });
}

export function jsonResponse(body: unknown, requestId: string, status = 200, extraHeaders: HeadersInit = {}) {
  return NextResponse.json(body, {
    status,
    headers: { 'X-Request-Id': requestId, ...extraHeaders },
  });
}

export function toProblem(error: unknown, requestId: string): ProblemDetails {
  if (error instanceof AppError) return error.toProblem(requestId);

  if (error instanceof ZodError) {
    return new AppError('VALIDATION_FAILED', 'The request body failed validation.', {
      fieldErrors: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    }).toProblem(requestId);
  }

  // Unknown failures must not leak internals to the client.
  logger.error('unhandled.error', {
    requestId,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack?.split('\n').slice(0, 4).join(' | ') : undefined,
  });
  return new AppError('INTERNAL_ERROR', 'Something went wrong. Please try again.').toProblem(requestId);
}

interface HandlerOptions {
  /** Requests per minute for this route. */
  rateLimitPerMinute?: number;
  /** Enables Idempotency-Key replay protection. */
  idempotent?: boolean;
  routeName: string;
}

/**
 * Wraps an authenticated route handler.
 * Any thrown AppError becomes a problem+json response with the right status.
 */
export function authedRoute<T>(
  options: HandlerOptions,
  handler: (request: Request, ctx: RouteContext) => Promise<T>,
) {
  return async (request: Request): Promise<NextResponse> => {
    const requestId = newRequestId();
    const ip = clientIp(request);
    const started = performance.now();

    try {
      const auth = await requireAuth();

      const limit = options.rateLimitPerMinute ?? 600;
      const { ok, retryAfter } = rateLimit(`${options.routeName}:${auth.userId}`, limit, 60_000);
      if (!ok) {
        const problem = new AppError('RATE_LIMITED', 'Too many requests. Please slow down.').toProblem(requestId);
        return NextResponse.json(problem, {
          status: 429,
          headers: { 'Retry-After': String(retryAfter), 'X-Request-Id': requestId },
        });
      }

      const ctx: RouteContext = { requestId, auth, ip };

      // Idempotency replay (PRD §14.1).
      const idemKey = request.headers.get('idempotency-key');
      if (options.idempotent && idemKey) {
        const replay = await replayIdempotent(idemKey, auth.userId, options.routeName);
        if (replay) {
          logger.info('request.replayed', { requestId, route: options.routeName, userId: auth.userId });
          return NextResponse.json(replay.body, {
            status: replay.status,
            headers: { 'X-Request-Id': requestId, 'Idempotent-Replay': 'true' },
          });
        }
      }

      const result = await handler(request, ctx);
      const status = result === undefined || result === null ? 204 : 200;

      if (options.idempotent && idemKey && status !== 204) {
        await storeIdempotent(idemKey, auth.userId, options.routeName, status, result);
      }

      logger.info('request.ok', {
        requestId,
        route: options.routeName,
        userId: auth.userId,
        durationMs: Math.round(performance.now() - started),
      });

      return status === 204
        ? new NextResponse(null, { status: 204, headers: { 'X-Request-Id': requestId } })
        : jsonResponse(result, requestId, status);
    } catch (error) {
      const problem = toProblem(error, requestId);
      logger.warn('request.failed', {
        requestId,
        route: options.routeName,
        code: problem.code,
        status: problem.status,
        durationMs: Math.round(performance.now() - started),
      });
      return problemResponse(problem);
    }
  };
}

/** Unauthenticated variant for login, register and webhooks. */
export function publicRoute<T>(
  options: { routeName: string; rateLimitPerMinute?: number },
  handler: (request: Request, ctx: { requestId: string; ip: string }) => Promise<T>,
) {
  return async (request: Request): Promise<NextResponse> => {
    const requestId = newRequestId();
    const ip = clientIp(request);
    try {
      const limit = options.rateLimitPerMinute ?? 10;
      const { ok, retryAfter } = rateLimit(`${options.routeName}:${ip}`, limit, 60_000);
      if (!ok) {
        const problem = new AppError('RATE_LIMITED', 'Too many attempts. Please wait and try again.').toProblem(requestId);
        return NextResponse.json(problem, {
          status: 429,
          headers: { 'Retry-After': String(retryAfter), 'X-Request-Id': requestId },
        });
      }
      const result = await handler(request, { requestId, ip });
      return jsonResponse(result, requestId, 200);
    } catch (error) {
      return problemResponse(toProblem(error, requestId));
    }
  };
}

export async function parseBody<S extends ZodTypeAny>(request: Request, schema: S): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new AppError('VALIDATION_FAILED', 'Request body must be valid JSON.');
  }
  return schema.parse(raw);
}

export function parseQuery<S extends ZodTypeAny>(request: Request, schema: S): z.output<S> {
  const url = new URL(request.url);
  const obj: Record<string, string> = {};
  url.searchParams.forEach((v, k) => {
    obj[k] = v;
  });
  return schema.parse(obj);
}

async function replayIdempotent(
  key: string,
  userId: string,
  scope: string,
): Promise<{ status: number; body: unknown } | null> {
  const db = getDb();
  const composite = `${scope}:${userId}:${key}`;
  const rows = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, composite)).limit(1);
  const row = rows[0];
  if (!row || row.expiresAt < new Date()) return null;
  return { status: row.responseStatus ?? 200, body: row.responseBody };
}

async function storeIdempotent(
  key: string,
  userId: string,
  scope: string,
  status: number,
  body: unknown,
): Promise<void> {
  const db = getDb();
  const composite = `${scope}:${userId}:${key}`;
  await db
    .insert(idempotencyKeys)
    .values({
      key: composite,
      scope,
      userId,
      requestHash: createHash('sha256').update(JSON.stringify(body ?? {})).digest('hex').slice(0, 64),
      responseStatus: status,
      responseBody: body as never,
      // 24-hour replay window per PRD §14.4.
      expiresAt: new Date(Date.now() + 24 * 3_600_000),
    })
    .onConflictDoNothing();
}

/** Housekeeping for the idempotency ledger. */
export async function purgeExpiredIdempotencyKeys(): Promise<number> {
  const db = getDb();
  const removed = await db
    .delete(idempotencyKeys)
    .where(lt(idempotencyKeys.expiresAt, new Date()))
    .returning({ key: idempotencyKeys.key });
  return removed.length;
}
