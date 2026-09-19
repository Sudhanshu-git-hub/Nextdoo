import { sql } from 'drizzle-orm';
import type { Database } from '@nextdoo/db';
import { withTransaction } from '../db';

/** Serialize workspace state checks with writes (limits, merge and references). */
export function withWorkspaceTransaction<T>(workspaceId: string, perform: (db: Database) => Promise<T>): Promise<T> {
  return withTransaction(async (db) => {
    await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'workspace:' + workspaceId}, 0))`);
    return perform(db);
  });
}
