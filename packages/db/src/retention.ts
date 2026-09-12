import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import type { Database } from './client';
import {
  attachments,
  exports as exportsTable,
  syncTombstones,
  tasks,
  workspaces,
} from './schema';
import { limitsFor } from '@nextdoo/contracts';
import { readEffectivePlan } from './effective-plan';
import type { AttachmentObjectStore } from './attachment-storage';

/**
 * Destructive retention pipeline (PRD §12.4 job `retention.purge`, §13.5,
 * §18.1 "Audit log retention", §6.3 state machine "Deleted → Permanently
 * deleted: System retention job").
 *
 * Design rules:
 * - Every unit of work is atomic and rechecked under a row lock, so a crash
 *   mid-pass never leaves a half-purged record and a rerun is a no-op for
 *   work already done (idempotent, crash-safe).
 * - Every sweep is bounded (batch size + per-pass caps) so a large backlog
 *   drains over successive daily runs instead of one giant transaction.
 * - Nothing is silently skipped: retained-by-policy rows and per-row
 *   failures are counted and returned so the worker can alert on them.
 * - Tenant isolation: task, tombstone and audit sweeps are scoped by
 *   workspace (account-level audit rows by owner); plans are read per owner.
 *
 * What is NOT removed (documented invariants):
 * - Tracking events/results/corrections/backfills survive task deletion for
 *   the life of the account (migration 0006 policy, PRD §13.5 "Tracking
 *   events: Life of account"). The "unless the tracking record is ...
 *   retained per policy" branch of PRD §6.3 is that retention policy.
 * - sync_changes rows (content-free replay log; deleting them would break
 *   replay for slow cursors).
 * - outbox rows (immutable publication log; removed only by account purge).
 * - Conflict snapshots (not part of this job's PRD scope).
 */

const DAY_MS = 86_400_000;

export const RETENTION = {
  /** PRD §13.5 "Deleted tasks | 30 days" — mirrors the restore window. */
  taskPurgeDays: 30,
  /** PRD §13.5 "Failed jobs | 30 days". */
  failedJobDays: 30,
  /**
   * PRD §13.5 "Security logs | 1 year". Security-critical audit rows are
   * retained at least this long even on plans with shorter audit retention
   * (FREE: 0 days). The action list is the app's security-critical audit
   * vocabulary (auth lifecycle, credentials, MFA, session revocation,
   * deletion compliance); see SECURITY_AUDIT_ACTIONS.
   */
  securityAuditFloorDays: 365,
} as const;

/**
 * Audit actions that count as "security logs" for the one-year floor.
 * Deliberately explicit: the floor applies only to this list, everything
 * else follows the plan retention exactly.
 */
export const SECURITY_AUDIT_ACTIONS: readonly string[] = [
  'account.registered',
  'account.signed_in',
  'account.mfa_failed',
  'account.mfa_enabled',
  'account.mfa_disabled',
  'account.password_changed',
  'account.password_reset',
  'account.password_reset_requested',
  'account.recovery_code_used',
  'account.email_verified',
  'account.session_revoked',
  'account.sessions_revoked_all',
  'account.deletion_requested',
  'account.deletion_cancelled',
];

/**
 * The security list is embedded in the raw sweep SQL as a quoted constant:
 * drizzle's sql tag expands JS arrays into parameter rows, which `any()`/`in`
 * over an array do not accept (verified against this postgres.js driver).
 * Every entry is validated against a strict allowlist before embedding, so
 * nothing from outside this constant can reach the SQL text.
 */
const SECURITY_ACTIONS_SQL: string = SECURITY_AUDIT_ACTIONS.map((action) => {
  if (!/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/.test(action)) {
    throw new Error(`Unsafe audit action for SQL embedding: ${action}`);
  }
  return `'${action}'`;
}).join(', ');

const iso = (date: Date): string => date.toISOString();

export interface RetentionPurgeFailure {
  kind: 'task' | 'tombstone' | 'audit' | 'failed_jobs' | 'attachment_file';
  id: string | null;
  error: string;
}

export interface RetentionPurgeResult {
  now: Date;
  /** Tasks whose restore window closed, deleted with their cascaded rows. */
  tasksPurged: number;
  /** Eligible tasks retained because the owner has in-flight exports. */
  tasksRetainedForExports: number;
  /**
   * Eligible tasks retained because other task rows still reference them
   * (parentTaskId is a no-action FK, so the row cannot be deleted). These
   * converge: once the referencing tasks are purged themselves, the parent
   * becomes deletable on a later run.
   */
  tasksRetainedForReferencingTasks: number;
  syncTombstonesPurged: number;
  auditLogsPurged: number;
  /** Security rows kept by the one-year floor (reporting only). */
  securityAuditRetained: number;
  workspacesScanned: number;
  accountOwnersScanned: number;
  failedJobsPurged: {
    trackingJobs: number;
    reminders: number;
    exports: number;
    mailDeliveries: number;
  };
  attachmentFilesRemoved: number;
  /** Per-row problems; each is also expected to be alerted by the worker. */
  failures: RetentionPurgeFailure[];
}

export interface RetentionPurgeOptions {
  /** Injectable clock for boundary tests. */
  now?: Date;
  /** Removes attachment files of purged tasks (like purgeAccount). */
  attachmentStore?: AttachmentObjectStore;
  /** Bounded batch sizes; small values let tests observe partial passes. */
  limit?: {
    tasks?: number;
    tombstones?: number;
    auditBatchesPerWorkspace?: number;
    workspaces?: number;
    accountOwners?: number;
    failedJobs?: number;
  };
}

const DEFAULT_LIMITS = {
  tasks: 1000,
  tombstones: 1000,
  auditBatchesPerWorkspace: 20,
  // Per-run caps on how many DISTINCT tenants are scanned, not on raw rows:
  // a single busy tenant must not be able to inflate its way into the whole
  // slot budget and starve other tenants' retention. Purged tenants drop out
  // of the candidate set, so each daily run makes forward progress.
  workspaces: 200,
  accountOwners: 200,
  failedJobs: 1000,
};

/**
 * Drizzle wraps driver errors in a "Failed query" envelope; the root
 * message on `cause` (FK violation, timeout, trigger exception) is the one
 * an operator can act on, so failures surface that.
 */
const errorOf = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  return cause instanceof Error ? cause.message : error.message;
};

export async function runRetentionPurge(
  db: Database,
  opts: RetentionPurgeOptions = {},
): Promise<RetentionPurgeResult> {
  const now = opts.now ?? new Date();
  const L = { ...DEFAULT_LIMITS, ...(opts.limit ?? {}) };
  const taskCutoff = new Date(now.getTime() - RETENTION.taskPurgeDays * DAY_MS);
  const failedJobCutoff = new Date(now.getTime() - RETENTION.failedJobDays * DAY_MS);
  const failures: RetentionPurgeFailure[] = [];
  const result: RetentionPurgeResult = {
    now,
    tasksPurged: 0,
    tasksRetainedForExports: 0,
    tasksRetainedForReferencingTasks: 0,
    syncTombstonesPurged: 0,
    auditLogsPurged: 0,
    securityAuditRetained: 0,
    workspacesScanned: 0,
    accountOwnersScanned: 0,
    failedJobsPurged: { trackingJobs: 0, reminders: 0, exports: 0, mailDeliveries: 0 },
    attachmentFilesRemoved: 0,
    failures,
  };

  // ---------------------------------------------------------------- tasks
  // A task becomes purge-eligible exactly when its restore window closes
  // (deleted_at <= now - 30 days); the restore path rejects at the same
  // boundary, so the two never overlap and never diverge.
  //
  // Note: raw sweep SQL passes timestamps as ISO strings (the drizzle
  // execute path of this postgres.js driver rejects Date parameters); the
  // string is cast contextually against the timestamptz column.
  const nowIso = iso(now);
  const taskCutoffIso = iso(taskCutoff);
  const failedJobCutoffIso = iso(failedJobCutoff);
  let taskBatch: { id: string }[];
  let batchProgress = 0;
  do {
    taskBatch = (await db.execute(sql`
      select id from tasks
      where status = 'DELETED' and deleted_at is not null
        and deleted_at <= ${taskCutoffIso}
      order by deleted_at, id
      limit ${L.tasks}
    `)) as unknown as { id: string }[];
    batchProgress = 0;
    for (const candidate of taskBatch) {
      const pendingFiles: string[] = [];
      try {
        const purged = await db.transaction(async (tx) => {
          // Recheck under lock: a concurrent restore (or a row already
          // handled by a racing run) must not be deleted.
          const [locked] = await tx
            .select({ id: tasks.id, status: tasks.status, deletedAt: tasks.deletedAt, workspaceId: tasks.workspaceId })
            .from(tasks)
            .where(eq(tasks.id, candidate.id))
            .for('update');
          if (!locked || locked.status !== 'DELETED' || !locked.deletedAt || locked.deletedAt.getTime() > taskCutoff.getTime()) return null;

          const [workspace] = await tx
            .select({ ownerId: workspaces.ownerId })
            .from(workspaces)
            .where(eq(workspaces.id, locked.workspaceId));

          // tasks.parent_task_id is a no-action FK: while any task row still
          // references this one (soft-deleting a parent does not re-parent
          // children), the row physically cannot be deleted. Retain it; it
          // becomes deletable once the referencing tasks are purged too.
          const [referencing] = await tx
            .select({ id: tasks.id })
            .from(tasks)
            .where(eq(tasks.parentTaskId, candidate.id))
            .limit(1);
          if (referencing) { result.tasksRetainedForReferencingTasks += 1; return 'blocked' as const; }

          // An in-flight export (PENDING/PROCESSING) is generated from the
          // current rows, so its source data must survive until it completes
          // or fails. READY exports already own a materialized artifact and
          // do not block (PRD §13.5: export files 24 hours).
          if (workspace?.ownerId) {
            const [activeExport] = await tx
              .select({ id: exportsTable.id })
              .from(exportsTable)
              .where(and(eq(exportsTable.userId, workspace.ownerId), inArray(exportsTable.status, ['PENDING', 'PROCESSING'])))
              .limit(1);
            if (activeExport) { result.tasksRetainedForExports += 1; return 'blocked' as const; }
          }

          // Attachment files do not cascade; enumerate their keys under the
          // same lock and remove them after the commit (purgeAccount pattern).
          const fileRows = await tx
            .select({ objectKey: attachments.objectKey })
            .from(attachments)
            .where(eq(attachments.taskId, candidate.id));
          for (const row of fileRows) if (row.objectKey) pendingFiles.push(row.objectKey);

          const deleted = await tx
            .delete(tasks)
            .where(eq(tasks.id, candidate.id))
            .returning({ id: tasks.id });
          if (!deleted.length) return null;

          const tombstones = await tx
            .delete(syncTombstones)
            .where(and(eq(syncTombstones.entityType, 'task'), eq(syncTombstones.entityId, candidate.id), lte(syncTombstones.purgeAfter, now)))
            .returning({ id: syncTombstones.id });
          result.syncTombstonesPurged += tombstones.length;
          return candidate.id;
        });
        if (purged === null || purged === 'blocked') continue;
        result.tasksPurged += 1;
        batchProgress += 1;
      } catch (error) {
        // One poisoned row must not stop the sweep; it stays eligible and is
        // retried next run, and the worker alerts on it.
        failures.push({ kind: 'task', id: candidate.id, error: errorOf(error) });
        batchProgress += 1;
        continue;
      }
      if (opts.attachmentStore) {
        for (const key of pendingFiles) {
          try {
            await opts.attachmentStore.remove(key);
            result.attachmentFilesRemoved += 1;
          } catch (error) {
            // A bad file must not un-delete the task (purgeAccount pattern);
            // it is reported so operations can chase it.
            failures.push({ kind: 'attachment_file', id: key, error: errorOf(error) });
          }
        }
      }
    }
    // No forward progress (e.g. every candidate retained for an active
    // export) ends the pass; those rows are retried on the next run.
    if (batchProgress === 0) break;
  } while (taskBatch.length === L.tasks);

  // ------------------------------------------------------------- tombstones
  try {
    const due = (await db.execute(sql`
      delete from sync_tombstones
      where id in (
        select id from sync_tombstones
        where purge_after <= ${nowIso}
        order by purge_after, id
        limit ${L.tombstones}
        for update skip locked
      )
      returning id
    `)) as unknown as { id: string }[];
    result.syncTombstonesPurged += due.length;
  } catch (error) {
    failures.push({ kind: 'tombstone', id: null, error: errorOf(error) });
  }

  // ------------------------------------------------------------ audit logs
  // Plan retention comes from the same entitlement source the read side uses
  // (limitsFor(plan).auditLogRetentionDays), so visibility and destruction
  // can never disagree about a plan's window. Rows are visible while
  // created_at >= now - R; they become eligible when created_at < now - R —
  // a strict complement: no gap, no overlap. The one-year security floor
  // applies only to SECURITY_AUDIT_ACTIONS and only where it is longer than
  // the plan window.
  const purgeAuditForOwner = async (ownerId: string, scope: ReturnType<typeof sql>): Promise<void> => {
    const plan = await readEffectivePlan(db, ownerId);
    const retentionDays = limitsFor(plan).auditLogRetentionDays;
    const securityDays = RETENTION.securityAuditFloorDays;

    // Precomputed cutoffs (ISO strings): non-security rows age out at the
    // plan window; security rows at the longer of plan window and floor.
    const planCutoffIso = iso(new Date(now.getTime() - retentionDays * DAY_MS));
    const floorCutoffIso = iso(new Date(now.getTime() - Math.max(retentionDays, securityDays) * DAY_MS));
    const securityList = sql.raw(SECURITY_ACTIONS_SQL);

    // Rows protected by the floor (reporting only): security rows that the
    // plan window would have purged but the floor keeps.
    const retained = (await db.execute(sql`
      select count(*) as n from audit_logs
      where ${scope}
        and action in (${securityList})
        and created_at >= ${floorCutoffIso}
        and created_at < ${planCutoffIso}
    `)) as unknown as { n: number }[];
    result.securityAuditRetained += Number(retained[0]?.n ?? 0);

    for (let batch = 0; batch < L.auditBatchesPerWorkspace; batch += 1) {
      const deleted = (await db.execute(sql`
        delete from audit_logs
        where id in (
          select id from audit_logs
          where ${scope}
            and (
              (action in (${securityList}) and created_at < ${floorCutoffIso})
              or (action not in (${securityList}) and created_at < ${planCutoffIso})
            )
          order by created_at, id
          limit 1000
          for update skip locked
        )
        returning id
      `)) as unknown as { id: string }[];
      result.auditLogsPurged += deleted.length;
      if (deleted.length < 1000) break;
    }
  };

  try {
    const candidateWorkspaces = new Set(
      ((await db.execute(sql`
        select distinct workspace_id from audit_logs
        where workspace_id is not null and created_at < ${nowIso}
        order by 1
        limit ${L.workspaces}
      `)) as unknown as { workspace_id: string }[]).map((r) => r.workspace_id),
    );
    for (const workspaceId of candidateWorkspaces) {
      const [workspace] = await db
        .select({ ownerId: workspaces.ownerId })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId));
      if (!workspace?.ownerId) continue; // account gone; rows are orphaned evidence
      await purgeAuditForOwner(workspace.ownerId, sql`workspace_id = ${workspaceId}`);
      result.workspacesScanned += 1;
    }
  } catch (error) {
    failures.push({ kind: 'audit', id: null, error: errorOf(error) });
  }

  try {
    const candidateOwners = new Set(
      ((await db.execute(sql`
        select distinct actor_id from audit_logs
        where workspace_id is null and actor_id is not null and created_at < ${nowIso}
        order by 1
        limit ${L.accountOwners}
      `)) as unknown as { actor_id: string }[]).map((r) => r.actor_id),
    );
    for (const ownerId of candidateOwners) {
      await purgeAuditForOwner(ownerId, sql`workspace_id is null and actor_id = ${ownerId}`);
      result.accountOwnersScanned += 1;
    }
  } catch (error) {
    failures.push({ kind: 'audit', id: null, error: errorOf(error) });
  }

  // -------------------------------------------------------------- failed jobs
  // "Failed jobs | 30 days" (PRD §13.5): terminally failed entries only.
  // Retryable rows (attempts below the max, non-FAILED statuses) are live
  // work, not history, and are left alone.
  try {
    const tracking = (await db.execute(sql`
      delete from tracking_jobs
      where task_id in (
        select task_id from tracking_jobs
        where attempts >= 6 and last_error_at is not null
          and last_error_at <= ${failedJobCutoffIso}
          and claim_token is null and queued_revision <= acknowledged_revision
        order by last_error_at
        limit ${L.failedJobs}
        for update skip locked
      )
      returning task_id
    `)) as unknown as { task_id: string }[];
    result.failedJobsPurged.trackingJobs = tracking.length;
  } catch (error) {
    failures.push({ kind: 'failed_jobs', id: 'tracking_jobs', error: errorOf(error) });
  }
  try {
    const reminderRows = (await db.execute(sql`
      delete from reminders
      where id in (
        select id from reminders
        where status = 'FAILED' and updated_at <= ${failedJobCutoffIso}
        order by updated_at
        limit ${L.failedJobs}
        for update skip locked
      )
      returning id
    `)) as unknown as { id: string }[];
    result.failedJobsPurged.reminders = reminderRows.length;
  } catch (error) {
    failures.push({ kind: 'failed_jobs', id: 'reminders', error: errorOf(error) });
  }
  try {
    const exportRows = (await db.execute(sql`
      delete from exports
      where id in (
        select id from exports
        where status = 'FAILED' and updated_at <= ${failedJobCutoffIso}
        order by updated_at
        limit ${L.failedJobs}
        for update skip locked
      )
      returning id
    `)) as unknown as { id: string }[];
    result.failedJobsPurged.exports = exportRows.length;
  } catch (error) {
    failures.push({ kind: 'failed_jobs', id: 'exports', error: errorOf(error) });
  }
  try {
    const mailRows = (await db.execute(sql`
      delete from mail_deliveries
      where id in (
        select id from mail_deliveries
        where status = 'FAILED' and created_at <= ${failedJobCutoffIso}
        order by created_at
        limit ${L.failedJobs}
        for update skip locked
      )
      returning id
    `)) as unknown as { id: string }[];
    result.failedJobsPurged.mailDeliveries = mailRows.length;
  } catch (error) {
    failures.push({ kind: 'failed_jobs', id: 'mail_deliveries', error: errorOf(error) });
  }

  return result;
}
