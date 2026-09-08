import { and, count, eq, inArray, isNull } from 'drizzle-orm';
import { AppError, limitsFor } from '@nextdoo/contracts';
import { projects, tasks } from '@nextdoo/db';
import { getDb } from '../db';
import { getPlan } from './accounts';

/**
 * Server-side entitlement enforcement (PRD §18.3).
 * Limits are resolved from verified billing state; a client can never grant itself access.
 */

export async function enforceTaskLimit(userId: string, workspaceId: string): Promise<void> {
  const limits = limitsFor(await getPlan(userId));
  if (limits.activeTasks === null) return;

  const db = getDb();
  const [row] = await db
    .select({ n: count() })
    .from(tasks)
    .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.status, 'ACTIVE'), isNull(tasks.deletedAt)));

  if ((row?.n ?? 0) >= limits.activeTasks) {
    throw new AppError(
      'ENTITLEMENT_LIMIT_REACHED',
      `Your plan allows ${limits.activeTasks} active tasks. Complete or archive some, or upgrade to add more.`,
    );
  }
}

export async function enforceProjectLimit(userId: string, workspaceId: string): Promise<void> {
  const limits = limitsFor(await getPlan(userId));
  if (limits.projects === null) return;

  const db = getDb();
  const [row] = await db
    .select({ n: count() })
    .from(projects)
    .where(and(eq(projects.workspaceId, workspaceId), eq(projects.status, 'ACTIVE'), isNull(projects.deletedAt)));

  if ((row?.n ?? 0) >= limits.projects) {
    throw new AppError(
      'ENTITLEMENT_LIMIT_REACHED',
      `Your plan allows ${limits.projects} projects. Archive one, or upgrade to add more.`,
    );
  }
}

export async function getEntitlementSnapshot(userId: string, workspaceId: string) {
  const plan = await getPlan(userId);
  const limits = limitsFor(plan);
  const db = getDb();
  const [taskRow] = await db
    .select({ n: count() })
    .from(tasks)
    .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.status, 'ACTIVE'), isNull(tasks.deletedAt)));
  const [projectRow] = await db
    .select({ n: count() })
    .from(projects)
    .where(and(eq(projects.workspaceId, workspaceId), eq(projects.status, 'ACTIVE'), isNull(projects.deletedAt)));

  return {
    plan,
    limits,
    usage: { activeTasks: taskRow?.n ?? 0, projects: projectRow?.n ?? 0 },
  };
}
