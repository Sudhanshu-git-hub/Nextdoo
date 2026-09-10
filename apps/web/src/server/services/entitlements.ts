import { and, count, eq, isNull } from 'drizzle-orm';
import { AppError, limitsFor } from '@nextdoo/contracts';
import { calendarConnections, projects, tasks, workspaces } from '@nextdoo/db';
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

/**
 * PRD §18.1 "Historical analytics" (Free: 30 days): historical analytics
 * queries are bounded to the last `trackingHistoryDays` workspace-local days.
 * `dateKey` is a local calendar date (YYYY-MM-DD) in the workspace time zone,
 * the same convention the tracking endpoints use.
 */
export async function assertHistoryWindow(userId: string, workspaceId: string, dateKey: string | null): Promise<void> {
  if (dateKey === null) return;
  const days = limitsFor(await getPlan(userId)).trackingHistoryDays;
  if (days === null) return;
  const [ws] = await getDb().select({ timeZone: workspaces.timeZone }).from(workspaces).where(eq(workspaces.id, workspaceId));
  const tz = ws?.timeZone ?? 'UTC';
  const [y, m, d] = dateKey.split('-').map(Number) as [number, number, number];
  const requested = Date.UTC(y, m - 1, d);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const today = Date.UTC(part('year'), part('month') - 1, part('day'));
  const ageDays = Math.round((today - requested) / 86_400_000);
  if (ageDays > days) {
    throw new AppError('ENTITLEMENT_LIMIT_REACHED', `Your plan shows analytics for the last ${days} days. Upgrade to see older history.`);
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
  const [connectionRow] = await db
    .select({ n: count() })
    .from(calendarConnections)
    .where(and(eq(calendarConnections.userId, userId), eq(calendarConnections.status, 'ACTIVE')));

  return {
    plan,
    limits,
    usage: { activeTasks: taskRow?.n ?? 0, projects: projectRow?.n ?? 0, calendarConnections: connectionRow?.n ?? 0 },
  };
}
