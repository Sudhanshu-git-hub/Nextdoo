import { randomUUID } from 'node:crypto';

/**
 * Structured logging and request correlation (PRD §12, §11.4).
 *
 * Two hard rules enforced here:
 *  - Every log line carries a request id so support can trace an incident.
 *  - Sensitive keys are redacted before serialisation — task content, tokens and
 *    passwords must never reach the log sink.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Keys whose values are replaced with `[redacted]` at any depth. */
const REDACTED_KEYS = new Set([
  'password', 'passwordhash', 'token', 'tokenhash', 'accesstoken', 'refreshtoken',
  'authorization', 'cookie', 'secret', 'mfasecret', 'apikey', 'code',
  // Task content is user data, not diagnostics.
  'title', 'description', 'body', 'note', 'text', 'payload',
]);

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth-limit]';
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACTED_KEYS.has(k.toLowerCase()) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 500) return `${value.slice(0, 500)}…`;
  return value;
}

export interface LogContext {
  requestId?: string;
  userId?: string;
  workspaceId?: string;
  route?: string;
  [key: string]: unknown;
}

function minLevel(): LogLevel {
  const raw = process.env.LOG_LEVEL as LogLevel | undefined;
  return raw && raw in LEVEL_RANK ? raw : 'info';
}

function emit(level: LogLevel, message: string, context: LogContext = {}): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[minLevel()]) return;
  const line = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...(redact(context) as object),
  };
  // Single-line JSON: the shape an OpenTelemetry collector or log shipper expects.
  const serialised = JSON.stringify(line);
  if (level === 'error') console.error(serialised);
  else if (level === 'warn') console.warn(serialised);
  else console.log(serialised);
}

export const logger = {
  debug: (m: string, c?: LogContext) => emit('debug', m, c),
  info: (m: string, c?: LogContext) => emit('info', m, c),
  warn: (m: string, c?: LogContext) => emit('warn', m, c),
  error: (m: string, c?: LogContext) => emit('error', m, c),
};

export function newRequestId(): string {
  return `req_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
}

/** Minimal span timing; a real deployment swaps this for an OTel tracer. */
export async function withSpan<T>(name: string, ctx: LogContext, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    const result = await fn();
    logger.debug('span.ok', { ...ctx, span: name, durationMs: Math.round(performance.now() - start) });
    return result;
  } catch (error) {
    logger.error('span.error', {
      ...ctx,
      span: name,
      durationMs: Math.round(performance.now() - start),
      error: error instanceof Error ? error.message : 'unknown',
    });
    throw error;
  }
}
