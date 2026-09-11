import { deliverMail } from './mail-delivery';
import { and, eq, isNotNull, isNull, lt, lte, sql as raw } from 'drizzle-orm';
import { authTokens, idempotencyKeys, reminders, users, purgeAccount, deliverDueReminders, runRecurrenceGeneration, relayTrackingOutbox, reconcileTracking, runTrackingEvaluation, runTrackingBackfill, createDurableFileExportStore, expireExports, runExportGeneration, createDurableFileAttachmentStore, createClamavScanner, defaultClamavBin, runAttachmentScan, applyBillingDeadlines, reconcileBilling } from '@nextdoo/db';
import { buildBillingProviders } from '@nextdoo/billing';
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
    if (result.failed || result.retrying) logger.warn('reminders.delivery_attention', { failed: result.failed, retrying: result.retrying });
    return { processed: result.sent + result.expired + result.failed + result.canceled + result.retrying, details: result };
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
    const tracking = await relayTrackingOutbox(db);
    // A tracking receipt is NOT delivery by sync/other future consumers.
    const blocked = await db.execute(raw`update outbox set last_error='NO_CONSUMER_REGISTERED'
      where id in (select o.id from outbox o where o.published_at is null and o.last_error is null
       and not exists(select 1 from tracking_outbox_receipts r where r.outbox_id=o.id)
       order by o.occurred_at,o.id limit 100) returning id`);
    if (blocked.length) logger.warn('outbox.consumer_unavailable', { pending: blocked.length });
    if (tracking.deferred) logger.warn('tracking.relay_deferred', tracking);
    return { processed: tracking.received, details: { ...tracking, blocked: blocked.length } };
  },
};

const reconcileTrackingJob: Job = {
  name: 'tracking.reconcile', intervalMs: 10000,
  async run() {
    const result = await reconcileTracking(db);
    if (result.deferred) logger.warn('tracking.reconciliation_deferred', result);
    return { processed: result.queued, details: result };
  },
};
const evaluateTrackingJob: Job = {
  name: 'tracking.evaluate', intervalMs: 10000,
  async run() {
    const result = await runTrackingEvaluation(db);
    for (const failure of result.failures) logger.error(failure.attempts===6 ? 'tracking.evaluate.exhausted' : 'tracking.evaluate.retrying', {
      ...failure, reference: `tracking-${failure.taskId}-${failure.revision}`,
    });
    if (result.deferred) logger.warn('tracking.evaluation_deferred', { count: result.deferred });
    // M4 "unmeasured result rate", worker path (PRD §21.3).
    if (result.processed) logger.info('tracking.result_evaluated', { evaluated: result.processed, unmeasured: result.unmeasured });
    return { processed: result.processed, details: result };
  },
};
/** PRD §7.6 bounded backfill: at most one (workspace, day) chunk per range per run. */
const backfillTrackingJob: Job = {
  name: 'tracking.backfill', intervalMs: 10000,
  async run() {
    const result = await runTrackingBackfill(db);
    if (result.bumps) logger.info('tracking.backfill.progress', result);
    return { processed: result.days, details: result };
  },
};

/** Shared artifact store for generation, expiry and purge cleanup. */
const exportStore = createDurableFileExportStore();
/** Shared attachment file store for scanning and purge cleanup. */
const attachmentStore = createDurableFileAttachmentStore();

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
        // Artifact files are removed alongside the rows (PRD §11.9).
        if (!await purgeAccount(db, user.id, cutoff, { artifactStore: exportStore, attachmentStore })) continue;
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

/**
 * Generates requested exports (PRD §12.4: on demand, 2 retries, notify user
 * with retry link on exhaustion). Durable state and fencing live in
 * PostgreSQL; artifacts land in the shared export storage.
 */
const generateExports: Job = {
  name: 'export.generate',
  intervalMs: 10_000,
  async run(): Promise<JobResult> {
    const result = await runExportGeneration(db, { store: exportStore });
    for (const failure of result.failures) {
      logger.error('export.generate.exhausted', {
        exportId: failure.exportId,
        attempts: failure.attempts,
        error: failure.error,
        reference: `export-${failure.exportId}`,
      });
    }
    if (result.retrying) logger.warn('export.generate.retrying', { retrying: result.retrying });
    if (result.deferred) logger.warn('export.generate.deferred', { deferred: result.deferred });
    return { processed: result.processed, details: { ...result, failures: result.failures } };
  },
};

/** Removes artifacts past their 24-hour window and marks rows EXPIRED (PRD §13.5). */
const expireExportArtifacts: Job = {
  name: 'exports.expire',
  intervalMs: 60_000,
  async run(): Promise<JobResult> {
    const result = await expireExports(db, { store: exportStore });
    if (result.expired) logger.info('exports.expired', result);
    return { processed: result.expired };
  },
};

/**
 * Scans uploaded attachments with the real ClamAV engine (PRD §6.8, §14:
 * attachment.scan, on upload, 3 attempts, quarantine on exhaustion). Fail
 * closed: an unavailable engine consumes retries and ends in FAILED — a file
 * never reaches CLEAN without a successful scan, so nothing unsafe is served.
 */
const scanAttachments: Job = {
  name: 'attachment.scan',
  intervalMs: 10_000,
  async run(): Promise<JobResult> {
    const result = await runAttachmentScan(db, {
      store: attachmentStore,
      scanner: createClamavScanner(defaultClamavBin()),
    });
    for (const failure of result.failures) {
      logger.error('attachment.scan.quarantined', {
        attachmentId: failure.attachmentId,
        attempts: failure.attempts,
        error: failure.error,
        reference: `attachment-${failure.attachmentId}`,
      });
    }
    if (result.retrying) logger.warn('attachment.scan.retrying', { retrying: result.retrying });
    if (result.deferred) logger.warn('attachment.scan.deferred', { deferred: result.deferred });
    return { processed: result.processed, details: { ...result } };
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
      .set({ status: raw`case when ${reminders.attempts} >= 3 then 'FAILED'::reminder_status else 'SCHEDULED'::reminder_status end`, lastError: 'STALE_DELIVERY_CLAIM', updatedAt: new Date(), nextAttemptAt: new Date(), version: raw`${reminders.version} + 1` })
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

/**
 * Applies time-driven subscription transitions that are clocks, not webhooks
 * (PRD §18.2): trial end, dunning exhaustion after the 7-day grace window,
 * paid-period end after cancellation, and next-period swap of a pending
 * downgrade. Idempotent and version-fenced; entitlements follow immediately
 * because readEffectivePlan() reads the same row.
 */
const sweepBillingDeadlines: Job = {
  name: 'billing.sweep',
  intervalMs: 5 * MINUTE,
  async run(): Promise<JobResult> {
    const result = await applyBillingDeadlines(db);
    if (result.expired || result.downgradesApplied) logger.info('billing.deadlines_swept', { ...result });
    return { processed: result.expired + result.downgradesApplied, details: { ...result } };
  },
};

// Provider instances are built once at boot from the worker environment.
const billingProviders = buildBillingProviders(process.env);

/**
 * PRD §18.3: "A nightly reconciliation job compares provider subscription
 * state against local entitlements and alerts on drift." Unconfigured
 * providers are simply skipped (checked: 0) — the job degrades to the
 * deadline sweep, it never fakes a comparison.
 */
const reconcileBillingJob: Job = {
  name: 'billing.reconcile',
  intervalMs: 24 * HOUR,
  async run(): Promise<JobResult> {
    let checked = 0;
    let drifted = 0;
    let unreachable = 0;
    for (const provider of Object.values(billingProviders)) {
      if (!provider || !provider.isConfigured()) continue;
      const result = await reconcileBilling(db, provider);
      checked += result.checked;
      drifted += result.drifted.length;
      unreachable += result.unreachable;
      for (const report of result.drifted) {
        logger.error('billing.reconciliation_drift', { provider: provider.id, subscription: report.providerSubscriptionId, diffs: report.diffs });
      }
      if (result.unreachable) logger.warn('billing.reconciliation_unreachable', { provider: provider.id, unreachable: result.unreachable });
    }
    return { processed: checked, details: { checked, drifted, unreachable } };
  },
};

export const JOBS: Job[] = [
  { name: 'recurrence.generate', intervalMs: 60000, run: async () => { const result = await runRecurrenceGeneration(db); if (result.details.failed) logger.warn('recurrence.generation_failed', result.details); return result; } },
  purgeAuthenticationAttempts,
  { name: 'mail.deliver', intervalMs: 10000, run: () => deliverMail(1) },
  dispatchReminders,
  requeueStuckReminders,
  relayOutbox,
  reconcileTrackingJob,
  evaluateTrackingJob,
  backfillTrackingJob,
  generateExports,
  expireExportArtifacts,
  scanAttachments,
  sweepBillingDeadlines,
  reconcileBillingJob,
  purgeAccounts,
  purgeAuthTokens,
  purgeIdempotencyKeys,
];
