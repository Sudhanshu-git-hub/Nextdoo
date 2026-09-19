import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from './client';
import { attachments, auditLogs } from './schema';
import type { AttachmentObjectStore } from './attachment-storage';
import type { AttachmentScanner } from './attachment-scanner';

/**
 * Durable asynchronous attachment scanning (PRD §6.8: upload → complete →
 * async scan → `scan_status` becomes CLEAN/INFECTED; downloads blocked until
 * CLEAN; §14: `attachment.scan`, on upload, 3 attempts, quarantine file on
 * exhaustion).
 *
 * Attempt/lease semantics mirror the export jobs: an attempt is committed
 * before work, a claim token fences a delayed worker, and the initial attempt
 * plus two retries is the budget. Quarantine means: an INFECTED or
 * exhausted-FAILED file is retained in the store for forensics but is never
 * served — the download gate checks scan status, not file presence.
 *
 * Fail-closed: the scanner must return a definitive verdict; any engine
 * failure consumes a retry and eventually quarantines as FAILED. A file is
 * never CLEAN without a successful engine scan.
 */

/** Initial attempt plus two retries, with 1/2-minute backoff. */
const BACKOFF_MINUTES = [1, 2];
const clock = sql`clock_timestamp()`;

export interface AttachmentScanFailure {
  attachmentId: string;
  workspaceId: string;
  attempts: number;
  error: string;
}

export interface AttachmentScanResult {
  processed: number;
  clean: number;
  infected: number;
  failed: number;
  retrying: number;
  deferred: number;
  failures: AttachmentScanFailure[];
}

interface ClaimedRow {
  id: string;
  workspaceId: string;
  uploaderId: string;
  objectKey: string;
  sizeBytes: number;
  attempts: number;
  claimToken: string;
}

async function insertScanAudit(
  db: Database,
  row: { workspaceId: string; actorId: string; action: string; targetId: string; metadata: Record<string, unknown> },
): Promise<void> {
  await db.insert(auditLogs).values({
    id: randomUUID(),
    workspaceId: row.workspaceId,
    actorId: row.actorId,
    action: row.action,
    targetType: 'attachment',
    targetId: row.targetId,
    metadata: row.metadata,
  });
}

/**
 * Recovers attachments left claimed by a worker that died mid-scan. The
 * consumed attempt keeps its budget; an exhausted budget is terminal (FAILED,
 * quarantined) and recorded as audit evidence.
 */
export async function recoverStaleAttachmentClaims(db: Database): Promise<{ recovered: number; failed: number }> {
  const expired = await db.execute(sql`update attachments
    set scan_status = case when attempts >= 3 then 'FAILED'::scan_status else 'PENDING'::scan_status end,
        scan_error = case when attempts >= 3 then 'STALE_SCAN_CLAIM' else scan_error end,
        claim_token = null, lease_expires_at = null,
        next_attempt_at = clock_timestamp(), updated_at = clock_timestamp()
    where claim_token is not null and lease_expires_at <= clock_timestamp() and deleted_at is null
    returning id, workspace_id, uploader_id, attempts`);
  let failed = 0;
  for (const row of expired as unknown as { id: string; workspace_id: string; uploader_id: string; attempts: number }[]) {
    if (row.attempts >= 3) {
      failed += 1;
      await insertScanAudit(db, {
        workspaceId: row.workspace_id, actorId: row.uploader_id,
        action: 'attachment.scan_failed', targetId: row.id,
        metadata: { reason: 'stale-claim-exhausted' },
      });
    }
  }
  return { recovered: expired.length, failed };
}

/**
 * One bounded scan pass (worker job attachment.scan): reclaim stale leases,
 * then claim and scan at most `limit` attachments. Crashes between the claim
 * commit and the verdict commit are harmless: the object key is stable per
 * attachment, so a retry re-scans the same artifact exactly.
 */
export async function runAttachmentScan(
  db: Database,
  opts: { store: AttachmentObjectStore; scanner: AttachmentScanner; limit?: number },
): Promise<AttachmentScanResult> {
  const limit = opts.limit ?? 5;
  const recovered = await recoverStaleAttachmentClaims(db);
  const result: AttachmentScanResult = {
    processed: 0, clean: 0, infected: 0, failed: recovered.failed, retrying: 0, deferred: 0, failures: [],
  };

  const started = Date.now();
  const candidates = await db.transaction(async (tx) => {
    await tx.execute(sql`set local statement_timeout='8s'`);
    const rows = await tx.execute(sql`select c.id, c.workspace_id, c.uploader_id from (
      select a.id, a.workspace_id, a.uploader_id,
             row_number() over (partition by a.workspace_id order by a.next_attempt_at, a.created_at, a.id) as turn
      from attachments a
      join workspaces w on w.id = a.workspace_id
      where a.scan_status = 'PENDING' and a.uploaded_at is not null and a.claim_token is null
        and a.attempts < 3 and a.next_attempt_at <= clock_timestamp()
        and a.deleted_at is null and w.deleted_at is null
    ) c order by c.turn, c.id, c.workspace_id limit ${limit}`) as unknown as { id: string; workspace_id: string; uploader_id: string }[];
    return rows;
  });

  for (const candidate of candidates) {
    if (Date.now() - started > 20_000) { result.deferred += 1; continue; }
    try {
      const claimed = await db.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout='500ms'`);
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'attachment:' + candidate.workspace_id}, 0))`);
        const rows = await tx
          .update(attachments)
          .set({
            claimToken: randomUUID(),
            leaseExpiresAt: sql`clock_timestamp() + interval '2 minutes'`,
            attempts: sql`${attachments.attempts} + 1`,
            updatedAt: clock,
          })
          .where(and(
            eq(attachments.id, candidate.id),
            eq(attachments.workspaceId, candidate.workspace_id),
            eq(attachments.scanStatus, 'PENDING'),
            isNull(attachments.claimToken),
            isNull(attachments.deletedAt),
            sql`${attachments.attempts} < 3`,
            sql`${attachments.nextAttemptAt} <= clock_timestamp()`,
          ))
          .returning();
        return rows[0] as unknown as ClaimedRow | undefined;
      });
      if (!claimed) continue;

      try {
        const data = await opts.store.read(claimed.objectKey);
        if (data === null) throw new Error('ATTACHMENT_DATA_MISSING');
        // The stored bytes must match the declared size: never scan or serve
        // a file the account did not declare.
        if (data.byteLength !== claimed.sizeBytes) throw new Error('ATTACHMENT_SIZE_MISMATCH');

        const dir = await mkdtemp(join(tmpdir(), 'nextdoo-attach-scan-'));
        const tempPath = join(dir, 'scan-target');
        await writeFile(tempPath, data, { mode: 0o600 });
        let verdict: { infected: boolean; virusName?: string };
        try {
          verdict = await opts.scanner.scan(tempPath);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }

        const applied = await db.transaction(async (tx) => {
          const rows = await tx
            .update(attachments)
            .set({
              scanStatus: verdict.infected ? 'INFECTED' : 'CLEAN',
              completedAt: clock,
              claimToken: null,
              leaseExpiresAt: null,
              updatedAt: clock,
            })
            .where(and(eq(attachments.id, claimed.id), eq(attachments.claimToken, claimed.claimToken)))
            .returning();
          return rows.length > 0;
        });
        if (!applied) continue; // a concurrent delete/reclaim won the race
        result.processed += 1;
        if (verdict.infected) {
          result.infected += 1;
          await insertScanAudit(db, {
            workspaceId: claimed.workspaceId, actorId: claimed.uploaderId,
            action: 'attachment.infected', targetId: claimed.id,
            metadata: { virusName: verdict.virusName ?? 'unknown' },
          });
        } else {
          result.clean += 1;
        }
      } catch (error) {
        const attempt = claimed.attempts;
        const exhausted = attempt >= 3;
        const code = (error instanceof Error ? error.message : 'ATTACHMENT_SCAN_ERROR').slice(0, 280);
        const backoffMinutes = BACKOFF_MINUTES[Math.min(attempt - 1, BACKOFF_MINUTES.length - 1)] ?? 1;
        await db.transaction(async (tx) => {
          await tx.update(attachments).set({
            scanStatus: exhausted ? 'FAILED' : 'PENDING',
            scanError: exhausted ? code : null,
            completedAt: exhausted ? clock : null,
            claimToken: null,
            leaseExpiresAt: null,
            nextAttemptAt: exhausted
              ? clock
              : sql`clock_timestamp() + ${backoffMinutes * 60_000} * interval '1 millisecond'`,
            updatedAt: clock,
          }).where(and(eq(attachments.id, claimed.id), eq(attachments.claimToken, claimed.claimToken)));
        });
        if (exhausted) {
          result.failed += 1;
          result.failures.push({ attachmentId: claimed.id, workspaceId: claimed.workspaceId, attempts: attempt, error: code });
          await insertScanAudit(db, {
            workspaceId: claimed.workspaceId, actorId: claimed.uploaderId,
            action: 'attachment.scan_failed', targetId: claimed.id,
            metadata: { reason: code },
          });
        } else {
          result.retrying += 1;
        }
      }
    } catch { result.deferred += 1; }
  }

  return result;
}
