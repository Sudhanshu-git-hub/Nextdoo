import { assertRequestOrigin } from './request-security';
import { NextResponse } from 'next/server';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import { AppError, uuid, type ProblemDetails } from '@nextdoo/contracts';
import { lt } from 'drizzle-orm';
import { idempotencyKeys } from '@nextdoo/db';
import { getDb } from './db';
import { idempotentMutation } from './idempotency';
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
      assertRequestOrigin(request);
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

      const perform = async () => {
        const match = /^\/api\/v1\/(?:tasks|projects|timers|reminders)\/([^/]+)/.exec(new URL(request.url).pathname);
        if (match) {
          let id: string;
          try { id = decodeURIComponent(match[1]!); } catch { throw new AppError('VALIDATION_FAILED', 'Invalid resource identifier.'); }
          uuid.parse(id);
        }
        return handler(request, ctx);
      };
      const outcome = options.idempotent
        ? await idempotentMutation(request, auth.userId, options.routeName, perform)
        : await perform().then((body) => ({ body, status: body == null ? 204 : 200, replay: false }));
      const { body: result, status } = outcome;

      logger.info('request.ok', {
        requestId,
        route: options.routeName,
        userId: auth.userId,
        durationMs: Math.round(performance.now() - started),
      });

      return status === 204
        ? new NextResponse(null, { status: 204, headers: { 'X-Request-Id': requestId } })
        : jsonResponse(result, requestId, status, outcome.replay ? { 'Idempotent-Replay': 'true' } : {});
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
      assertRequestOrigin(request);
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
      const response = problemResponse(toProblem(error, requestId));
      if (error instanceof AppError && error.code === 'RATE_LIMITED' && 'retryAfter' in error) response.headers.set('Retry-After', String(error.retryAfter));
      return response;
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

/** Housekeeping for the idempotency ledger. */
export async function purgeExpiredIdempotencyKeys(): Promise<number> {
  const db = getDb();
  const removed = await db
    .delete(idempotencyKeys)
    .where(lt(idempotencyKeys.expiresAt, new Date()))
    .returning({ key: idempotencyKeys.key });
  return removed.length;
}
