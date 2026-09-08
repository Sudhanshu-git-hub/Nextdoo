import { and, eq, inArray, lte, or } from 'drizzle-orm';
import type { Database } from './client';
import { idempotencyKeys, outbox, users, workspaces } from './schema';

/** Shared by API service and worker; audit/security evidence is NOT cascaded. */
export async function purgeAccount(db: Database, userId: string, cutoff: Date): Promise<boolean> {
  return db.transaction(async (tx) => {
    // Recheck under lock: a concurrent cancellation must not be ignored after
    // the worker's candidate scan. Empty/stale candidates are harmless retries.
    const [user] = await tx.select({ id: users.id }).from(users)
      .where(and(eq(users.id, userId), lte(users.deletionRequestedAt, cutoff))).for('update');
    if (!user) return false;
    const owned = await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.ownerId, userId));
    const ids = owned.map((w) => w.id);
    // These tables intentionally have no FK; don't leave private replay bodies
    // or undelivered account messages behind after the domain rows are purged.
    await tx.delete(idempotencyKeys).where(eq(idempotencyKeys.userId, userId));
    await tx.delete(outbox).where(or(eq(outbox.actorId, userId), ids.length ? inArray(outbox.workspaceId, ids) : undefined));
    await tx.delete(users).where(eq(users.id, userId));
    return true;
  });
}
