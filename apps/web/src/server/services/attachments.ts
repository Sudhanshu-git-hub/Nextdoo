import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  AppError,
  ATTACHMENT_CONTENT_TYPE_EXTENSIONS,
  ATTACHMENT_TOKEN_TTL_MS,
  isAllowedAttachmentContentType,
  limitsFor,
  type AttachmentUploadInput,
} from '@nextdoo/contracts';
import { attachments, createDurableFileAttachmentStore } from '@nextdoo/db';
import { getEnv } from '../env';
import type { AuthContext } from '../auth';
import { getDb, withTransaction } from '../db';
import { getPlan } from './accounts';
import { loadTask } from './tasks';
import { writeAuditLog } from './events';

/**
 * Attachment lifecycle (PRD §6.8, §11.4, §14):
 *
 *   POST /upload (authorization: plan limits, allowlist, quota)
 *   → PUT /:id/upload-data (signed 15-minute upload token, exact declared size)
 *   → POST /:id/complete (size verified, scan queued)
 *   → async `attachment.scan` worker (ClamAV; 3 attempts; quarantine)
 *   → GET /:id/download (blocked until CLEAN; signed 15-minute download URL)
 *   → DELETE /:id (soft delete + object removal; quota released)
 *
 * The client never receives storage credentials; every object key is
 * server-generated. Downloads are the only path from store to bytes, and they
 * require a session, the attachment's CLEAN status, and a valid signed token.
 */

export type AttachmentView = {
  id: string;
  taskId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  scanStatus: 'PENDING' | 'CLEAN' | 'INFECTED' | 'FAILED';
  uploadedAt: string | null;
  createdAt: string;
  downloadUrl: string | null;
};

function tokenKey(kind: 'upload' | 'download'): string {
  return createHash('sha256')
    .update(`nextdoo/attachment-${kind}/v1:${getEnv().AUTH_SECRET}`)
    .digest('base64');
}

function b64url(input: string): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * Signed, purpose-bound, 15-minute attachment token (PRD §12). Exported so
 * tests and the worker-driven E2E suite can exercise the token-gated
 * endpoints; production always signs server-side.
 */
export function signAttachmentToken(kind: 'upload' | 'download', attachmentId: string, userId: string, sizeBytes?: number): string {
  const payload = b64url(JSON.stringify({
    v: 1,
    k: kind,
    a: attachmentId,
    u: userId,
    s: sizeBytes ?? null,
    x: Math.floor((Date.now() + ATTACHMENT_TOKEN_TTL_MS) / 1000),
  }));
  const sig = createHmac('sha256', tokenKey(kind)).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyAttachmentToken(token: string | null, kind: 'upload' | 'download', attachmentId: string, userId: string, sizeBytes?: number): boolean {
  if (!token || !token.includes('.')) return false;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;
  const expected = createHmac('sha256', tokenKey(kind)).update(payload).digest();
  const actual = Buffer.from(sig, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
  try {
    const body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      v?: unknown; k?: unknown; a?: unknown; u?: unknown; s?: unknown; x?: unknown;
    };
    if (body.v !== 1 || body.k !== kind) return false;
    if (body.a !== attachmentId || body.u !== userId) return false;
    if (sizeBytes !== undefined && Number(body.s) !== sizeBytes) return false;
    if (typeof body.x !== 'number' || body.x < Math.floor(Date.now() / 1000)) return false;
    return true;
  } catch {
    return false;
  }
}

function toView(row: {
  id: string; taskId: string; fileName: string; contentType: string; sizeBytes: number;
  scanStatus: 'PENDING' | 'CLEAN' | 'INFECTED' | 'FAILED'; uploadedAt: Date | null; createdAt: Date;
}, userId: string): AttachmentView {
  const clean = row.scanStatus === 'CLEAN';
  return {
    id: row.id,
    taskId: row.taskId,
    fileName: row.fileName,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    scanStatus: row.scanStatus,
    uploadedAt: row.uploadedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    downloadUrl: clean ? `/api/v1/attachments/${row.id}/download/file?token=${signAttachmentToken('download', row.id, userId)}` : null,
  };
}

/** Strips path separators and control characters; display name only. */
function sanitizeFileName(raw: string): string {
  // Intentional: strip control characters so a display name can never carry
  // CR/LF or NUL into logs, headers or audit metadata.
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\r\n\0-\x1f]/g, '').replace(/[/\\]/g, '_').trim();
  return (cleaned || 'attachment').slice(0, 300);
}

function humanBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
  return `${Math.ceil(bytes / 1024)} KB`;
}

async function loadAttachmentRow(userId: string, workspaceId: string, id: string) {
  const db = getDb();
  const [row] = await db.select().from(attachments)
    .where(and(eq(attachments.id, id), eq(attachments.workspaceId, workspaceId), eq(attachments.uploaderId, userId), isNull(attachments.deletedAt)))
    .limit(1);
  if (!row) throw new AppError('NOT_FOUND', 'Attachment not found.');
  return row;
}

export async function authorizeAttachmentUpload(auth: AuthContext, input: AttachmentUploadInput) {
  // Tenant boundary: the task must exist in the caller's own workspace.
  await loadTask(auth.workspaceId, input.taskId);

  if (!isAllowedAttachmentContentType(input.contentType)) {
    throw new AppError('VALIDATION_FAILED', 'This file type is not supported for attachments.');
  }

  const limits = limitsFor(await getPlan(auth.userId));
  if (input.sizeBytes > limits.maxFileBytes) {
    throw new AppError('ENTITLEMENT_LIMIT_REACHED', `Your plan allows files up to ${humanBytes(limits.maxFileBytes)}.`);
  }

  const db = getDb();
  const [usage] = await db
    .select({ bytes: sql<number>`coalesce(sum(${attachments.sizeBytes}), 0)` })
    .from(attachments)
    .where(and(eq(attachments.workspaceId, auth.workspaceId), isNull(attachments.deletedAt)));
  if ((Number(usage?.bytes ?? 0) + input.sizeBytes) > limits.attachmentStorageBytes) {
    throw new AppError(
      'ENTITLEMENT_LIMIT_REACHED',
      `Your plan includes ${humanBytes(limits.attachmentStorageBytes)} of attachment storage. Delete something or upgrade.`,
    );
  }

  const id = randomUUID();
  const ext = ATTACHMENT_CONTENT_TYPE_EXTENSIONS[input.contentType];
  const objectKey = `attach-${auth.workspaceId}/${id}.${ext}`;
  const row = await db.insert(attachments).values({
    id,
    workspaceId: auth.workspaceId,
    taskId: input.taskId,
    uploaderId: auth.userId,
    objectKey,
    fileName: sanitizeFileName(input.fileName),
    contentType: input.contentType,
    sizeBytes: input.sizeBytes,
    scanStatus: 'PENDING',
  }).returning();
  const created = row[0];
  if (!created) throw new AppError('INTERNAL_ERROR', 'The attachment could not be created.');
  return {
    attachment: toView(created, auth.userId),
    uploadUrl: `/api/v1/attachments/${id}/upload-data?token=${signAttachmentToken('upload', id, auth.userId, input.sizeBytes)}`,
    expiresIn: Math.floor(ATTACHMENT_TOKEN_TTL_MS / 1000),
  };
}

/** Reads a request body with a hard cap; enforces the exact declared size. */
async function readBoundedBody(stream: ReadableStream<Uint8Array>, exactBytes: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > exactBytes) {
      await reader.cancel().catch(() => undefined);
      throw new AppError('VALIDATION_FAILED', 'Upload exceeded the declared file size.');
    }
    chunks.push(value);
  }
  if (total !== exactBytes) {
    throw new AppError('VALIDATION_FAILED', 'Uploaded size does not match the declared file size.');
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}

export async function writeAttachmentData(auth: AuthContext, id: string, token: string | null, body: ReadableStream<Uint8Array>): Promise<void> {
  const row = await loadAttachmentRow(auth.userId, auth.workspaceId, id);
  if (row.uploadedAt !== null) throw new AppError('VALIDATION_FAILED', 'This attachment already has file data.');
  if (!verifyAttachmentToken(token, 'upload', id, auth.userId, row.sizeBytes)) {
    throw new AppError('FORBIDDEN', 'The upload token is invalid or has expired. Request a new upload.');
  }
  const data = await readBoundedBody(body, row.sizeBytes);
  await createDurableFileAttachmentStore().write(row.objectKey, data);
}

export async function completeAttachment(auth: AuthContext, id: string): Promise<AttachmentView> {
  const row = await loadAttachmentRow(auth.userId, auth.workspaceId, id);
  if (row.uploadedAt === null) {
    const existing = await createDurableFileAttachmentStore().read(row.objectKey);
    if (existing === null) {
      throw new AppError('VALIDATION_FAILED', 'Upload the file data before completing this attachment.');
    }
    if (existing.byteLength !== row.sizeBytes) {
      throw new AppError('VALIDATION_FAILED', 'Uploaded size does not match the declared file size.');
    }
    await withTransaction(async (db) => {
      await db.update(attachments)
        .set({ uploadedAt: sql`clock_timestamp()`, nextAttemptAt: sql`clock_timestamp()` })
        .where(and(eq(attachments.id, id), isNull(attachments.uploadedAt)));
    });
    await writeAuditLog({
      userId: auth.userId, workspaceId: auth.workspaceId,
      action: 'attachment.completed', entityType: 'attachment', entityId: id,
      metadata: { sizeBytes: row.sizeBytes },
    });
  }
  const db = getDb();
  const [fresh] = await db.select().from(attachments).where(eq(attachments.id, id)).limit(1);
  if (!fresh) throw new AppError('NOT_FOUND', 'Attachment not found.');
  return toView(fresh, auth.userId);
}

export async function listAttachments(auth: AuthContext, taskId: string): Promise<AttachmentView[]> {
  await loadTask(auth.workspaceId, taskId);
  const db = getDb();
  const rows = await db.select().from(attachments)
    .where(and(
      eq(attachments.taskId, taskId),
      eq(attachments.workspaceId, auth.workspaceId),
      eq(attachments.uploaderId, auth.userId),
      isNull(attachments.deletedAt),
    ))
    .orderBy(attachments.createdAt);
  return rows.map((r) => toView(r, auth.userId));
}

/**
 * Issues a short-lived signed download URL (PRD §11.4: ≤ 15 minutes).
 * Blocked until the scan status is CLEAN — PENDING, INFECTED and FAILED are
 * all refusals with a state-specific explanation.
 */
export async function requestAttachmentDownload(auth: AuthContext, id: string): Promise<{ downloadUrl: string; expiresIn: number }> {
  const row = await loadAttachmentRow(auth.userId, auth.workspaceId, id);
  if (row.scanStatus !== 'CLEAN') {
    const detail = row.scanStatus === 'PENDING'
      ? 'This file is still being scanned. Try again shortly.'
      : row.scanStatus === 'INFECTED'
        ? 'This file was flagged as unsafe by the malware scan and cannot be downloaded.'
        : 'The malware scan for this file failed and it cannot be downloaded. Delete it and upload again.';
    throw new AppError('ATTACHMENT_NOT_CLEAN', detail);
  }
  return {
    downloadUrl: `/api/v1/attachments/${id}/download/file?token=${signAttachmentToken('download', id, auth.userId)}`,
    expiresIn: Math.floor(ATTACHMENT_TOKEN_TTL_MS / 1000),
  };
}

export async function streamAttachmentDownload(auth: AuthContext, id: string, token: string | null): Promise<{
  data: Uint8Array; fileName: string; contentType: string;
}> {
  const row = await loadAttachmentRow(auth.userId, auth.workspaceId, id);
  if (!verifyAttachmentToken(token, 'download', id, auth.userId)) {
    throw new AppError('FORBIDDEN', 'The download token is invalid or has expired. Request a new download.');
  }
  if (row.scanStatus !== 'CLEAN') {
    throw new AppError('ATTACHMENT_NOT_CLEAN', 'This file cannot be downloaded until it has a clean scan.');
  }
  const data = await createDurableFileAttachmentStore().read(row.objectKey);
  if (data === null) {
    // A CLEAN row without its object is a consistency failure, never a silent 200.
    throw new AppError('INTERNAL_ERROR', 'The file is missing. Request a new export or re-upload.');
  }
  await writeAuditLog({
    userId: auth.userId, workspaceId: auth.workspaceId,
    action: 'attachment.downloaded', entityType: 'attachment', entityId: id,
    metadata: { sizeBytes: row.sizeBytes },
  });
  return { data, fileName: row.fileName, contentType: row.contentType };
}

export async function deleteAttachment(auth: AuthContext, id: string): Promise<void> {
  const row = await loadAttachmentRow(auth.userId, auth.workspaceId, id);
  await withTransaction(async (db) => {
    await db.update(attachments)
      .set({ deletedAt: sql`clock_timestamp()` })
      .where(and(eq(attachments.id, id), isNull(attachments.deletedAt)));
  });
  await createDurableFileAttachmentStore().remove(row.objectKey).catch(() => undefined);
  await writeAuditLog({
    userId: auth.userId, workspaceId: auth.workspaceId,
    action: 'attachment.deleted', entityType: 'attachment', entityId: id,
    metadata: { sizeBytes: row.sizeBytes },
  });
}
