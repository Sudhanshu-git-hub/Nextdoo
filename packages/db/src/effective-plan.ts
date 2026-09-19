import { eq } from 'drizzle-orm';
import { subscriptions } from './schema';
import type { Database } from './client';
export async function readEffectivePlan(db: Database, userId: string): Promise<'FREE' | 'PRO' | 'TEAM' | 'ENTERPRISE'> {
  const rows = await db
    .select({ plan: subscriptions.plan, status: subscriptions.status, currentPeriodEnd: subscriptions.currentPeriodEnd, graceEndsAt: subscriptions.graceEndsAt })
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
    .limit(1);
  const sub = rows[0];
  if (!sub) return 'FREE';
  if (sub.status === 'CANCELED' && sub.currentPeriodEnd && sub.currentPeriodEnd > new Date()) return sub.plan;
  if (sub.status === 'GRACE_PERIOD' || sub.status === 'PAST_DUE') {
    const deadline = sub.graceEndsAt ?? (sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd.getTime() + 7 * 86400000) : null);
    return deadline && deadline > new Date() ? sub.plan : 'FREE';
  }
  // Only these states grant paid entitlements.
  const entitled = ['TRIALING', 'ACTIVE'];
  return entitled.includes(sub.status) ? sub.plan : 'FREE';
}
