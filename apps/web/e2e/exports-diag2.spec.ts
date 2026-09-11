import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import { createDb, createDurableFileExportStore, runExportGeneration } from '@nextdoo/db';

/**
 * TEMPORARY CI DIAGNOSTIC round 2 (M6-i5, exports.spec.ts timeout).
 *
 * Round 1 (export-diag.spec.ts) replayed every non-browser step of the real
 * test and passed in CI, with the READY row and its Download link present —
 * so the sink is in the browser-only tail: the download click +
 * waitForEvent('download') (the only unguarded 30s waits in the test).
 *
 * This spec is a line-for-line replica of exports.spec.ts test 1 (replay,
 * list, generation, detail, ttl, panel, row, cell, download click +
 * waitForEvent, gunzip, raw GET, axe) with:
 *   - 24s per-step guards (so it fails BEFORE the 30s test timeout),
 *   - browser-level event capture around the download: request/response/
 *     requestfailed/download events, console errors, page crash, with
 *     timestamps,
 *   - a diagnostic annotation emitted on EVERY completion path.
 *
 * Runs immediately before exports.spec.ts (alphabetical) on a fresh user/IP.
 * Removes once the timeout is root-caused.
 */

const conn = createDb(process.env.DATABASE_URL!, { max: 2 });
const ORIGIN = { Origin: 'http://localhost:3100' };
const headers = () => ({ ...ORIGIN, 'Idempotency-Key': randomUUID() });
const t0 = Date.now();
const log: string[] = [];
const mark = (m: string) => log.push(`[${String(Date.now() - t0).padStart(6)}ms] ${m}`);

function emit(line: string) {
  process.stdout.write(`::error file=apps/web/e2e/exports-diag2.spec.ts:: ${line}\n`);
}

function attachBrowserCapture(page: import('@playwright/test').Page) {
  page.on('request', (r) => { if (r.url().includes('/download')) mark(`REQ  ${r.method()} ${r.url().split('?')[0]}?… (has-token=${r.url().includes('token=')})`); });
  page.on('response', (r) => { if (r.url().includes('/download')) mark(`RESP ${r.status()} cd=${r.headers()['content-disposition'] ?? '-'} ct=${r.headers()['content-type'] ?? '-'}`); });
  page.on('requestfailed', (r) => { if (r.url().includes('/download')) mark(`REQFAIL ${r.failure()?.errorText ?? 'unknown'}`); });
  page.on('download', (d) => mark(`DL-EVENT suggested=${d.suggestedFilename()}`));
  page.on('crash', () => mark('PAGE-CRASH'));
  page.on('console', (msg) => { if (msg.type() === 'error') mark(`CONSOLE-ERR ${msg.text().slice(0, 160)}`); });
  page.on('pageerror', (e) => mark(`PAGE-ERR ${String(e).slice(0, 160)}`));
}

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const ts = Date.now();
  try {
    const r = await Promise.race([fn(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${name} exceeded 24000ms`)), 24_000))]) as T;
    mark(`OK   ${name} (${Date.now() - ts}ms)`);
    return r;
  } catch (error) {
    mark(`HUNG ${name} after ${Date.now() - ts}ms: ${(error as Error).message}`);
    emit(`[diag2] step=${name} FAILED after ${Date.now() - ts}ms\n[diag2] timeline:\n${log.join('\n')}`);
    throw error;
  }
}

test('diag2: exact replica of exports test 1 with browser capture', async ({ page }) => {
  attachBrowserCapture(page);

  await step('fixture', async () => {
    const r = await page.request.post('/api/v1/auth/register', {
      headers: { ...ORIGIN, 'X-Forwarded-For': '198.51.100.245' },
      data: { email: `diag2-${randomUUID()}@test.local`, password: 'diag2-test-password-123', timeZone: 'UTC' },
    });
    if (r.status() !== 200) throw new Error(`register ${r.status}`);
    const { workspaceId } = await r.json();
    const t = await page.request.post('/api/v1/tasks', { headers: headers(), data: { workspaceId, title: 'Export browser task', dueAt: new Date().toISOString() } });
    if (t.status() !== 200) throw new Error(`task ${t.status}`);
  });

  const idemKey = randomUUID();
  let pending: { id: string };
  await step('export-create+replay+list', async () => {
    const created = await page.request.post('/api/v1/exports', { headers: { ...ORIGIN, 'Idempotency-Key': idemKey }, data: { format: 'json' } });
    if (created.status() !== 200) throw new Error(`create ${created.status}`);
    const c = await created.json();
    if (c.status !== 'PENDING') throw new Error(`status ${c.status}`);
    const replay = await page.request.post('/api/v1/exports', { headers: { ...ORIGIN, 'Idempotency-Key': idemKey }, data: { format: 'json' } });
    if (replay.status() !== 200) throw new Error(`replay ${replay.status}`);
    // Same semantics as the real test: deep-equal (the idempotency store
    // re-serializes stored responses, so key order may differ).
    expect(await replay.json()).toEqual(c);
    const list = await (await page.request.get('/api/v1/exports')).json();
    if (list.data.length !== 1) throw new Error(`list len ${list.data.length}`);
    pending = c;
  });

  await step('generate', async () => {
    await runExportGeneration(conn.db, { store: createDurableFileExportStore() });
  });

  let downloadUrl = '';
  await step('detail+ttl', async () => {
    const ready = await (await page.request.get(`/api/v1/exports/${pending!.id}`)).json();
    if (ready.status !== 'READY') throw new Error(`detail ${ready.status}`);
    if (!(ready.sizeBytes > 0)) throw new Error('sizeBytes 0');
    const ttlHours = (new Date(ready.expiresAt).getTime() - Date.now()) / 3600_000;
    if (!(ttlHours > 23 && ttlHours <= 24)) throw new Error(`ttl ${ttlHours}`);
    downloadUrl = ready.downloadUrl as string;
  });

  await step('goto-settings', () => page.goto('/settings'));

  let row: import('@playwright/test').Locator;
  await step('panel+row+cell', async () => {
    const panel = page.getByRole('region', { name: /data export/i }).first();
    await expect(panel).toBeVisible();
    row = page.locator('[data-export-status="READY"]');
    await expect(row).toHaveCount(1, { timeout: 20_000 });
    await expect(page.getByRole('cell', { name: /ready/i }).first()).toBeVisible();
  });

  // THE suspect: download click + waitForEvent — 24s guard + full capture.
  let downloadFired = false;
  let downloadPath: string | null = null;
  await step('download-click', async () => {
    const dl = page.waitForEvent('download', { timeout: 24_000 });
    dl.then((d) => { downloadFired = true; mark(`DL-EVENT suggested=${d.suggestedFilename()}`); }, () => {});
    await row!.getByRole('link', { name: 'Download' }).click();
    const download = await dl;
    downloadPath = await download.path();
    mark(`DL-PATH ${downloadPath}`);
  });

  if (downloadPath) {
    const parsed = JSON.parse(gunzipSync(readFileSync(downloadPath)).toString('utf8'));
    mark(`gunzip OK kind=${parsed.kind} events=${parsed.events.length}`);
    if (!(parsed.events.length > 0)) emit(`[diag2] WARNING: events empty (would fail the real test)`);
  }

  await step('raw-download', async () => {
    const raw = await page.request.get(downloadUrl);
    if (raw.status() !== 200) throw new Error(`raw ${raw.status}`);
    await raw.body();
  });

  await step('axe', async () => {
    const { default: AxeBuilder } = await import('@axe-core/playwright');
    const res = await new AxeBuilder({ page }).include('section[aria-labelledby="data-export-heading"]').analyze();
    if (res.violations.length) emit(`[diag2] axe violations: ${JSON.stringify(res.violations.map((v) => v.id))}`);
  });

  emit(`[diag2] replica COMPLETED downloadFired=${downloadFired}\n[diag2] timeline:\n${log.join('\n')}`);
});

test.afterAll(() => { void conn.close(); });
