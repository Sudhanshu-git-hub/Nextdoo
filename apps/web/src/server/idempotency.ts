import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { AppError } from '@nextdoo/contracts';
import { idempotencyKeys } from '@nextdoo/db';
import { withTransaction } from './db';

/** Stable JSON, including nested objects; array order remains meaningful. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  }
  return value;
}
const hash = (s: string) => createHash('sha256').update(s).digest('hex');

export async function idempotentMutation<T>(request: Request, userId: string, scope: string, perform: () => Promise<T>) {
  const key = request.headers.get('idempotency-key');
  if (!key || key.length > 128) throw new AppError('VALIDATION_FAILED', 'An Idempotency-Key of 1–128 characters is required.');
  let input: unknown = null;
  if (request.body !== null) {
    try {
      const text = await request.clone().text();
      if (text.trim()) input = JSON.parse(text);
    }
    catch { throw new AppError('VALIDATION_FAILED', 'Request body must be valid JSON.'); }
  }
  const url = new URL(request.url);
  const requestHash = hash(JSON.stringify([request.method, url.pathname, url.search, canonical(input)]));
  const ledgerKey = `v2:${hash(`${userId}:${key}`)}`;
  return withTransaction(async (db) => {
    // The lock and response ledger live in the SAME transaction as domain state.
    // Concurrent retries wait; rollback releases the key without recording success.
    await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ledgerKey}, 0))`);
    const [prior] = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, ledgerKey));
    if (prior && prior.expiresAt > new Date()) {
      if (prior.requestHash !== requestHash) throw new AppError('IDEMPOTENCY_CONFLICT', 'This key was already used for a different request.');
      return { body: prior.responseBody, status: prior.responseStatus!, replay: true };
    }
    // The recovered ledger hashed responses, not requests: never guess whether
    // an old replay is equivalent, and never silently execute its mutation again.
    const [legacy] = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, `${scope}:${userId}:${key}`));
    if (legacy && legacy.expiresAt > new Date()) throw new AppError('IDEMPOTENCY_CONFLICT', 'This legacy request key cannot be safely replayed. Check the resource before retrying.');
    if (prior) await db.delete(idempotencyKeys).where(eq(idempotencyKeys.key, ledgerKey));
    const result = await perform();
    const status = result == null ? 204 : 200;
    const body: unknown = result == null ? null : JSON.parse(JSON.stringify(result));
    await db.insert(idempotencyKeys).values({
      key: ledgerKey, scope, userId, requestHash, responseStatus: status, responseBody: body,
      expiresAt: new Date(Date.now() + 24 * 3600000),
    });
    return { body, status, replay: false };
  });
}
