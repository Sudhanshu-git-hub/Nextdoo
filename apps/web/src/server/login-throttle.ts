import { createHmac } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { AppError } from '@nextdoo/contracts';
import { getEnv } from './env';
import { getDb } from './db';

const keyFor = (kind: string, value: string) => createHmac('sha256', getEnv().AUTH_SECRET).update(`${kind}:${value}`).digest('hex');
/** Durable reservation before password work: multiple API instances share limits. */
export async function runLoginAttempt<T>(email: string, ip: string, perform: () => Promise<T>): Promise<T> {
  const accountKey = keyFor('account', email.trim().toLowerCase());
  const keys = [accountKey, keyFor('ip', ip)].sort();
  const retryAfter = await getDb().transaction(async (db) => {
    for (const key of keys) await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'auth-attempt:' + key}, 0))`);
    const now = Date.now();
    const rows: Array<{ key: string; attempts: number; blocked_until: Date; expires_at: Date }> = [];
    for (const key of keys) {
      const found = await db.execute(sql`select * from authentication_attempts where key=${key}`);
      if (found[0]) rows.push(found[0] as typeof rows[number]);
    }
    const wait = Math.max(0, ...rows.filter((r) => new Date(r.expires_at).getTime() > now).map((r) => new Date(r.blocked_until).getTime() - now));
    if (wait > 0) return Math.ceil(wait / 1000);
    for (const key of keys) {
      const prior = rows.find((r) => r.key === key && new Date(r.expires_at).getTime() > now);
      const attempts = (prior?.attempts ?? 0) + 1;
      const exponent = attempts - (key === accountKey ? 1 : 10);
      const delay = exponent < 0 ? 0 : Math.min(300000, 1000 * 2 ** Math.min(exponent, 9));
      await db.execute(sql`insert into authentication_attempts(key,attempts,blocked_until,expires_at)
        values(${key},${attempts},${new Date(now + delay).toISOString()}::timestamptz,${new Date(now + 30 * 60000).toISOString()}::timestamptz)
        on conflict(key) do update set attempts=excluded.attempts,blocked_until=excluded.blocked_until,expires_at=excluded.expires_at`);
    }
    return 0;
  });
  if (retryAfter) {
    const error = new AppError('RATE_LIMITED', 'Too many login attempts. Please wait before trying again.');
    Object.assign(error, { retryAfter });
    throw error;
  }
  const result = await perform();
  await getDb().execute(sql`delete from authentication_attempts where key=${accountKey}`);
  return result;
}
