import { and, eq, inArray, lte, or } from 'drizzle-orm';
import type { Database } from './client';
import { exports as exportsTable, idempotencyKeys, outbox, users, workspaces } from './schema';
import type { ExportArtifactStore } from './export-storage';

/**
 * Shared by API service and worker; audit/security evidence is NOT cascaded.
 * Export artifact files are removed after the row cascade commits — the keys
 * are enumerated under the same lock, so no private export file outlives the
 * account (PRD §11.9).
 */
export async function purgeAccount(
  db: Database,
  userId: string,
  cutoff: Date,
  opts: { artifactStore?: ExportArtifactStore } = {},
): Promise<boolean> {
  const objectKeys: string[] = [];
  const purged = await db.transaction(async (tx) => {
    // Recheck under lock: a concurrent cancellation must not be ignored after
    // the worker's candidate scan. Empty/stale candidates are harmless retries.
    const [user] = await tx.select({ id: users.id }).from(users)
      .where(and(eq(users.id, userId), lte(users.deletionRequestedAt, cutoff))).for('update');
    if (!user) return false;
    const owned = await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.ownerId, userId));
    const ids = owned.map((w) => w.id);
    const artifactRows = await tx
      .select({ objectKey: exportsTable.objectKey })
      .from(exportsTable)
      .where(eq(exportsTable.userId, userId));
    for (const row of artifactRows) {
      if (row.objectKey) objectKeys.push(row.objectKey);
    }
    // These tables intentionally have no FK; don't leave private replay bodies
    // or undelivered account messages behind after the domain rows are purged.
    await tx.delete(idempotencyKeys).where(eq(idempotencyKeys.userId, userId));
    await tx.delete(outbox).where(or(eq(outbox.actorId, userId), ids.length ? inArray(outbox.workspaceId, ids) : undefined));
    await tx.delete(users).where(eq(users.id, userId));
    return true;
  });
  if (purged && opts.artifactStore) {
    for (const key of objectKeys) {
      try { await opts.artifactStore.remove(key); } catch { /* one bad file must not block purging */ }
    }
  }
  return purged;
}
