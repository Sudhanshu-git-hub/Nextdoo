import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  createDurableFileExportStore,
  exports,
  notifications,
  purgeAccount,
  runExportGeneration,
  expireExports,
  users,
  subscriptions,
  CSV_COLUMNS,
  type ExportArtifactStore,
} from '@nextdoo/db';
import { requireTestDatabase } from '../../../../../tests/database';
import { getDb, withTransaction } from '../db';
import type { AuthContext } from '../auth';
import { registerUser } from './accounts';
import { createTask, completeTask } from './tasks';
import { requestExport, listExports, getExport, authorizeExportDownload, signExportDownloadToken } from './exports';

await requireTestDatabase();

function freshStore(): { store: ExportArtifactStore; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'nextdoo-export-test-'));
  return { store: createDurableFileExportStore(root), root };
}

async function fixture(withWork: boolean) {
  const user = await registerUser({ email: `export-${randomUUID()}@test.local`, passwordHash: 'test', name: null, timeZone: 'UTC' });
  const actor: AuthContext = {
    userId: user.id,
    workspaceId: user.workspaceId,
    sessionId: `integration-${user.id}`,
    email: user.email,
    emailVerified: true,
    timeZone: 'UTC',
  };
  let taskId: string | null = null;
  if (withWork) {
    const task = await createTask(actor, { workspaceId: actor.workspaceId, title: 'Exported task', priority: 'NONE', tagIds: [], dueAt: '2026-09-10T12:00:00Z' });
    taskId = task.id;
    await completeTask(actor, task.id, task.version);
  }
  return { actor, user, taskId };
}

async function forceDue(id: string) {
  await getDb().execute(sql`update exports set next_attempt_at = clock_timestamp() - interval '1 second' where id=${id}`);
}

/** registerUser seeds a FREE subscription row; the paid tests flip it in place. */
async function upgradeToPro(userId: string) {
  await withTransaction(async (db) => {
    await db.update(subscriptions)
      .set({ plan: 'PRO', status: 'ACTIVE', currentPeriodEnd: new Date(Date.now() + 30 * 86400000) })
      .where(eq(subscriptions.userId, userId));
  });
}

function parseCsv(text: string): { header: string[]; rows: Record<string, string>[] } {
  const lines = text.split('\n').filter((l) => l.length > 0);
  const header = lines[0]!.split(',');
  const rows = lines.slice(1).map((line) => {
    const cells: string[] = [];
    let cell = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i]!;
      if (inQuotes) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cell += '"'; i += 1; }
          else inQuotes = false;
        } else cell += ch;
      } else if (ch === '"') inQuotes = true;
      else if (ch === ',') { cells.push(cell); cell = ''; }
      else cell += ch;
    }
    cells.push(cell);
    const record: Record<string, string> = {};
    header.forEach((h, idx) => { record[h] = cells[idx] ?? ''; });
    return record;
  });
  return { header, rows };
}

it('JSON export is generated durably, scoped, and ready for 24 hours', async () => {
  const { store: s, root } = freshStore();
  try {
    const { actor, taskId } = await fixture(true);
    const summary = await requestExport(actor, { format: 'json' });
    expect(summary.status).toBe('PENDING');
    expect(summary.downloadUrl).toBeNull();

    const result = await runExportGeneration(getDb(), { store: s });
    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);

    const row = (await getDb().select().from(exports).where(eq(exports.id, summary.id)))[0]!;
    expect(row.status).toBe('READY');
    expect(row.objectKey).toBe(`export-${actor.userId}/${summary.id}.json.gz`);
    expect(row.sizeBytes).toBeGreaterThan(0);
    expect(row.completedAt).toBeInstanceOf(Date);
    const ttlMs = (row.expiresAt as Date).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(23 * 3600_000);
    expect(ttlMs).toBeLessThanOrEqual(24 * 3600_000);

    const file = join(root, row.objectKey!);
    expect(existsSync(file)).toBe(true);
    const body = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8'));
    expect(body.formatVersion).toBe(1);
    expect(body.kind).toBe('nextdoo-tracking-export');
    expect(body.account.id).toBe(actor.userId);
    expect(body.tasks.map((t: { id: string }) => t.id)).toContain(taskId);
    const types = body.events.map((e: { type: string }) => e.type);
    expect(types).toContain('TASK_CREATED');
    expect(types).toContain('TASK_COMPLETED');
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.rollups.daily).toHaveLength(90);
    expect(body.rollups.weekly).toHaveLength(8);
    expect(body.rollups.daily[0]).toHaveProperty('trackedTaskCount');
    const [notification] = await getDb().select().from(notifications).where(eq(notifications.userId, actor.userId));
    expect(notification?.type).toBe('export_ready');

    const listed = await listExports(actor, {});
    expect(listed.data).toHaveLength(1);
    expect(listed.data[0]!.downloadUrl).toContain(`/api/v1/exports/${summary.id}/download?token=`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('CSV export carries events, results and rollups as a typed union', async () => {
  const { store: s, root } = freshStore();
  try {
    const { actor } = await fixture(true);
    await requestExport(actor, { format: 'csv' });
    await runExportGeneration(getDb(), { store: s });
    const row = (await getDb().select().from(exports).where(eq(exports.userId, actor.userId)))[0]!;
    expect(row.status).toBe('READY');
    const text = gunzipSync(readFileSync(join(root, row.objectKey!))).toString('utf8');
    const { header, rows } = parseCsv(text);
    expect(header).toEqual(CSV_COLUMNS);
    const kinds = new Set(rows.map((r) => r.record_type));
    expect(kinds.has('event')).toBe(true);
    expect(kinds.has('result')).toBe(true);
    expect(kinds.has('rollup_daily')).toBe(true);
    expect(kinds.has('rollup_weekly')).toBe(true);
    const events = rows.filter((r) => r.record_type === 'event');
    expect(events.some((r) => r.type === 'TASK_COMPLETED')).toBe(true);
    expect(rows.filter((r) => r.record_type === 'rollup_daily')).toHaveLength(90);
    expect(rows.filter((r) => r.record_type === 'rollup_weekly')).toHaveLength(8);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('failures retry with backoff and exhaust into a visible failure notification', async () => {
  const { store: s, root } = freshStore();
  try {
    const { actor, user } = await fixture(true);
    await upgradeToPro(user.id);
    const { id } = await requestExport(actor, { format: 'json' });
    const failing: ExportArtifactStore = {
      write: async () => { throw new Error('STORE_UNAVAILABLE'); },
      read: async () => null,
      remove: async () => {},
    };
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const pass = await runExportGeneration(getDb(), { store: failing });
      expect(pass.retrying).toBe(1);
      const row = (await getDb().select().from(exports).where(eq(exports.id, id)))[0]!;
      expect(row.status).toBe('PENDING');
      expect(row.attempts).toBe(attempt);
      expect(row.error).toBe('STORE_UNAVAILABLE');
      // Backoff must push the next attempt into the future.
      expect((row.nextAttemptAt as Date).getTime()).toBeGreaterThan(Date.now());
      await forceDue(id);
    }
    const exhausted = await runExportGeneration(getDb(), { store: failing });
    expect(exhausted.failed).toBe(1);
    expect(exhausted.failures[0]!.exportId).toBe(id);
    const row = (await getDb().select().from(exports).where(eq(exports.id, id)))[0]!;
    expect(row.status).toBe('FAILED');
    expect(row.attempts).toBe(3);
    const [note] = await getDb().select().from(notifications).where(eq(notifications.userId, actor.userId));
    expect(note?.type).toBe('export_failed');

    // Recovery after the fault clears: a new request generates normally.
    const fresh = await requestExport(actor, { format: 'json' });
    expect((await runExportGeneration(getDb(), { store: s })).processed).toBe(1);
    expect((await getDb().select().from(exports).where(eq(exports.id, fresh.id)))[0]!.status).toBe('READY');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('a stale claim is reclaimed without double counting, and a delayed worker cannot publish', async () => {
  const { store: s, root } = freshStore();
  try {
    const { actor } = await fixture(true);
    const { id } = await requestExport(actor, { format: 'json' });
    // Simulate a worker that died mid-generation: claim held, lease expired.
    await getDb().execute(sql`update exports
      set status='PROCESSING', claim_token=${randomUUID()},
          lease_expires_at=clock_timestamp() - interval '1 minute',
          attempts=1, next_attempt_at=clock_timestamp() + interval '2 minutes'
      where id=${id}`);
    const pass = await runExportGeneration(getDb(), { store: s });
    expect(pass.processed).toBe(1);
    const row = (await getDb().select().from(exports).where(eq(exports.id, id)))[0]!;
    expect(row.status).toBe('READY');
    expect(row.attempts).toBe(2); // the crashed attempt kept its count
    expect(row.claimToken).toBeNull();

    // A crashed worker whose budget is already exhausted becomes a terminal,
    // notified failure — never a silent READY from a stale claim.
    await getDb().execute(sql`update exports
      set status='PROCESSING', claim_token=${randomUUID()},
          lease_expires_at=clock_timestamp() - interval '1 minute',
          attempts=3, next_attempt_at=clock_timestamp() + interval '2 minutes',
          expires_at=null, completed_at=null, object_key=null
      where id=${id}`);
    const pass2 = await runExportGeneration(getDb(), { store: s });
    expect(pass2.processed).toBe(0);
    expect(pass2.failed).toBe(1);
    const after = (await getDb().select().from(exports).where(eq(exports.id, id)))[0]!;
    expect(after.status).toBe('FAILED');
    expect(after.error).toBe('STALE_EXPORT_CLAIM');
    expect(after.claimToken).toBeNull();
    const notes = await getDb().select().from(notifications).where(eq(notifications.userId, actor.userId));
    expect(notes.filter((n) => n.type === 'export_failed')).toHaveLength(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('exports are tenant scoped: foreign rows are invisible and downloads are refused', async () => {
  const { store: s, root } = freshStore();
  try {
    const a = await fixture(true);
    const b = await fixture(false);
    const created = await requestExport(a.actor, { format: 'json' });
    await runExportGeneration(getDb(), { store: s });

    const listed = await listExports(b.actor, {});
    expect(listed.data).toEqual([]);
    await expect(getExport(b.actor, created.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(authorizeExportDownload(b.actor, created.id, 'forged-token')).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // Even a correctly signed token is bound to the owner.
    const row = (await getDb().select().from(exports).where(eq(exports.id, created.id)))[0]!;
    const foreignToken = signExportDownloadToken({
      exportId: created.id, userId: b.actor.userId, format: row.format, expiresAt: row.expiresAt as Date,
    });
    await expect(authorizeExportDownload(b.actor, created.id, foreignToken)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('download authorisation enforces state, token binding and expiry', async () => {
  const { store: s, root } = freshStore();
  try {
    const { actor, user } = await fixture(true);
    const { id } = await requestExport(actor, { format: 'json' });

    await expect(authorizeExportDownload(actor, id, 'x')).rejects.toMatchObject({ code: 'EXPORT_NOT_READY' });

    await runExportGeneration(getDb(), { store: s });
    const row = (await getDb().select().from(exports).where(eq(exports.id, id)))[0]!;
    const good = signExportDownloadToken({
      exportId: id, userId: actor.userId, format: row.format, expiresAt: row.expiresAt as Date,
    });
    const ok = await authorizeExportDownload(actor, id, good);
    expect(ok.objectKey).toBe(row.objectKey);

    await expect(authorizeExportDownload(actor, id, `${good.slice(0, -2)}qq`)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const wrongExport = signExportDownloadToken({
      exportId: randomUUID(), userId: actor.userId, format: row.format, expiresAt: row.expiresAt as Date,
    });
    await expect(authorizeExportDownload(actor, id, wrongExport)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const wrongFormat = signExportDownloadToken({
      exportId: id, userId: actor.userId, format: 'csv', expiresAt: row.expiresAt as Date,
    });
    await expect(authorizeExportDownload(actor, id, wrongFormat)).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // Expired window: the sweep marks it and the file is removed.
    await getDb().execute(sql`update exports set expires_at = clock_timestamp() - interval '1 minute' where id=${id}`);
    const sweep = await expireExports(getDb(), { store: s });
    expect(sweep.expired).toBe(1);
    expect((await getDb().select().from(exports).where(eq(exports.id, id)))[0]!.status).toBe('EXPIRED');
    expect(await s.read(row.objectKey!)).toBeNull();
    await expect(authorizeExportDownload(actor, id, good)).rejects.toMatchObject({ code: 'EXPORT_EXPIRED' });
    void user;
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('the free plan allows one export per day and paid plans are unlimited', async () => {
  const { root } = freshStore();
  try {
    const free = await fixture(true);
    await requestExport(free.actor, { format: 'json' });
    await expect(requestExport(free.actor, { format: 'csv' })).rejects.toMatchObject({ code: 'ENTITLEMENT_LIMIT_REACHED' });

    const paid = await fixture(true);
    await upgradeToPro(paid.user.id);
    await requestExport(paid.actor, { format: 'json' });
    const second = await requestExport(paid.actor, { format: 'csv' });
    expect(second.status).toBe('PENDING');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('the durable 3-per-hour limit still applies to paid plans', async () => {
  const { root } = freshStore();
  try {
    const { actor, user } = await fixture(true);
    await upgradeToPro(user.id);
    await requestExport(actor, { format: 'json' });
    await requestExport(actor, { format: 'csv' });
    await requestExport(actor, { format: 'json' });
    await expect(requestExport(actor, { format: 'csv' })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('account purge removes export rows and their artifact files', async () => {
  const { store: s, root } = freshStore();
  try {
    const { actor, user } = await fixture(true);
    const { id } = await requestExport(actor, { format: 'json' });
    await runExportGeneration(getDb(), { store: s });
    const row = (await getDb().select().from(exports).where(eq(exports.id, id)))[0]!;
    expect(existsSync(join(root, row.objectKey!))).toBe(true);

    const cutoff = new Date(Date.now() - 31 * 86400000);
    await getDb().update(users).set({ deletionRequestedAt: new Date(cutoff.getTime() - 86400000) }).where(eq(users.id, user.id));
    expect(await purgeAccount(getDb(), user.id, cutoff, { artifactStore: s })).toBe(true);

    expect(await getDb().select().from(exports).where(eq(exports.userId, user.id))).toEqual([]);
    expect(existsSync(join(root, row.objectKey!))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
