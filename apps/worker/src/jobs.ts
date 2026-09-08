import { deliverMail } from './mail-delivery';
import { and, eq, isNotNull, isNull, lt, lte, sql as raw } from 'drizzle-orm';
import { authTokens, idempotencyKeys, reminders, users, purgeAccount, deliverDueReminders } from '@nextdoo/db';
import { db, logger, type Job, type JobResult } from './runtime';

/**
 * Background jobs (PRD §15).
 *
 * Durable work lives in PostgreSQL, not in setInterval memory. WEB notification
 * writes commit with acknowledgements; SMTP uses row leases and bounded retries.
 * Unhandled outbox events remain pending, not falsely published.
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
    const result = await deliverDueReminders(db);
    return { processed: result.sent + result.expired + result.failed + result.canceled, details: result };
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
    // No consumers are registered: preserving the event is mandatory. A pending
    // backlog is actionable; fabricated published_at timestamps destroy evidence.
    const blocked = await db.execute(raw`update outbox set last_error='NO_CONSUMER_REGISTERED'
      where published_at is null and last_error is null returning id`);
    if (blocked.length) logger.warn('outbox.consumer_unavailable', { pending: blocked.length });
    return { processed: 0, details: { blocked: blocked.length } };
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
        if (!await purgeAccount(db, user.id, cutoff)) continue;
        purged += 1;
        // Retain only the opaque identifier here; audit evidence follows its own retention.
        logger.info('account.purged', { userId: user.id });
      } catch (error) {
        logger.error('account.purge_failed', {
          userId: user.id,
          errorType: error instanceof Error ? error.name : 'unknown',
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

const purgeAuthenticationAttempts: Job = {
  name: 'authentication_attempts.purge', intervalMs: 5 * MINUTE,
  async run() {
    const rows = await db.execute(raw`delete from authentication_attempts where key in (
      select key from authentication_attempts where expires_at <= now() order by expires_at limit 1000 for update skip locked
    ) returning key`);
    return { processed: rows.length };
  },
};

export const JOBS: Job[] = [
  purgeAuthenticationAttempts,
  { name: 'mail.deliver', intervalMs: 10000, run: () => deliverMail(1) },
  dispatchReminders,
  requeueStuckReminders,
  relayOutbox,
  purgeAccounts,
  purgeAuthTokens,
  purgeIdempotencyKeys,
];
