import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { createDb } from '@nextdoo/db';

/**
 * TEMPORARY CI DIAGNOSTIC (M6-i5, exports.spec.ts timeout investigation).
 *
 * exports.spec.ts test 1 has timed out at 30s on four consecutive CI runs of
 * the M6-i5 branch while passing on every run of the parent tip; the export
 * code/spec are byte-identical, and the same flow is fast in local
 * reproduction (with backlog state + concurrent /settings load). This spec
 * replays the same flow with per-step 25s guards and, on ANY step that
 * exceeds its guard, dumps pg_stat_activity (running/waiting queries,
 * idle-in-transaction backends, durations) plus the exports table state as
 * workflow annotations — runner logs and artifacts are unreachable from the
 * session, so the data must come out through annotations.
 *
 * Removes once the timeout is root-caused.
 */

const conn = createDb(process.env.DATABASE_URL!, { max: 2 });

function emit(line: string) {
  // Workflow annotation: surfaces in check-run annotations on failure.
  process.stdout.write(`::error file=apps/web/e2e/export-diag.spec.ts:: ${line}\n`);
}

async function dbActivity(): Promise<string[]> {
  const rows = await conn.db.$client.unsafe(
    `select pid, state, coalesce(wait_event_type || '/' || wait_event, '-') as wait,
            round(extract(epoch from now() - query_start)::numeric, 1) as dur_s,
            left(regexp_replace(query, E'\\s+', ' ', 'g'), 110) as query
     from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()
     order by query_start`,
  );
  return rows.map((r: Record<string, unknown>) => `pid=${r.pid} state=${r.state} wait=${r.wait} dur=${r.dur_s}s q=${r.query}`);
}

async function exportsState(): Promise<string[]> {
  const rows = await conn.db.$client.unsafe(
    `select id, user_id, status, attempts, claim_token is not null as claimed,
            next_attempt_at <= now() as due, left(object_key, 60) as obj
     from exports order by created_at`,
  );
  return rows.map((r: Record<string, unknown>) => `id=${r.id} status=${r.status} attempts=${r.attempts} claimed=${r.claimed} due=${r.due} obj=${r.obj}`);
}

async function withGuard<T>(name: string, ms: number, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  try {
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`step ${name} exceeded ${ms}ms`)), ms));
    return (await Promise.race([fn(), timeout])) as T;
  } catch (error) {
    const [activity, expState] = await Promise.allSettled([dbActivity(), exportsState()]);
    emit(
      `[export-diag] HUNG step=${name} after ${Date.now() - t0}ms error=${(error as Error).message}\n` +
      `[export-diag] pg_stat_activity:\n` +
      (activity.status === 'fulfilled' ? activity.value.join('\n') : `activity fetch failed: ${activity.reason}`) +
      `\n[export-diag] exports table:\n` +
      (expState.status === 'fulfilled' ? expState.value.join('\n') : `exports fetch failed: ${expState.reason}`),
    );
    throw error;
  }
}

test('diag: replay exports test-1 flow with hang diagnostics', async ({ page }) => {
  const email = `diag-${randomUUID()}@test.local`;
  const ORIGIN = { Origin: 'http://localhost:3100' };
  const headers = () => ({ ...ORIGIN, 'Idempotency-Key': randomUUID() });

  const reg = await withGuard('register', 25_000, async () => {
    const r = await page.request.post('/api/v1/auth/register', {
      headers: { ...ORIGIN, 'X-Forwarded-For': '198.51.100.244' },
      data: { email, password: 'diag-password-123', timeZone: 'UTC' },
    });
    if (r.status() !== 200) throw new Error(`register ${r.status}`);
    return await r.json();
  });
  const workspaceId = (reg as { workspaceId: string }).workspaceId;

  await withGuard('task', 25_000, async () => {
    const t = await page.request.post('/api/v1/tasks', { headers: headers(), data: { workspaceId, title: 'Diag export task', dueAt: new Date().toISOString() } });
    if (t.status() !== 200) throw new Error(`task ${t.status}`);
  });

  const idemKey = randomUUID();
  const expHeaders = { ...ORIGIN, 'Content-Type': 'application/json', 'Idempotency-Key': idemKey, 'X-Forwarded-For': '198.51.100.244' };
  const created = await withGuard('export-create', 25_000, async () => {
    const c = await page.request.post('/api/v1/exports', { headers: expHeaders, data: { format: 'json' } });
    if (c.status() !== 200) throw new Error(`export create ${c.status}`);
    return await c.json();
  });

  await withGuard('generate', 25_000, async () => {
    const { runExportGeneration, createDurableFileExportStore } = await import('@nextdoo/db');
    await runExportGeneration(conn.db, { store: createDurableFileExportStore() });
  });

  const ready = await withGuard('detail', 25_000, async () => {
    const d = await page.request.get(`/api/v1/exports/${created.id}`);
    if (d.status() !== 200) throw new Error(`detail ${d.status}`);
    return await d.json();
  });
  if (ready.status !== 'READY') throw new Error(`export not READY: ${ready.status}`);

  await withGuard('settings-goto', 25_000, () => page.goto('/settings'));

  for (const p of ['/api/v1/account/deletion', '/api/v1/auth/mfa/status', '/api/v1/me/sessions', '/api/v1/exports']) {
    await withGuard(`client-fetch:${p}`, 25_000, async () => {
      const r = await page.request.get(p);
      if (r.status() !== 200) throw new Error(`fetch ${p} ${r.status}`);
    });
  }

  // UI row + link, like the real test (but with a guard instead of a silent 30s test timeout).
  const row = page.locator('[data-export-status="READY"]');
  await withGuard('ready-row-20s', 25_000, () => expect(row).toHaveCount(1, { timeout: 20_000 }));
  const link = row.getByRole('link', { name: 'Download' });
  const linkCount = await withGuard('link-count', 5_000, () => link.count()).catch(() => 'count-threw');
  emit(`[export-diag] ready-row count OK; Download link count=${String(linkCount)}`);

  await withGuard('download', 25_000, async () => {
    const raw = await page.request.get(ready.downloadUrl as string);
    if (raw.status() !== 200) throw new Error(`download ${raw.status}`);
    await raw.body();
  });

  emit('[export-diag] all steps completed within guards (no hang reproduced this run)');
});

test.afterAll(() => { void conn.close(); });
