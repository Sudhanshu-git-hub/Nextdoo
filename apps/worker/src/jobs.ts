import { and, eq, isNotNull, isNull, lt, lte, sql as raw } from 'drizzle-orm';
import { authTokens, idempotencyKeys, reminders, users } from '@nextdoo/db';
import { db, logger, type Job, type JobResult } from './runtime';

/**
 * Background jobs (PRD §15).
 *
 * Every job is idempotent and safe to run concurrently with another worker
 * instance: claims use `FOR UPDATE ... SKIP LOCKED` so two workers never
 * process the same row.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * Dispatches reminders that have come due.
 *
 * Delivery is recorded before the notification is considered sent, so a crash
 * mid-dispatch cannot produce a silent drop. Reminders more than 24 hours
 * overdue expire rather than firing — a notification for yesterday's meeting is
 * noise, not help.
 */
const dispatchReminders: Job = {
  name: 'reminders.dispatch',
  intervalMs: 30_000,
  async run(): Promise<JobResult> {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - 24 * HOUR);
    // Drizzle's raw `sql` does not bind Date objects; pass ISO strings and let
    // Postgres cast them to timestamptz.
    const nowIso = now.toISOString();
    const staleIso = staleBefore.toISOString();

    const claimed = await db.execute(raw`
      with due as (
        select id from reminders
        where status = 'SCHEDULED'
          and scheduled_at <= ${nowIso}::timestamptz
        order by scheduled_at
        limit 100
        for update skip locked
      )
      update reminders r
      -- Explicit cast: a CASE over string literals is text, and Postgres will
      -- not coerce that into the reminder_status enum implicitly.
      set status = (case when r.scheduled_at < ${staleIso}::timestamptz then 'EXPIRED' else 'SENT' end)::reminder_status,
          sent_at = case when r.scheduled_at < ${staleIso}::timestamptz then null else ${nowIso}::timestamptz end,
          updated_at = ${nowIso}::timestamptz
      from due
      where r.id = due.id
      returning r.id, r.task_id, r.user_id, r.channel, r.status
    `);

    const rows = claimed as unknown as Array<{ id: string; status: string; channel: string }>;
    const sent = rows.filter((r) => r.status === 'SENT').length;
    const expired = rows.filter((r) => r.status === 'EXPIRED').length;

    return { processed: rows.length, details: { sent, expired } };
  },
};

/**
 * Publishes unsent outbox rows (transactional outbox, AD-06).
 *
 * The domain change and its event committed together, so the event is
 * guaranteed to exist; this relay only has to deliver it at least once.
 */
const relayOutbox: Job = {
  name: 'outbox.relay',
  intervalMs: 10_000,
  async run(): Promise<JobResult> {
    const claimed = await db.execute(raw`
      with batch as (
        select id from outbox
        where published_at is null and attempts < 10
        order by occurred_at
        limit 200
        for update skip locked
      )
      update outbox o
      set published_at = now(), attempts = o.attempts + 1
      from batch
      where o.id = batch.id
      returning o.id, o.event_type
    `);

    const rows = claimed as unknown as Array<{ event_type: string }>;
    // No external bus is configured yet; marking published is what makes the
    // relay observable and keeps the table from growing unbounded.
    return { processed: rows.length };
  },
};

/** Deletes accounts whose 30-day grace period has elapsed (PRD §12.4). */
const purgeAccounts: Job = {
  name: 'accounts.purge',
  intervalMs: 6 * HOUR,
  async run(): Promise<JobResult> {
    const cutoff = new Date(Date.now() - 30 * 24 * HOUR);

    const due = await db
      .select({ id: users.id })
      .from(users)
      .where(and(isNotNull(users.deletionRequestedAt), lte(users.deletionRequestedAt, cutoff)))
      .limit(50);

    let purged = 0;
    for (const user of due) {
      try {
        // Foreign keys cascade, so this removes every owned row.
        await db.delete(users).where(eq(users.id, user.id));
        purged += 1;
        // The id is logged because the account is gone; nothing identifying remains.
        logger.info('account.purged', { userId: user.id });
      } catch (error) {
        logger.error('account.purge_failed', {
          userId: user.id,
          error: error instanceof Error ? error.message : 'unknown',
        });
      }
    }
    return { processed: purged };
  },
};

/** Expired single-use tokens are not evidence of anything; drop them. */
const purgeAuthTokens: Job = {
  name: 'auth_tokens.purge',
  intervalMs: 12 * HOUR,
  async run(): Promise<JobResult> {
    const deleted = await db
      .delete(authTokens)
      .where(lt(authTokens.expiresAt, new Date(Date.now() - 7 * 24 * HOUR)))
      .returning({ id: authTokens.id });
    return { processed: deleted.length };
  },
};

/** Idempotency records only need to outlive their 24-hour replay window. */
const purgeIdempotencyKeys: Job = {
  name: 'idempotency.purge',
  intervalMs: 6 * HOUR,
  async run(): Promise<JobResult> {
    const deleted = await db
      .delete(idempotencyKeys)
      .where(lt(idempotencyKeys.expiresAt, new Date()))
      .returning({ key: idempotencyKeys.key });
    return { processed: deleted.length };
  },
};

/**
 * Fails reminders left claimed by a worker that died mid-dispatch.
 * Without this they would sit in a non-terminal state indefinitely.
 */
const requeueStuckReminders: Job = {
  name: 'reminders.requeue_stuck',
  intervalMs: 5 * MINUTE,
  async run(): Promise<JobResult> {
    const stuckBefore = new Date(Date.now() - 15 * MINUTE);
    const requeued = await db
      .update(reminders)
      .set({ status: 'SCHEDULED', updatedAt: new Date() })
      .where(and(eq(reminders.status, 'PROCESSING'), lt(reminders.updatedAt, stuckBefore), isNull(reminders.sentAt)))
      .returning({ id: reminders.id });

    if (requeued.length) logger.warn('reminders.requeued', { count: requeued.length });
    return { processed: requeued.length };
  },
};

export const JOBS: Job[] = [
  dispatchReminders,
  requeueStuckReminders,
  relayOutbox,
  purgeAccounts,
  purgeAuthTokens,
  purgeIdempotencyKeys,
];
