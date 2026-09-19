import { and, asc, count, eq } from 'drizzle-orm';
import { pushSubscriptions } from './schema';
import type { Database } from './client';
import type { PushSubscriptionInput } from '@nextdoo/contracts';

export type PushActor = { userId: string };

/**
 * M8-i1 (PRD §6.6/§9.3): browser push subscription lifecycle.
 *
 * All operations are strictly user-scoped (tenant isolation: a user can only
 * ever manage their own registrations). Re-registering an endpoint the user
 * already registered is an idempotent no-op (the unique (user, endpoint) key
 * is the dedupe); only the Web Push delivery fields are stored — no
 * user-agent payloads, no client-side secrets.
 */

export async function registerPushSubscription(
  db: Database,
  actor: PushActor,
  input: PushSubscriptionInput,
): Promise<{ created: boolean; total: number }> {
  const result = await db
    .insert(pushSubscriptions)
    .values({
      id: crypto.randomUUID(),
      userId: actor.userId,
      endpoint: input.endpoint,
      p256dh: input.keys.p256dh,
      auth: input.keys.auth,
    })
    .onConflictDoNothing({ target: [pushSubscriptions.userId, pushSubscriptions.endpoint] })
    .returning({ id: pushSubscriptions.id });
  const totalRow = await db
    .select({ n: count() })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, actor.userId));
  return { created: result.length > 0, total: totalRow[0]?.n ?? 0 };
}

export async function listPushSubscriptions(
  db: Database,
  actor: PushActor,
): Promise<Array<{ endpoint: string; createdAt: Date }>> {
  return db
    .select({ endpoint: pushSubscriptions.endpoint, createdAt: pushSubscriptions.createdAt })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, actor.userId))
    .orderBy(asc(pushSubscriptions.id));
}

/** Removes the caller's own registration for an endpoint. Idempotent. */
export async function removePushSubscription(
  db: Database,
  actor: PushActor,
  endpoint: string,
): Promise<{ removed: boolean }> {
  const rows = await db
    .delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, actor.userId), eq(pushSubscriptions.endpoint, endpoint)))
    .returning({ id: pushSubscriptions.id });
  return { removed: rows.length > 0 };
}

