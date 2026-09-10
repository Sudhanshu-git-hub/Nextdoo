import { logger } from '../observability';
import { and, desc, eq, gte, inArray, isNotNull, isNull, like, lte, or } from 'drizzle-orm';
import { AppError } from '@nextdoo/contracts';
import {
  purgeAccount,
  auditLogs,
  projects,
  reminders,
  sections,
  tags,
  taskTags,
  tasks,
  timerSessions,
  trackingEvents,
  trackingResults,
  users,
  userPreferences, recurrenceRules, taskOccurrences, taskDependencies, trackingCorrections, notifications, subscriptions, sessions, deviceRegistrations,
  workspaces,
} from '@nextdoo/db';
import { getDb, withTransaction } from '../db';
import { withAccountTransaction } from '../account-security';
import { revokeAllSessions, verifyPassword } from '../auth';
import { writeAuditLog } from './events';
import { absoluteUrl, sendMail } from '../mailer';

/**
 * Export and account deletion (PRD §12.4, §13.5).
 *
 * Both are user rights, not favours: the export must be complete enough to
 * reconstruct the account elsewhere, and deletion must be honest about what is
 * removed and when.
 */

const DELETION_GRACE_DAYS = 30;

export interface ExportBundle {
  formatVersion: 1;
  exportedAt: string;
  account: Record<string, unknown>;
  workspaces: unknown[];
  projects: unknown[];
  sections: unknown[];
  tags: unknown[];
  tasks: unknown[];
  taskTags: unknown[];
  reminders: unknown[];
  timerSessions: unknown[];
  trackingEvents: unknown[];
  trackingResults: unknown[];
  auditLogs: unknown[];
  preferences: unknown[];
  recurrenceRules: unknown[];
  taskOccurrences: unknown[];
  taskDependencies: unknown[];
  trackingCorrections: unknown[];
  notifications: unknown[];
  subscriptions: unknown[];
  sessions: unknown[];
  devices: unknown[];
}

/**
 * Credential-free snapshot of currently supported personal account data.
 * This is not the PRD signed/expiring asynchronous file export.
 *
 * Generated synchronously: a personal workspace is small, and a streamed job
 * would add a queue dependency for no benefit at this scale. The password hash
 * and MFA secret are deliberately excluded — exporting credentials would create
 * a new place for them to leak.
 */
export async function buildExport(userId: string): Promise<ExportBundle> {
  return withTransaction(async (db) => {

  const [account] = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      timeZone: users.timeZone,
      emailVerifiedAt: users.emailVerifiedAt,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!account) throw new AppError('NOT_FOUND', 'Account not found.');

  const owned = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.ownerId, userId));
  const workspaceIds = owned.map((w) => w.id);

  const [
    workspaceRows, projectRows, sectionRows, tagRows, taskRows,
    reminderRows, timerRows, eventRows, resultRows, auditRows,
  ] = await Promise.all([
    db.select().from(workspaces).where(inArray(workspaces.id, workspaceIds)),
    db.select().from(projects).where(inArray(projects.workspaceId, workspaceIds)),
    db.select().from(sections).where(inArray(sections.workspaceId, workspaceIds)),
    db.select().from(tags).where(inArray(tags.workspaceId, workspaceIds)),
    db.select().from(tasks).where(inArray(tasks.workspaceId, workspaceIds)),
    db.select().from(reminders).where(inArray(reminders.workspaceId, workspaceIds)),
    db.select().from(timerSessions).where(inArray(timerSessions.workspaceId, workspaceIds)),
    db.select().from(trackingEvents).where(inArray(trackingEvents.workspaceId, workspaceIds)),
    db.select().from(trackingResults).where(inArray(trackingResults.workspaceId, workspaceIds)),
    db.select().from(auditLogs).where(or(inArray(auditLogs.workspaceId, workspaceIds), and(eq(auditLogs.actorId, userId), isNull(auditLogs.workspaceId)))),
  ]);

  const taskIds = taskRows.map((t) => t.id);
  const ownedTaskIds = new Set(taskIds);
  const taskTagRows = taskIds.length
    ? await db.select().from(taskTags).where(inArray(taskTags.taskId, taskIds))
    : [];

  const rules = await db.select().from(recurrenceRules).where(inArray(recurrenceRules.workspaceId, workspaceIds));
  const [preferences, occurrences, dependencies, corrections, notices, plans, sessionRows, devices] = await Promise.all([
    db.select().from(userPreferences).where(eq(userPreferences.userId, userId)),
    db.select().from(taskOccurrences).where(inArray(taskOccurrences.recurrenceRuleId, rules.map((r) => r.id))),
    db.select().from(taskDependencies).where(inArray(taskDependencies.taskId, taskIds)),
    db.select().from(trackingCorrections).where(inArray(trackingCorrections.workspaceId, workspaceIds)),
    db.select().from(notifications).where(eq(notifications.userId, userId)),
    db.select().from(subscriptions).where(eq(subscriptions.userId, userId)),
    db.select({ id: sessions.id, deviceLabel: sessions.deviceLabel, createdAt: sessions.createdAt, lastSeenAt: sessions.lastSeenAt, expiresAt: sessions.expiresAt, revokedAt: sessions.revokedAt }).from(sessions).where(eq(sessions.userId, userId)),
    db.select({ id: deviceRegistrations.id, deviceId: deviceRegistrations.deviceId, platform: deviceRegistrations.platform, label: deviceRegistrations.label }).from(deviceRegistrations).where(eq(deviceRegistrations.userId, userId)),
  ]);
  await writeAuditLog({
    userId,
    action: 'account.exported',
    entityType: 'user',
    entityId: userId,
    metadata: { taskCount: taskRows.length },
  });

  return {
    formatVersion: 1 as const,
    exportedAt: new Date().toISOString(),
    account,
    workspaces: workspaceRows,
    projects: projectRows,
    sections: sectionRows,
    tags: tagRows,
    tasks: taskRows,
    taskTags: taskTagRows,
    reminders: reminderRows,
    timerSessions: timerRows,
    trackingEvents: eventRows,
    trackingResults: resultRows,
    auditLogs: auditRows,
    preferences, recurrenceRules: rules, taskOccurrences: occurrences, taskDependencies: dependencies,
    trackingCorrections: corrections, notifications: notices.filter((n) => n.workspaceId === null || workspaceIds.includes(n.workspaceId)).map((n) => n.taskId && !ownedTaskIds.has(n.taskId) ? { ...n, taskId: null, reminderId: null, title: 'Reminder for unavailable task', body: null } : n), subscriptions: plans, sessions: sessionRows, devices,
  };
  }, { isolationLevel: 'repeatable read' });
}

export interface DeletionStatus {
  scheduled: boolean;
  requestedAt: string | null;
  purgeAfter: string | null;
}

/**
 * Schedules deletion after a grace period rather than deleting immediately.
 *
 * The grace window exists because account deletion is the one action a user
 * cannot undo, and a compromised session should not be able to destroy someone's
 * data instantly.
 */
export async function requestAccountDeletion(userId: string, password: string): Promise<DeletionStatus> {
  let email: string | undefined;
  const result = await withAccountTransaction(userId, async (db) => {

  const [user] = await db
    .select({ passwordHash: users.passwordHash, email: users.email, deletionRequestedAt: users.deletionRequestedAt })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .limit(1);

  if (!user) throw new AppError('NOT_FOUND', 'Account not found.');

  // Re-authenticate: a session alone must not be enough to destroy the account.
  if (!(await verifyPassword(user.passwordHash, password))) {
    throw new AppError('VALIDATION_FAILED', 'That password is not correct.');
  }

  const requestedAt = user.deletionRequestedAt ?? new Date();
  await db.update(users).set({ deletionRequestedAt: requestedAt, updatedAt: new Date() }).where(eq(users.id, userId));

  // Every session ends: the account is on its way out.
  await revokeAllSessions(userId);

  const purgeAfter = new Date(requestedAt.getTime() + DELETION_GRACE_DAYS * 86_400_000);
  await writeAuditLog({
    userId,
    action: 'account.deletion_requested',
    entityType: 'user',
    entityId: userId,
    metadata: { purgeAfter: purgeAfter.toISOString() },
  });
  email = user.email;

  return { scheduled: true, requestedAt: requestedAt.toISOString(), purgeAfter: purgeAfter.toISOString() };
  });
  if (email) {
    try { await sendMail('account-deletion', email, absoluteUrl('/login')); }
    catch { logger.warn('account.deletion_notice_unavailable', { userId }); }
  }
  return result;
}

/** Signing in during the grace window cancels the deletion. */
export async function cancelAccountDeletion(userId: string): Promise<void> {
  return withAccountTransaction(userId, async (db) => {

  const updated = await db
    .update(users)
    .set({ deletionRequestedAt: null, updatedAt: new Date() })
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .returning({ id: users.id });

  if (updated.length) {
    await writeAuditLog({ userId, action: 'account.deletion_cancelled', entityType: 'user', entityId: userId });
  }
  });
}

export async function getDeletionStatus(userId: string): Promise<DeletionStatus> {
  const db = getDb();
  const [user] = await db
    .select({ requestedAt: users.deletionRequestedAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user?.requestedAt) return { scheduled: false, requestedAt: null, purgeAfter: null };
  return {
    scheduled: true,
    requestedAt: user.requestedAt.toISOString(),
    purgeAfter: new Date(user.requestedAt.getTime() + DELETION_GRACE_DAYS * 86_400_000).toISOString(),
  };
}

/**
 * Permanently removes accounts whose grace period has elapsed. Called by the
 * worker, never by a request.
 *
 * Domain rows cascade at final purge. Private outbox/replay payloads require
 * explicit cleanup; audit/security evidence is retained under its separate policy.
 */
export async function purgeDueAccounts(now = new Date()): Promise<string[]> {
  const db = getDb();
  const cutoff = new Date(now.getTime() - DELETION_GRACE_DAYS * 86_400_000);

  const due = await db
    .select({ id: users.id })
    .from(users)
    .where(and(isNotNull(users.deletionRequestedAt), lte(users.deletionRequestedAt, cutoff)));

  const purged: string[] = [];
  for (const candidate of due) {
    // One statement per account so a single failure cannot abort the whole run.
    if (await purgeAccount(db, candidate.id, cutoff)) purged.push(candidate.id);
  }
  return purged;
}

/**
 * Recent security-relevant activity for the account (PRD §12.4).
 *
 * Scoped to the caller's own actions and workspace; metadata is returned as
 * stored, which by construction never contains task content or secrets.
 *
 * `retentionDays` (PRD §18.1 "Audit log retention") bounds the visible
 * history: 0 means the plan retains nothing, so the list is empty; a finite
 * number hides rows older than that many days. `undefined` applies no plan
 * filter (internal callers). Note the filter bounds what is *shown*; rows are
 * not destroyed here — destruction is the account-history purge's job.
 */
export async function listAuditLogs(
  userId: string,
  workspaceId: string,
  limit = 50,
  /** Optional action-namespace filter, e.g. `account.` for security events only. */
  prefix?: string,
  retentionDays?: number | null,
) {
  const db = getDb();
  if (retentionDays === 0) return [];
  return db
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      targetType: auditLogs.targetType,
      targetId: auditLogs.targetId,
      metadata: auditLogs.metadata,
      createdAt: auditLogs.createdAt,
    })
    .from(auditLogs)
    .where(
      and(
        // `actorId` is the authorization boundary. Account-level events
        // (password reset, MFA, deletion) are recorded with no workspace
        // because they happen outside a session, so a strict workspace
        // equality check would hide precisely the security history the
        // account owner needs to see.
        eq(auditLogs.actorId, userId),
        or(eq(auditLogs.workspaceId, workspaceId), isNull(auditLogs.workspaceId)),
        // `prefix` is never user-supplied free text; it is validated against an
        // allow-list at the route boundary before reaching this query.
        prefix ? like(auditLogs.action, `${prefix}%`) : undefined,
        // Plan retention window (PRD §18.1): older rows stay in the database
        // as internal security evidence but are not shown on the plan.
        retentionDays !== undefined && retentionDays !== null
          ? gte(auditLogs.createdAt, new Date(Date.now() - retentionDays * 86_400_000))
          : undefined,
      ),
    )
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit);
}
