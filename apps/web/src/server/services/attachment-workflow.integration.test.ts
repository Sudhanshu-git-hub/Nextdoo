import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { AppError, limitsFor } from '@nextdoo/contracts';
import {
  attachments,
  auditLogs,
  createDurableFileAttachmentStore,
  purgeAccount,
  runAttachmentScan,
  users,
  type AttachmentScanner,
} from '@nextdoo/db';
import { requireTestDatabase } from '../../../../../tests/database';
import { getDb } from '../db';
import type { AuthContext } from '../auth';
import { registerUser } from './accounts';
import { createTask } from './tasks';
import {
  authorizeAttachmentUpload,
  completeAttachment,
  deleteAttachment,
  listAttachments,
  requestAttachmentDownload,
  signAttachmentToken,
  streamAttachmentDownload,
  writeAttachmentData,
} from './attachments';

await requireTestDatabase();

// Isolated object store for the whole suite: the services resolve the storage
// root from $ATTACHMENT_STORAGE_DIR at call time, so pin it before the first
// service call. Workflow semantics are exercised with a deterministic scanner;
// the real ClamAV engine is proven in the CI E2E suite (fail closed locally).
const storeRoot = mkdtempSync(join(tmpdir(), 'nextdoo-attachment-test-'));
process.env.ATTACHMENT_STORAGE_DIR = storeRoot;
const store = createDurableFileAttachmentStore(storeRoot);

beforeAll(async () => {
  await getDb().delete(attachments);
  await getDb().delete(auditLogs).where(sql`action in ('attachment.completed', 'attachment.downloaded', 'attachment.deleted', 'attachment.infected', 'attachment.scan_failed')`);
});

afterAll(async () => {
  await rmSync(storeRoot, { recursive: true, force: true });
});

/** Deterministic scanner: the verdict is steerable per test. */
function fakeScanner(): AttachmentScanner & { setVerdict(v: { infected: boolean; virusName?: string } | Error): void } {
  let verdict: { infected: boolean; virusName?: string } | Error = { infected: false };
  return {
    setVerdict(v) { verdict = v; },
    async scan() {
      if (verdict instanceof Error) throw verdict;
      return { infected: verdict.infected, virusName: verdict.infected ? 'Test-Signature' : undefined, engine: 'clamav' };
    },
  };
}

async function fixture() {
  const user = await registerUser({ email: `attachment-${randomUUID()}@test.local`, passwordHash: 'test', name: null, timeZone: 'UTC' });
  const actor: AuthContext = {
    userId: user.id,
    workspaceId: user.workspaceId,
    sessionId: `integration-${user.id}`,
    email: user.email,
    emailVerified: true,
    timeZone: 'UTC',
  };
  const task = await createTask(actor, { workspaceId: actor.workspaceId, title: 'Attachment task', priority: 'NONE', tagIds: [] });
  return { user, actor, taskId: task.id };
}

async function upload(actor: AuthContext, taskId: string, bytes: number, fileName = 'file.pdf', contentType = 'application/pdf') {
  const auth = await authorizeAttachmentUpload(actor, { taskId, fileName, contentType, sizeBytes: bytes });
  const body = new Uint8Array(bytes);
  body.fill(bytes % 251, 0, bytes); // deterministic content
  await writeAttachmentData(actor, auth.attachment.id, extractToken(auth.uploadUrl), new Response(body).body!);
  await completeAttachment(actor, auth.attachment.id);
  return auth.attachment.id;
}

function extractToken(url: string): string {
  return new URL(url, 'http://localhost').searchParams.get('token')!;
}

async function runDue(id: string) {
  await getDb().execute(sql`update attachments set next_attempt_at = clock_timestamp() - interval '1 second' where id=${id}`);
}

async function rowOf(id: string) {
  const [row] = await getDb().select().from(attachments).where(eq(attachments.id, id)).limit(1);
  return row;
}

async function expectAppError(fn: () => Promise<unknown>, code: string, detailPart?: string) {
  try {
    await fn();
  } catch (error) {
    expect(error, 'expected AppError').toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    if (detailPart) expect((error as AppError).message).toContain(detailPart);
    return;
  }
  throw new Error(`expected AppError ${code} but none was thrown`);
}

const freeLimits = limitsFor('FREE');

// ---------------------------------------------------------------------------
// Upload success + metadata lifecycle
// ---------------------------------------------------------------------------

it('uploads a file end to end: authorize → PUT → complete → CLEAN → download', async () => {
  const { actor, taskId } = await fixture();
  const scanner = fakeScanner();

  const id = await upload(actor, taskId, 1234);
  const before = await rowOf(id);
  expect(before!.scanStatus).toBe('PENDING');
  expect(before!.uploadedAt).not.toBeNull();
  expect(before!.objectKey.startsWith(`attach-${actor.workspaceId}/`)).toBe(true);
  expect(existsSync(join(storeRoot, before!.objectKey))).toBe(true);

  const result = await runAttachmentScan(getDb(), { store, scanner });
  expect(result.processed).toBeGreaterThanOrEqual(1);
  expect(result.clean).toBeGreaterThanOrEqual(1);
  expect(result.infected).toBe(0);

  const clean = await rowOf(id);
  expect(clean!.scanStatus).toBe('CLEAN');
  expect(clean!.completedAt).not.toBeNull();

  const listed = await listAttachments(actor, taskId);
  expect(listed).toHaveLength(1);
  expect(listed[0]!.fileName).toBe('file.pdf');
  expect(listed[0]!.sizeBytes).toBe(1234);
  expect(listed[0]!.downloadUrl).toContain('/download/file?token=');

  const dl = await requestAttachmentDownload(actor, id);
  expect(dl.expiresIn).toBeLessThanOrEqual(900); // PRD §11.4: ≤ 15 minutes
  const { data, fileName, contentType } = await streamAttachmentDownload(actor, id, extractToken(dl.downloadUrl));
  expect(data.byteLength).toBe(1234);
  expect(fileName).toBe('file.pdf');
  expect(contentType).toBe('application/pdf');

  // Audit trail: completed + downloaded.
  const [audit] = await getDb().select({ n: sql<number>`count(*)::int` })
    .from(auditLogs)
    .where(and(eq(auditLogs.action, 'attachment.completed'), eq(auditLogs.targetId, id)))
    .limit(1);
  expect(audit!.n).toBe(1);
  const [dlAudit] = await getDb().select({ n: sql<number>`count(*)::int` })
    .from(auditLogs)
    .where(and(eq(auditLogs.action, 'attachment.downloaded'), eq(auditLogs.targetId, id)))
    .limit(1);
  expect(dlAudit!.n).toBe(1);
});

// ---------------------------------------------------------------------------
// Maximum file size + allowlist
// ---------------------------------------------------------------------------

it('rejects a file above the plan maximum before anything is stored', async () => {
  const { actor, taskId } = await fixture();
  await expectAppError(
    () => authorizeAttachmentUpload(actor, { taskId, fileName: 'big.pdf', contentType: 'application/pdf', sizeBytes: freeLimits.maxFileBytes + 1 }),
    'ENTITLEMENT_LIMIT_REACHED',
  );
  const [countRows] = await getDb().select({ n: sql<number>`count(*)::int` })
    .from(attachments).where(eq(attachments.workspaceId, actor.workspaceId));
  expect(countRows!.n).toBe(0);
});

it('rejects a content type outside the allowlist', async () => {
  const { actor, taskId } = await fixture();
  await expectAppError(
    () => authorizeAttachmentUpload(actor, { taskId, fileName: 'shell.sh', contentType: 'application/x-sh', sizeBytes: 10 }),
    'VALIDATION_FAILED',
    'not supported',
  );
});

// ---------------------------------------------------------------------------
// Exact declared size on the data PUT
// ---------------------------------------------------------------------------

it('enforces the exact declared size on upload data (over and under)', async () => {
  const { actor, taskId } = await fixture();
  const auth = await authorizeAttachmentUpload(actor, { taskId, fileName: 'sized.txt', contentType: 'text/plain', sizeBytes: 100 });
  const token = extractToken(auth.uploadUrl);

  await expectAppError(
    () => writeAttachmentData(actor, auth.attachment.id, token, new Response(new Uint8Array(101)).body!),
    'VALIDATION_FAILED',
    'exceeded',
  );
  await expectAppError(
    () => writeAttachmentData(actor, auth.attachment.id, token, new Response(new Uint8Array(99)).body!),
    'VALIDATION_FAILED',
    'does not match',
  );
  // The exact size succeeds and completes.
  await writeAttachmentData(actor, auth.attachment.id, token, new Response(new Uint8Array(100)).body!);
  const view = await completeAttachment(actor, auth.attachment.id);
  expect(view.scanStatus).toBe('PENDING');
  expect(view.uploadedAt).not.toBeNull();

  // Resolve the scan so later tests start from a clean candidate set.
  const result = await runAttachmentScan(getDb(), { store, scanner: fakeScanner() });
  expect(result.processed).toBe(1);
  expect((await rowOf(auth.attachment.id))!.scanStatus).toBe('CLEAN');
});

// ---------------------------------------------------------------------------
// Plan storage quota boundaries
// ---------------------------------------------------------------------------

it('enforces the plan storage quota at the exact boundary', async () => {
  const { actor, taskId } = await fixture();
  const cap = freeLimits.attachmentStorageBytes; // 100 MB on FREE
  const maxFile = freeLimits.maxFileBytes; // 10 MB on FREE
  expect(cap % maxFile).toBe(0); // the cap is reachable in whole max-size files

  const files: string[] = [];
  const full = cap - maxFile;
  for (let offset = 0; offset < full; offset += maxFile) {
    files.push(await upload(actor, taskId, maxFile, `part-${offset}.pdf`));
  }

  // The last max-size file brings the workspace to precisely the plan cap.
  const last = await authorizeAttachmentUpload(actor, { taskId, fileName: 'cap.pdf', contentType: 'application/pdf', sizeBytes: maxFile });
  await writeAttachmentData(actor, last.attachment.id, extractToken(last.uploadUrl), new Response(new Uint8Array(maxFile)).body!);
  await completeAttachment(actor, last.attachment.id);
  files.push(last.attachment.id);

  const usage = await getDb().select({ bytes: sql<number>`coalesce(sum(${attachments.sizeBytes}), 0)` })
    .from(attachments)
    .where(and(eq(attachments.workspaceId, actor.workspaceId), isNull(attachments.deletedAt)));
  expect(Number(usage[0]!.bytes)).toBe(cap);

  // At the cap, one more byte is rejected (within the per-file maximum, so this
  // is the storage-quota gate, not the file-size gate)…
  await expectAppError(
    () => authorizeAttachmentUpload(actor, { taskId, fileName: 'over.pdf', contentType: 'application/pdf', sizeBytes: 1 }),
    'ENTITLEMENT_LIMIT_REACHED',
    'attachment storage',
  );
  // …and a rejected authorization consumes no quota (usage is still exactly the
  // cap, and deleting everything releases it fully).
  for (const id of files) await deleteAttachment(actor, id);
  const after = await getDb().select({ bytes: sql<number>`coalesce(sum(${attachments.sizeBytes}), 0)` })
    .from(attachments)
    .where(and(eq(attachments.workspaceId, actor.workspaceId), isNull(attachments.deletedAt)));
  expect(Number(after[0]!.bytes)).toBe(0);
});

// ---------------------------------------------------------------------------
// Scan rejection (quarantine)
// ---------------------------------------------------------------------------

it('quarantines an infected file: blocked download, object retained, verdict recorded', async () => {
  const { actor, taskId } = await fixture();
  const scanner = fakeScanner();
  scanner.setVerdict({ infected: true });

  const id = await upload(actor, taskId, 512, 'infected.pdf');
  const result = await runAttachmentScan(getDb(), { store, scanner });
  expect(result.infected).toBe(1);
  expect(result.failures).toEqual([]);

  const row = await rowOf(id);
  expect(row!.scanStatus).toBe('INFECTED');
  expect(row!.completedAt).not.toBeNull();
  expect(existsSync(join(storeRoot, row!.objectKey))).toBe(true); // quarantined, not destroyed

  await expectAppError(() => requestAttachmentDownload(actor, id), 'ATTACHMENT_NOT_CLEAN', 'unsafe');
  const token = signAttachmentToken('download', id, actor.userId);
  await expectAppError(() => streamAttachmentDownload(actor, id, token), 'ATTACHMENT_NOT_CLEAN');

  const listed = await listAttachments(actor, taskId);
  expect(listed[0]!.scanStatus).toBe('INFECTED');
  expect(listed[0]!.downloadUrl).toBeNull();

  const [audit] = await getDb().select({ n: sql<number>`count(*)::int` })
    .from(auditLogs).where(and(eq(auditLogs.action, 'attachment.infected'), eq(auditLogs.targetId, id))).limit(1);
  expect(audit!.n).toBe(1);
});

// ---------------------------------------------------------------------------
// Scan failure and retry behavior (3 attempts, then FAILED)
// ---------------------------------------------------------------------------

it('retries a failing scan with backoff and quarantines as FAILED after the third attempt', async () => {
  const { actor, taskId } = await fixture();
  const scanner = fakeScanner();
  scanner.setVerdict(new Error('ATTACHMENT_SCAN_FAILED:24'));

  const id = await upload(actor, taskId, 256, 'flaky.pdf');

  const r1 = await runAttachmentScan(getDb(), { store, scanner });
  expect(r1.retrying).toBe(1);
  let row = await rowOf(id);
  expect(row!.scanStatus).toBe('PENDING');
  expect(row!.attempts).toBe(1);
  expect(row!.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now() - 5_000); // backed off
  // A backed-off claim must not be scanned again before its window elapses.
  const r1b = await runAttachmentScan(getDb(), { store, scanner });
  expect(r1b.retrying).toBe(0);
  expect(r1b.processed).toBe(0);

  await runDue(id);
  const r2 = await runAttachmentScan(getDb(), { store, scanner });
  expect(r2.retrying).toBe(1);
  row = await rowOf(id);
  expect(row!.attempts).toBe(2);

  await runDue(id);
  scanner.setVerdict({ infected: false }); // engine recovers within the attempt budget
  const r3 = await runAttachmentScan(getDb(), { store, scanner });
  expect(r3.clean).toBe(1);
  row = await rowOf(id);
  expect(row!.scanStatus).toBe('CLEAN');
  expect(row!.attempts).toBe(3);

  // Exhaustion path: a different file whose engine never recovers.
  scanner.setVerdict(new Error('ATTACHMENT_SCAN_FAILED:24'));
  const id2 = await upload(actor, taskId, 128, 'dead.pdf');
  await runAttachmentScan(getDb(), { store, scanner }); // attempt 1
  await runDue(id2);
  await runAttachmentScan(getDb(), { store, scanner }); // attempt 2
  await runDue(id2);
  const r5 = await runAttachmentScan(getDb(), { store, scanner }); // attempt 3
  expect(r5.failed).toBe(1);
  expect(r5.failures[0]).toMatchObject({ attachmentId: id2, attempts: 3, error: 'ATTACHMENT_SCAN_FAILED:24' });
  const row2 = await rowOf(id2);
  expect(row2!.scanStatus).toBe('FAILED');
  expect(row2!.scanError).toContain('ATTACHMENT_SCAN_FAILED');

  await expectAppError(() => requestAttachmentDownload(actor, id2), 'ATTACHMENT_NOT_CLEAN', 'failed');
  // A FAILED file still counts against quota and can be deleted (cleanup path).
  await deleteAttachment(actor, id2);
  const gone = await rowOf(id2);
  expect(gone!.deletedAt).not.toBeNull();
});

// ---------------------------------------------------------------------------
// Download authorization: tokens are purpose- and user-bound
// ---------------------------------------------------------------------------

it('refuses download tokens that are missing, tampered, or for the wrong purpose/user', async () => {
  const { actor, taskId } = await fixture();
  const scanner = fakeScanner();
  const id = await upload(actor, taskId, 77, 'tokens.pdf');
  await runAttachmentScan(getDb(), { store, scanner });

  await expectAppError(() => streamAttachmentDownload(actor, id, null), 'FORBIDDEN');
  await expectAppError(() => streamAttachmentDownload(actor, id, 'not-a-token'), 'FORBIDDEN');

  const good = signAttachmentToken('download', id, actor.userId);
  const tampered = `${good.slice(0, -2)}${good.endsWith('AA') ? 'BB' : 'AA'}`;
  await expectAppError(() => streamAttachmentDownload(actor, id, tampered), 'FORBIDDEN');

  const uploadToken = signAttachmentToken('upload', id, actor.userId, 77);
  await expectAppError(() => streamAttachmentDownload(actor, id, uploadToken), 'FORBIDDEN');

  // A token signed for a different user does not work.
  const stranger = await registerUser({ email: `attachment-stranger-${randomUUID()}@test.local`, passwordHash: 'test', name: null, timeZone: 'UTC' });
  const foreignToken = signAttachmentToken('download', id, stranger.id);
  await expectAppError(() => streamAttachmentDownload(actor, id, foreignToken), 'FORBIDDEN');
});

// ---------------------------------------------------------------------------
// Deletion and cleanup
// ---------------------------------------------------------------------------

it('deletes an attachment: row soft-deleted, object removed, quota released, hidden from listing', async () => {
  const { actor, taskId } = await fixture();
  const scanner = fakeScanner();
  const id = await upload(actor, taskId, 321, 'gone.pdf');
  await runAttachmentScan(getDb(), { store, scanner });
  const row = await rowOf(id);
  expect(existsSync(join(storeRoot, row!.objectKey))).toBe(true);

  await deleteAttachment(actor, id);
  const after = await rowOf(id);
  expect(after!.deletedAt).not.toBeNull();
  expect(existsSync(join(storeRoot, after!.objectKey))).toBe(false);
  expect(await listAttachments(actor, taskId)).toEqual([]);
  await expectAppError(() => deleteAttachment(actor, id), 'NOT_FOUND');
  await expectAppError(() => requestAttachmentDownload(actor, id), 'NOT_FOUND');
});

// ---------------------------------------------------------------------------
// Idempotent / lost-ack behavior
// ---------------------------------------------------------------------------

it('tolerates lost acknowledgements: re-PUT and re-complete are safe', async () => {
  const { actor, taskId } = await fixture();
  const auth = await authorizeAttachmentUpload(actor, { taskId, fileName: 'lost-ack.pdf', contentType: 'application/pdf', sizeBytes: 64 });
  const token = extractToken(auth.uploadUrl);
  const body = () => new Response(new Uint8Array(64)).body!;

  await writeAttachmentData(actor, auth.attachment.id, token, body());
  await completeAttachment(actor, auth.attachment.id);
  // Lost-ack replay of the PUT after completion: clearly reported, not a crash
  // or a silent data change behind a scanned file.
  await expectAppError(
    () => writeAttachmentData(actor, auth.attachment.id, token, body()),
    'VALIDATION_FAILED',
    'already has file data',
  );
  const first = await completeAttachment(actor, auth.attachment.id);
  const second = await completeAttachment(actor, auth.attachment.id); // lost-ack replay
  expect(second.id).toBe(first.id);
  expect(second.uploadedAt).toBe(first.uploadedAt);

  // Resolve the scan so later tests start from a clean candidate set.
  const result = await runAttachmentScan(getDb(), { store, scanner: fakeScanner() });
  expect(result.processed).toBe(1);
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------

it('is isolated between tenants: foreign tasks, rows, tokens and purge scopes', async () => {
  const a = await fixture();
  const b = await fixture();

  // B cannot use A's task for uploads or listings.
  await expectAppError(
    () => authorizeAttachmentUpload(b.actor, { taskId: a.taskId, fileName: 'x.pdf', contentType: 'application/pdf', sizeBytes: 10 }),
    'NOT_FOUND',
  );
  await expectAppError(() => listAttachments(b.actor, a.taskId), 'NOT_FOUND');

  const scanner = fakeScanner();
  const aId = await upload(a.actor, a.taskId, 99, 'a.pdf');
  const bId = await upload(b.actor, b.taskId, 55, 'b.pdf');
  await runAttachmentScan(getDb(), { store, scanner });
  const aRow = await rowOf(aId);
  const bRow = await rowOf(bId);

  // B cannot touch A's attachment row at all.
  await expectAppError(() => requestAttachmentDownload(b.actor, aId), 'NOT_FOUND');
  await expectAppError(() => deleteAttachment(b.actor, aId), 'NOT_FOUND');
  const foreignToken = signAttachmentToken('upload', aId, b.actor.userId, 99);
  await expectAppError(() => writeAttachmentData(b.actor, aId, foreignToken, new Response(new Uint8Array(99)).body!), 'NOT_FOUND');
  // A valid token signed for A does not work under B's session.
  await expectAppError(() => streamAttachmentDownload(b.actor, aId, signAttachmentToken('download', aId, a.actor.userId)), 'NOT_FOUND');

  // Objects live under per-workspace prefixes.
  expect(aRow!.objectKey.startsWith(`attach-${a.actor.workspaceId}/`)).toBe(true);
  expect(bRow!.objectKey.startsWith(`attach-${b.actor.workspaceId}/`)).toBe(true);

  // Purge B: only B's rows and files disappear.
  await getDb().update(users).set({ deletionRequestedAt: new Date() }).where(eq(users.id, b.user.id));
  const purged = await purgeAccount(getDb(), b.user.id, new Date(Date.now() + 60_000), { attachmentStore: store });
  expect(purged).toBe(true);
  expect(existsSync(join(storeRoot, aRow!.objectKey))).toBe(true); // A's data untouched
  expect(existsSync(join(storeRoot, bRow!.objectKey))).toBe(false); // B's file purged
  const [bRows] = await getDb().select({ n: sql<number>`count(*)::int` }).from(attachments).where(eq(attachments.workspaceId, b.actor.workspaceId));
  expect(bRows!.n).toBe(0);
});

// ---------------------------------------------------------------------------
// Data-rights export includes attachment metadata (never bytes)
// ---------------------------------------------------------------------------

it('includes attachment metadata in the data-rights export bundle', async () => {
  const { buildExport } = await import('./data-rights');
  const { actor, taskId } = await fixture();
  const scanner = fakeScanner();
  const id = await upload(actor, taskId, 42, 'exported.pdf');
  await runAttachmentScan(getDb(), { store, scanner });

  const bundle = await buildExport(actor.userId);
  const list = bundle.attachments as Array<Record<string, unknown>>;
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({
    id,
    fileName: 'exported.pdf',
    sizeBytes: 42,
    scanStatus: 'CLEAN',
  });
  // Metadata only — no file payload ever enters the snapshot.
  expect(list[0]).not.toHaveProperty('data');
  expect(list[0]).not.toHaveProperty('bytes');
});
