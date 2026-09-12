import { eq } from 'drizzle-orm';
import { users, type Database } from '@nextdoo/db';
import { unauthenticated } from '@nextdoo/contracts';
import { withTransaction } from './db';

export function deletionExpired(at: Date | null): boolean {
  return at !== null && at.getTime() <= Date.now() - 30 * 86400000;
}
/** One serialization boundary for login, credentials, MFA and deletion. */
export function withAccountTransaction<T>(userId: string, perform: (db: Database) => Promise<T>): Promise<T> {
  return withTransaction(async (db) => {
    const [user] = await db.select().from(users).where(eq(users.id, userId)).for('update');
    if (!user || user.deletedAt || user.status !== 'ACTIVE' || deletionExpired(user.deletionRequestedAt)) throw unauthenticated();
    return perform(db);
  });
}
