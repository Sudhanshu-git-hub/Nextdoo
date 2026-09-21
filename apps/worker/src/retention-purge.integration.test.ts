import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, expect, it } from 'vitest';
import { dedicatedDatabase } from '../../../tests/dedicated-database';
import type { RetentionPurgeResult } from '@nextdoo/db';
import type { RetentionPurgeRunner } from './jobs';

/**
 * M6-i6 worker-level regression for `retention.purge` (PRD §12.4: Daily,
 * max retry count 3, "Alert; never auto-skip").
 *
 * The runtime module builds its pool from DATABASE_URL at import time, so
 * the worker is pointed at its own disposable database before the import —
 * the same isolation the web-side suite uses. The retry wrapper itself is
 * exercised with an injected fake (no database), and the real job is then
 * run end-to-end against this database.
 */

const originalDatabaseUrl = process.env.DATABASE_URL;
const dedicated = await dedicatedDatabase('nextdoo_retention_worker');
process.env.DATABASE_URL = dedicated.url;

const {
  JOBS,
  RETENTION_PURGE_BACKOFF_MS,
  RETENTION_PURGE_MAX_ATTEMPTS,
  RETENTION_PURGE_MAX_RETRIES,
  runRetentionPurgeWithRetries,
} = await import('./jobs');
const { db, sql } = await import('./runtime');
const {
  auditLogs,
  subscriptions,
  syncTombstones,
  tasks,
  users,
  workspaceMembers,
  workspaces,
} = await import('@nextdoo/db');

afterAll(async () => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  await sql.end({ timeout: 5 }).catch(() => {});
  await dedicated.close();
});

// ------------------------------------------------- retry wrapper (no DB)

const NOW = new Date('2026-09-12T00:00:00.000Z');

function makeResult(over: Partial<RetentionPurgeResult> = {}): RetentionPurgeResult {
  return {
    now: NOW,
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
    failures: [],
    ...over,
  };
}

interface Harness {
  runner: RetentionPurgeRunner;
  readonly purgeCalls: number;
  sleeps: number[];
  logs: Array<{ level: 'info' | 'error'; message: string; fields?: Record<string, unknown> }>;
}

function harness(impl: (attempt: number) => RetentionPurgeResult | Promise<RetentionPurgeResult> | never): Harness {
  const state = { calls: 0 };
  const sleeps: number[] = [];
  const logs: Harness['logs'] = [];
  const runner: RetentionPurgeRunner = {
    purge: async () => {
      state.calls += 1;
      return impl(state.calls);
    },
    sleep: async (ms) => { sleeps.push(ms); },
    log: {
      info: (message, fields) => logs.push({ level: 'info', message, fields }),
      error: (message, fields) => logs.push({ level: 'error', message, fields }),
    },
  };
  return { runner, sleeps, logs, get purgeCalls() { return state.calls; } };
}

it('PRD §12.4: bounded retries = initial attempt plus 3, with increasing backoff', () => {
  expect(RETENTION_PURGE_MAX_RETRIES).toBe(3);
  expect(RETENTION_PURGE_MAX_ATTEMPTS).toBe(1 + RETENTION_PURGE_MAX_RETRIES);
  expect(RETENTION_PURGE_BACKOFF_MS).toEqual([60_000, 5 * 60_000, 15 * 60_000]);
});

it('reports the full accounting on success and never sleeps', async () => {
  const h = harness(() => makeResult({
    tasksPurged: 3,
    syncTombstonesPurged: 1,
    auditLogsPurged: 2,
    failedJobsPurged: { trackingJobs: 1, reminders: 1, exports: 0, mailDeliveries: 0 },
    failures: [{ kind: 'attachment_file', id: 'attach-x/y.txt', error: 'boom' }],
  }));
  const result = await runRetentionPurgeWithRetries(h.runner);
  expect(h.purgeCalls).toBe(1);
  expect(h.sleeps).toEqual([]);
  // processed = every purged unit across all sweeps.
  expect(result.processed).toBe(8);
  expect(result.details).toMatchObject({ tasksPurged: 3, auditLogsPurged: 2 });
  const completed = h.logs.find((l) => l.message === 'retention.purge.completed');
  expect(completed?.level).toBe('info');
  expect(completed?.fields).toMatchObject({ attempt: 1, tasksPurged: 3, rowFailures: 1 });
  // Every per-row problem is alerted individually.
  expect(h.logs.filter((l) => l.message === 'retention.purge.row_failed')).toEqual([
    { level: 'error', message: 'retention.purge.row_failed', fields: { kind: 'attachment_file', id: 'attach-x/y.txt', error: 'boom' } },
  ]);
  expect(h.logs.some((l) => l.message === 'retention.purge.dead_lettered')).toBe(false);
});

it('retries after a failed attempt and succeeds within the budget', async () => {
  const h = harness((attempt) => {
    if (attempt <= 2) throw new Error('db down');
    return makeResult({ tasksPurged: 1 });
  });
  const result = await runRetentionPurgeWithRetries(h.runner);
  expect(h.purgeCalls).toBe(3);
  expect(h.sleeps).toEqual([60_000, 300_000]); // backoff between attempts 1→2, 2→3
  const failed = h.logs.filter((l) => l.message === 'retention.purge.attempt_failed');
  expect(failed.map((l) => l.fields)).toEqual([
    { attempt: 1, maxAttempts: 4, errorType: 'Error', retryInMs: 60_000 },
    { attempt: 2, maxAttempts: 4, errorType: 'Error', retryInMs: 300_000 },
  ]);
  expect(h.logs.find((l) => l.message === 'retention.purge.completed')?.fields).toMatchObject({ attempt: 3, tasksPurged: 1 });
  expect(h.logs.some((l) => l.message === 'retention.purge.dead_lettered')).toBe(false);
  expect(result.processed).toBe(1);
});

it('exhausts the bounded retries, dead-letters with a loud alert, and never throws', async () => {
  const h = harness(() => { throw new Error('db down'); });
  const result = await runRetentionPurgeWithRetries(h.runner);
  expect(h.purgeCalls).toBe(4); // initial + 3 retries
  expect(h.sleeps).toEqual([60_000, 300_000, 900_000]);
  // Every failed attempt is alerted (the final one with retryInMs 0).
  expect(h.logs.filter((l) => l.message === 'retention.purge.attempt_failed')).toHaveLength(4);
  const dead = h.logs.find((l) => l.message === 'retention.purge.dead_lettered');
  expect(dead?.level).toBe('error');
  expect(dead?.fields).toMatchObject({ maxAttempts: 4, errorType: 'Error' });
  // A dead-lettered run still returns normally so the supervisor does not
  // loop a daily job; the un-purged rows simply stay for the next run.
  expect(result.processed).toBe(0);
  expect(result.details).toMatchObject({ deadLettered: true, errorType: 'Error' });
});

// ------------------------------------------------------- the real job (DB)

it('the registered retention.purge job sweeps on a daily interval and returns full accounting', async () => {
  const job = JOBS.find((j) => j.name === 'retention.purge');
  expect(job).toBeDefined();
  expect(job!.intervalMs).toBe(24 * 60 * 60 * 1000); // PRD §12.4: Daily

  const userId = randomUUID();
  const workspaceId = randomUUID();
  await db.insert(users).values({
    id: userId, email: `retention-worker-${userId}@test.local`,
    passwordHash: 'test', name: null, timeZone: 'UTC',
  });
  await db.insert(workspaces).values({ id: workspaceId, ownerId: userId, name: 'Worker retention', timeZone: 'UTC' });
  await db.insert(workspaceMembers).values({ workspaceId, userId, role: 'OWNER' });
  await db.insert(subscriptions).values({
    id: randomUUID(), userId, plan: 'FREE', status: 'ACTIVE',
    currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
  });

  const taskId = randomUUID();
  const deletedAt = new Date(NOW.getTime() - 31 * 86_400_000);
  await db.insert(tasks).values({ id: taskId, workspaceId, title: 'Worker retention task', status: 'DELETED', deletedAt });
  await db.insert(syncTombstones).values({
    id: randomUUID(), workspaceId, entityType: 'task', entityId: taskId,
    deletedAt, purgeAfter: new Date(deletedAt.getTime() + 30 * 86_400_000),
  });
  // FREE retains 0 days: a 50-day-old row is due.
  const auditId = randomUUID();
  await db.insert(auditLogs).values({
    id: auditId, workspaceId, actorId: userId,
    action: 'task.updated', targetType: 'task', targetId: taskId,
    createdAt: new Date(NOW.getTime() - 50 * 86_400_000),
  });

  const result = await job!.run();
  const details = result.details as unknown as RetentionPurgeResult;
  // processed = task + its expired tombstone + the due audit row.
  expect(result.processed).toBe(3);
  expect(details.tasksPurged).toBe(1);
  expect(details.auditLogsPurged).toBe(1);
  expect(details.syncTombstonesPurged).toBe(1);
  expect(details.failures).toEqual([]);
  expect(await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, taskId))).toEqual([]);
  expect(await db.select({ id: auditLogs.id }).from(auditLogs).where(eq(auditLogs.id, auditId))).toEqual([]);
});
