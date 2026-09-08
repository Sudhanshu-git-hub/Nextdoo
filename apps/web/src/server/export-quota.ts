import { createHmac } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { AppError } from '@nextdoo/contracts';
import { getDb } from './db';
import { getEnv } from './env';

/** Three snapshots/hour/account across API instances; records expire automatically. */
export async function reserveExport(userId: string): Promise<void> {
  const key = createHmac('sha256', getEnv().AUTH_SECRET).update(`export:${userId}`).digest('hex');
  const wait = await getDb().transaction(async (db) => {
    await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key},0))`);
    const [row] = await db.execute(sql`select * from authentication_attempts where key=${key} and expires_at > now()`);
    if (row && Number(row.attempts) >= 3) return Math.max(1, Math.ceil((new Date(String(row.expires_at)).getTime() - Date.now()) / 1000));
    const expiry = row ? new Date(String(row.expires_at)) : new Date(Date.now() + 3600000);
    await db.execute(sql`insert into authentication_attempts(key,attempts,blocked_until,expires_at)
      values(${key},${Number(row?.attempts ?? 0) + 1},now(),${expiry.toISOString()}::timestamptz)
      on conflict(key) do update set attempts=excluded.attempts,expires_at=excluded.expires_at`);
    return 0;
  });
  if (wait) {
    const error = new AppError('RATE_LIMITED', 'Export limit reached. Please retry later.');
    Object.assign(error, { retryAfter: wait }); throw error;
  }
}
