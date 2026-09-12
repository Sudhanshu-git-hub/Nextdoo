import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { AppError, limitsFor, requestExportSchema } from '@nextdoo/contracts';
import { exports } from '@nextdoo/db';
import { and, count, eq, getTableColumns, gt, lt, or, sql, type SQL } from 'drizzle-orm';
import type { AuthContext } from '../auth';
import { getDb, withTransaction } from '../db';
import { getEnv } from '../env';
import { newId } from '../ids';
import { reserveExport } from '../export-quota';
import { writeAuditLog } from './events';
import { getPlan } from './accounts';

/**
 * Asynchronous expiring data exports (PRD §7.10, §12.4, §13, §14, §18.1).
 *
 * POST /api/v1/exports creates a PENDING row the export.generate worker job
 * claims; GET /api/v1/exports lists them; GET /api/v1/exports/:id returns
 * status plus a signed download URL while READY; GET .../download streams the
 * artifact. Download tokens are HMAC-signed, bound to export/user/format and
 * to the row's 24-hour expiry, and are never stored (PRD §11.4).
 */

const PAGE_MAX = 50;
const PAGE_DEFAULT = 25;

/** HMAC key derived from AUTH_SECRET; the token itself is never persisted. */
function tokenKey(): Buffer {
  return createHash('sha256').update(`nextdoo/export-download/v1:${getEnv().AUTH_SECRET}`).digest();
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export function signExportDownloadToken(input: {
  exportId: string;
  userId: string;
  format: string;
  expiresAt: Date;
}): string {
  const payload = b64url(JSON.stringify({
    v: 1,
    e: input.exportId,
    u: input.userId,
    f: input.format,
    x: Math.floor(input.expiresAt.getTime() / 1000),
  }));
  const sig = b64url(createHmac('sha256', tokenKey()).update(payload).digest());
  return `${payload}.${sig}`;
}

export function verifyExportDownloadToken(token: string | null, expected: {
  exportId: string;
  userId: string;
  format: string;
  expiresAt: Date;
}): boolean {
  if (!token || !token.includes('.')) return false;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;
  const expectedSig = b64url(createHmac('sha256', tokenKey()).update(payload).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  let body: { v?: number; e?: string; u?: string; f?: string; x?: number };
  try { body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return false; }
  return body.v === 1
    && body.e === expected.exportId
    && body.u === expected.userId
    && body.f === expected.format
    && typeof body.x === 'number'
    && body.x * 1000 > Date.now()
    && body.x * 1000 <= expected.expiresAt.getTime() + 60_000;
}

export interface ExportSummary {
  id: string;
  format: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
  expiresAt: string | null;
  sizeBytes: number | null;
  error: string | null;
  downloadUrl: string | null;
}

function serialise(row: typeof exports.$inferSelect): ExportSummary {
  return {
    id: row.id,
    format: row.format,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    sizeBytes: row.sizeBytes,
    error: row.error,
    downloadUrl: row.status === 'READY' && row.expiresAt
      ? `/api/v1/exports/${row.id}/download?token=${signExportDownloadToken({
        exportId: row.id, userId: row.userId, format: row.format, expiresAt: row.expiresAt,
      })}`
      : null,
  };
}

interface ExportRow {
  id: string;
  userId: string;
  workspaceId: string | null;
  format: string;
  status: string;
  objectKey: string | null;
  sizeBytes: number | null;
  expiresAt: Date | null;
  error: string | null;
  attempts: number;
  nextAttemptAt: Date;
  completedAt: Date | null;
  claimToken: string | null;
  leaseExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function loadOwnedExport(auth: AuthContext, id: string): Promise<ExportRow> {
  return withTransaction(async (db) => {
    const [row] = await db
      .select({ ...getTableColumns(exports) })
      .from(exports)
      .where(and(eq(exports.id, id), eq(exports.userId, auth.userId)))
      .limit(1);
    if (!row) throw new AppError('NOT_FOUND', 'The requested resource does not exist.');
    return row as unknown as ExportRow;
  });
}

/**
 * Requests a new export. Enforces the durable 3/hour limit (PRD §14.8) and the
 * plan's daily export allowance (PRD §18.1: Free 1/day, paid unlimited).
 */
export async function requestExport(auth: AuthContext, input: { format: string; requestId?: string }): Promise<ExportSummary> {
  const format = requestExportSchema.parse(input).format;
  await reserveExport(auth.userId);

  const limits = limitsFor(await getPlan(auth.userId));
  if (limits.exportsPerDay !== null) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const db = getDb();
    const [usage] = await db
      .select({ n: count() })
      .from(exports)
      .where(and(eq(exports.userId, auth.userId), gt(exports.createdAt, since)));
    if ((usage?.n ?? 0) >= limits.exportsPerDay) {
      throw new AppError(
        'ENTITLEMENT_LIMIT_REACHED',
        `Your plan allows ${limits.exportsPerDay} export per day. Try again tomorrow.`,
      );
    }
  }

  const row = await withTransaction(async (db) => {
    const created = await db
      .insert(exports)
      .values({
        id: newId(),
        userId: auth.userId,
        workspaceId: auth.workspaceId,
        format,
        status: 'PENDING',
        nextAttemptAt: new Date(),
      })
      .returning();
    return created[0] as unknown as ExportRow;
  });

  await writeAuditLog({
    userId: auth.userId,
    workspaceId: auth.workspaceId,
    action: 'export.requested',
    entityType: 'export',
    entityId: row.id,
    metadata: { format },
    requestId: input.requestId,
  });
  return serialise(row);
}

interface ExportCursor {
  c: string;
  i: string;
}

function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify({ c: row.createdAt.toISOString(), i: row.id } satisfies ExportCursor)).toString('base64url');
}

function decodeCursor(cursor: string | undefined): ExportCursor | null {
  if (!cursor) return null;
  try {
    const body = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as ExportCursor;
    if (typeof body?.c !== 'string' || typeof body?.i !== 'string') return null;
    new Date(body.c);
    return body;
  } catch {
    return null;
  }
}

/** Cursor-paginated list of the caller's exports, newest first. */
export async function listExports(
  auth: AuthContext,
  query: { cursor?: string | null; limit?: number | null },
): Promise<{ data: ExportSummary[]; nextCursor: string | null; hasMore: boolean }> {
  const limit = Math.min(Math.max(Number(query.limit ?? PAGE_DEFAULT) || PAGE_DEFAULT, 1), PAGE_MAX);
  const cursor = decodeCursor(query.cursor ?? undefined);
  const conditions = [eq(exports.userId, auth.userId)];
  if (cursor) {
    conditions.push(or(
      lt(exports.createdAt, new Date(cursor.c)),
      and(eq(exports.createdAt, new Date(cursor.c)), lt(exports.id, cursor.i)),
    ) as SQL);
  }
  const rows = await withTransaction(async (db) =>
    (db
      .select({ ...getTableColumns(exports) })
      .from(exports)
      .where(and(...conditions))
      .orderBy(sql`${exports.createdAt} desc, ${exports.id} desc`)
      .limit(limit + 1)) as Promise<ExportRow[]>);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    data: page.map(serialise),
    nextCursor: hasMore && last ? encodeCursor(last) : null,
    hasMore,
  };
}

export async function getExport(auth: AuthContext, id: string): Promise<ExportSummary> {
  return serialise(await loadOwnedExport(auth, id));
}

export interface DownloadedExport {
  id: string;
  objectKey: string;
  format: string;
  sizeBytes: number | null;
  expiresAt: string;
}

/**
 * Authorises a download: the row must be READY and unexpired, and the signed
 * token must bind to this export/user/format and to its expiry window.
 */
export async function authorizeExportDownload(
  auth: AuthContext,
  id: string,
  token: string | null,
  requestId?: string,
): Promise<DownloadedExport> {
  const row = await loadOwnedExport(auth, id);
  if (row.status === 'EXPIRED' || (row.status === 'READY' && row.expiresAt && row.expiresAt.getTime() <= Date.now())) {
    throw new AppError('EXPORT_EXPIRED', 'This export has expired. Request a new one from Settings.');
  }
  if (row.status !== 'READY') {
    throw new AppError('EXPORT_NOT_READY', 'This export is not ready for download yet.');
  }
  if (!verifyExportDownloadToken(token, {
    exportId: row.id, userId: row.userId, format: row.format, expiresAt: row.expiresAt as Date,
  })) {
    throw new AppError('FORBIDDEN', 'Invalid or expired download token.');
  }
  await writeAuditLog({
    userId: auth.userId,
    workspaceId: auth.workspaceId,
    action: 'export.downloaded',
    entityType: 'export',
    entityId: row.id,
    metadata: { format: row.format },
    requestId,
  });
  return {
    id: row.id,
    objectKey: row.objectKey as string,
    format: row.format,
    sizeBytes: row.sizeBytes,
    expiresAt: (row.expiresAt as Date).toISOString(),
  };
}
