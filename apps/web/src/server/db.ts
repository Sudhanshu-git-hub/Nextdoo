import { AsyncLocalStorage } from 'node:async_hooks';
import { createDb, type Database } from '@nextdoo/db';
import { getEnv } from './env';

/**
 * Process-wide database singleton.
 * Next.js dev mode re-evaluates modules on HMR, so the client is cached on
 * globalThis to avoid exhausting PostgreSQL connection slots.
 */
const globalForDb = globalThis as unknown as { __nextdooDb?: ReturnType<typeof createDb> };

const transactionContext = new AsyncLocalStorage<Database>();

/** All nested service calls participate in the caller's atomic unit of work. */
export function withTransaction<T>(fn: (db: Database) => Promise<T>, config?: Parameters<Database['transaction']>[1]): Promise<T> {
  const active = transactionContext.getStore();
  if (active) return fn(active);
  return getDb().transaction((tx) => transactionContext.run(tx as unknown as Database, () => fn(tx as unknown as Database)), config);
}

export function getDb(): Database {
  const active = transactionContext.getStore();
  if (active) return active;
  if (!globalForDb.__nextdooDb) {
    globalForDb.__nextdooDb = createDb(getEnv().DATABASE_URL, { max: 10 });
  }
  return globalForDb.__nextdooDb.db;
}

export function getSql() {
  getDb();
  return globalForDb.__nextdooDb!.sql;
}

/**
 * Closes the pooled connections. Only needed by tests and by graceful worker
 * shutdown — the web process keeps the pool for its lifetime.
 */
export async function closeDb(): Promise<void> {
  if (!globalForDb.__nextdooDb) return;
  await globalForDb.__nextdooDb.sql.end({ timeout: 5 });
  globalForDb.__nextdooDb = undefined;
}
