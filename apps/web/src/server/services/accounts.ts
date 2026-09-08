import { and, eq, isNull } from 'drizzle-orm';
import { AppError } from '@nextdoo/contracts';
import { subscriptions, users, workspaces, workspaceMembers } from '@nextdoo/db';
import { getDb } from '../db';
import { newId } from '../ids';
import { writeAudit } from './events';

/**
 * Account and workspace provisioning (PRD §6.1, §6.2).
 * Registration creates the user, their personal workspace, membership and a
 * FREE subscription in one transaction — a half-provisioned account is unusable.
 */

export interface RegisterInput {
  email: string;
  passwordHash: string;
  name: string | null;
  timeZone: string;
}

export async function registerUser(input: RegisterInput) {
  const db = getDb();

  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, input.email))
      .limit(1);
    if (existing[0]) {
      // Deliberately vague: this endpoint must not confirm account existence.
      throw new AppError('VALIDATION_FAILED', 'This email address cannot be registered.');
    }

    const userId = newId();
    const workspaceId = newId();

    await tx.insert(users).values({
      id: userId,
      email: input.email,
      passwordHash: input.passwordHash,
      name: input.name,
      timeZone: input.timeZone,
    });

    await tx.insert(workspaces).values({
      id: workspaceId,
      ownerId: userId,
      name: input.name ? `${input.name}'s workspace` : 'My workspace',
      timeZone: input.timeZone,
    });

    await tx.insert(workspaceMembers).values({ workspaceId, userId, role: 'OWNER' });

    await tx.insert(subscriptions).values({
      id: newId(),
      userId,
      plan: 'FREE',
      status: 'ACTIVE',
    });

    await writeAudit(tx, {
      workspaceId,
      actorId: userId,
      action: 'account.registered',
      targetType: 'user',
      targetId: userId,
    });

    return { id: userId, email: input.email, workspaceId };
  });
}

export async function findUserByEmail(email: string) {
  const db = getDb();
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      passwordHash: users.passwordHash,
      status: users.status,
      deletedAt: users.deletedAt,
      deletionRequestedAt: users.deletionRequestedAt,
      timeZone: users.timeZone,
    })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  const user = rows[0];
  if (!user) return null;

  const ws = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(and(eq(workspaceMembers.userId, user.id), isNull(workspaces.deletedAt)))
    .limit(1);

  return { ...user, workspaceId: ws[0]?.id ?? '' };
}

export async function getWorkspace(workspaceId: string) {
  const db = getDb();
  const rows = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  return rows[0] ?? null;
}

/** Resolves the effective plan from verified billing state, never from the client. */
export async function getPlan(userId: string): Promise<'FREE' | 'PRO' | 'TEAM' | 'ENTERPRISE'> {
  const db = getDb();
  const rows = await db
    .select({ plan: subscriptions.plan, status: subscriptions.status })
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
    .limit(1);
  const sub = rows[0];
  if (!sub) return 'FREE';
  // Only these states grant paid entitlements.
  const entitled = ['TRIALING', 'ACTIVE', 'GRACE_PERIOD', 'PAST_DUE'];
  return entitled.includes(sub.status) ? sub.plan : 'FREE';
}
