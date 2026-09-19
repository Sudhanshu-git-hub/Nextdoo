import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, expect, it } from 'vitest';
import { dedicatedDatabase } from '../../../tests/dedicated-database';

/**
 * M6-i7 worker-level regression for `accounts.purge` (PRD §12.4 general job
 * contract: max retry count, exponential backoff, dead-letter behavior,
 * structured error code).
 *
 * The runtime module builds its pool from DATABASE_URL at import time, so
 * the worker is pointed at its own disposable database before the import —
 * the same isolation the retention-purge suite uses. The retry wrapper is
 * exercised with an injected fake (no database), then the real sweep runs
 * end-to-end against this database.
 */

const originalDatabaseUrl = process.env.DATABASE_URL;
const dedicated = await dedicatedDatabase('nextdoo_account_purge_worker');
process.env.DATABASE_URL = dedicated.url;

const {
  ACCOUNT_PURGE_BACKOFF_MS,
  ACCOUNT_PURGE_MAX_ATTEMPTS,
  ACCOUNT_PURGE_MAX_RETRIES,
  JOBS,
  runAccountPurgeWithRetries,
  sweepDueAccounts,
} = await import('./jobs');
const { db, sql } = await import('./runtime');
const { auditLogs, users, workspaces } = await import('@nextdoo/db');

afterAll(async () => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  await sql.end({ timeout: 5 }).catch(() => {});
  await dedicated.close();
});

const DAY = 86_400_000;
const NOW = new Date('2026-09-12T00:00:00.000Z');

type Log = { level: 'info' | 'error'; message: string; fields?: Record<string, unknown> };

function harness(impl: (attempt: number) => { purged: string[]; failed: Array<{ userId: string; error: string }> } | Promise<{ purged: string[]; failed: Array<{ userId: string; error: string }> }> | never) {
  const state = { calls: 0 };
  const sleeps: number[] = [];
  const logs: Log[] = [];
  const runner = {
    sweep: () => {
      state.calls += 1;
      return Promise.resolve(impl(state.calls));
    },
    sleep: async (ms: number) => { sleeps.push(ms); },
    log: {
      info: (m: string, f?: Record<string, unknown>) => { logs.push({ level: 'info', message: m, fields: f }); },
      error: (m: string, f?: Record<string, unknown>) => { logs.push({ level: 'error', message: m, fields: f }); },
    },
  };
  return { runner, sleeps, logs, calls: () => state.calls };
}

it('exports a bounded retry contract: initial attempt + 3 retries with exponential backoff', () => {
  expect(ACCOUNT_PURGE_MAX_RETRIES).toBe(3);
  expect(ACCOUNT_PURGE_MAX_ATTEMPTS).toBe(4);
  expect(ACCOUNT_PURGE_BACKOFF_MS).toEqual([60_000, 5 * 60_000, 15 * 60_000]);
});

it('succeeds on the first attempt and reports the accounting', async () => {
  const h = harness(() => ({ purged: ['a', 'b'], failed: [{ userId: 'c', error: 'ForeignKeyViolation' }] }));
  const result = await runAccountPurgeWithRetries(h.runner);

  expect(h.calls()).toBe(1);
  expect(h.sleeps).toEqual([]);
  expect(result.processed).toBe(2);
  expect(result.details).toEqual({ purged: ['a', 'b'], failed: [{ userId: 'c', error: 'ForeignKeyViolation' }] });
  const completed = h.logs.find((l) => l.message === 'accounts.purge.completed');
  expect(completed).toMatchObject({ level: 'info', fields: { attempt: 1, accountsPurged: 2, accountsFailed: 1 } });
  // Every per-account failure is surfaced as an error log — never silent.
  expect(h.logs.filter((l) => l.message === 'account.purge_failed')).toEqual([
    { level: 'error', message: 'account.purge_failed', fields: { userId: 'c', error: 'ForeignKeyViolation', retriedOn: 'next pass' } },
  ]);
});

it('retries a failing run with the documented backoff and recovers', async () => {
  const h = harness((attempt) => {
    if (attempt < 3) throw new Error('connection refused');
    return { purged: ['a'], failed: [] };
  });
  const result = await runAccountPurgeWithRetries(h.runner);

  expect(h.calls()).toBe(3);
  expect(h.sleeps).toEqual([ACCOUNT_PURGE_BACKOFF_MS[0], ACCOUNT_PURGE_BACKOFF_MS[1]]);
  expect(result.processed).toBe(1);
  expect(result.details).toEqual({ purged: ['a'], failed: [] });
  expect(h.logs.filter((l) => l.message === 'accounts.purge.attempt_failed')).toHaveLength(2);
  expect(h.logs.some((l) => l.message === 'accounts.purge.dead_lettered')).toBe(false);
});

it('dead-letters after bounded retries with a loud alert; nothing is auto-skipped', async () => {
  const h = harness(() => {
    throw new Error('database unavailable');
  });
  const result = await runAccountPurgeWithRetries(h.runner);

  expect(h.calls()).toBe(ACCOUNT_PURGE_MAX_ATTEMPTS);
  expect(h.sleeps).toEqual(ACCOUNT_PURGE_BACKOFF_MS);
  expect(result.processed).toBe(0);
  expect(result.details).toEqual({ deadLettered: true, errorType: 'Error' });
  expect(h.logs.filter((l) => l.message === 'accounts.purge.attempt_failed')).toHaveLength(ACCOUNT_PURGE_MAX_ATTEMPTS);
  const dead = h.logs.filter((l) => l.message === 'accounts.purge.dead_lettered');
  expect(dead).toEqual([
    { level: 'error', message: 'accounts.purge.dead_lettered', fields: { maxAttempts: ACCOUNT_PURGE_MAX_ATTEMPTS, errorType: 'Error' } },
  ]);
});

it('the real sweep: due accounts are purged, a poisoned account fails audited and the next pass catches up', async () => {
  const cutoff = new Date(NOW.getTime() - 30 * DAY);

  const due = randomUUID();
  const notDue = randomUUID();
  for (const [id, offsetMs] of [[due, -31 * DAY], [notDue, -10 * DAY]] as const) {
    await db.insert(users).values({
      id,
      email: `worker-${id}@test.local`,
      passwordHash: 'test',
      name: null,
      timeZone: 'UTC',
      deletionRequestedAt: new Date(NOW.getTime() + offsetMs),
    });
    await db.insert(workspaces).values({ id: randomUUID(), ownerId: id, name: 'Worker purge fixture', timeZone: 'UTC' });
  }

  const first = await sweepDueAccounts(cutoff);
  expect(first.purged).toEqual([due]);
  expect(first.failed).toEqual([]);
  expect(await db.select({ id: users.id }).from(users).where(eq(users.id, due))).toHaveLength(0);
  // The audit trail carries the compliance record of the destructive step.
  const audit = await db
    .select({ action: auditLogs.action, metadata: auditLogs.metadata })
    .from(auditLogs)
    .where(eq(auditLogs.actorId, due));
  expect(audit.some((a) => a.action === 'account.purged' && typeof (a.metadata as Record<string, unknown>).purgedAt === 'string')).toBe(true);

  // Idempotent rerun: the committed purge is not repeated.
  const second = await sweepDueAccounts(cutoff);
  expect(second.purged).toEqual([]);
  expect(second.failed).toEqual([]);

  // Clean up the still-pending fixture so the database dies empty.
  await db.delete(users).where(eq(users.id, notDue));
});

it('the registered job runs end-to-end through the production wiring', async () => {
  const job = JOBS.find((j) => j.name === 'accounts.purge');
  expect(job).toBeDefined();
  expect(job!.intervalMs).toBe(6 * 60 * 60_000);

  const id = randomUUID();
  await db.insert(users).values({
    id,
    email: `job-${id}@test.local`,
    passwordHash: 'test',
    name: null,
    timeZone: 'UTC',
    deletionRequestedAt: new Date(NOW.getTime() - 31 * DAY),
  });
  await db.insert(workspaces).values({ id: randomUUID(), ownerId: id, name: 'Job fixture', timeZone: 'UTC' });

  const result = await job!.run();
  expect(result.processed).toBe(1);
  expect(await db.select({ id: users.id }).from(users).where(eq(users.id, id))).toHaveLength(0);
});
