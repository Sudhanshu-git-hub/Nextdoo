import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { test, expect, type Page } from '@playwright/test';
import { sql } from 'drizzle-orm';
import { createDb, runExportGeneration, expireExports, createDurableFileExportStore } from '@nextdoo/db';

const connection = createDb(process.env.DATABASE_URL!, { max: 2 });
test.afterAll(() => connection.close());

/**
 * The E2E web server and this test process share the default export store
 * root, so driving runExportGeneration here produces the same artifacts the
 * download route streams.
 */
const store = createDurableFileExportStore();
const origin = { Origin: 'http://localhost:3100' };
const headers = () => ({ ...origin, 'Idempotency-Key': randomUUID() });

async function fixture(page: Page) {
  const r = await page.request.post('/api/v1/auth/register', {
    headers: { ...origin, 'X-Forwarded-For': '198.51.100.201' },
    data: { email: `exports-${randomUUID()}@test.local`, password: 'exports-test-password-123', timeZone: 'UTC' },
  });
  expect(r.status()).toBe(200);
  const { workspaceId } = await r.json();
  const t = await page.request.post('/api/v1/tasks', {
    headers: headers(),
    data: { workspaceId, title: 'Export browser task', dueAt: new Date().toISOString() },
  });
  expect(t.status()).toBe(200);
  return { workspaceId, task: await t.json() };
}

test('a requested export is generated, listed, downloadable and accessible', async ({ page }) => {
  await fixture(page);
  const idemKey = randomUUID();
  const created = await page.request.post('/api/v1/exports', { headers: { ...origin, 'Idempotency-Key': idemKey }, data: { format: 'json' } });
  expect(created.status()).toBe(200);
  const pending = await created.json();
  expect(pending.status).toBe('PENDING');
  expect(pending.downloadUrl).toBeNull();

  // Replaying the same idempotent command must not create another export.
  const replay = await page.request.post('/api/v1/exports', { headers: { ...origin, 'Idempotency-Key': idemKey }, data: { format: 'json' } });
  expect(replay.status()).toBe(200);
  expect(await replay.json()).toEqual(pending);
  expect((await (await page.request.get('/api/v1/exports')).json()).data).toHaveLength(1);

  await runExportGeneration(connection.db, { store });
  const ready = await (await page.request.get(`/api/v1/exports/${pending.id}`)).json();
  expect(ready.status).toBe('READY');
  expect(ready.sizeBytes).toBeGreaterThan(0);
  expect(ready.downloadUrl).toContain(`/api/v1/exports/${pending.id}/download?token=`);
  const ttlHours = (new Date(ready.expiresAt).getTime() - Date.now()) / 3600_000;
  expect(ttlHours).toBeGreaterThan(23);
  expect(ttlHours).toBeLessThanOrEqual(24);

  await page.goto('/settings');
  const panel = page.getByRole('region', { name: /data export/i }).first();
  await expect(panel).toBeVisible();
  const row = page.locator('[data-export-status="READY"]');
  await expect(row).toHaveCount(1, { timeout: 20_000 });
  await expect(page.getByRole('cell', { name: /ready/i }).first()).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    row.getByRole('link', { name: 'Download' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^nextdoo-tracking-export-[0-9a-f]{8}\.json\.gz$/);
  const body = gunzipSync(readFileSync(await download.path()));
  const parsed = JSON.parse(body.toString('utf8'));
  expect(parsed.kind).toBe('nextdoo-tracking-export');
  expect(parsed.events.length).toBeGreaterThan(0);

  // The artifact response is a private attachment.
  const raw = await page.request.get(ready.downloadUrl);
  expect(raw.status()).toBe(200);
  expect(raw.headers()['content-type']).toBe('application/gzip');
  expect(raw.headers()['content-disposition']).toContain('attachment');
  expect(raw.headers()['cache-control']).toContain('no-store');

  const { default: AxeBuilder } = await import('@axe-core/playwright');
  expect((await new AxeBuilder({ page }).include('section[aria-labelledby="data-export-heading"]').analyze()).violations).toEqual([]);
});

test('foreign accounts cannot see, request against, or download another account’s exports', async ({ page, playwright }) => {
  const { task } = await fixture(page);
  const created = await page.request.post('/api/v1/exports', { headers: headers(), data: { format: 'csv' } });
  expect(created.status()).toBe(200);
  const pending = await created.json();
  await runExportGeneration(connection.db, { store });
  const ready = await (await page.request.get(`/api/v1/exports/${pending.id}`)).json();

  const foreign = await playwright.request.newContext({ baseURL: 'http://localhost:3100' });
  try {
    expect((await foreign.get(`/api/v1/exports/${pending.id}`)).status()).toBe(401);
    const reg = await foreign.post('/api/v1/auth/register', {
      headers: { ...origin, 'X-Forwarded-For': '198.51.100.202' },
      data: { email: `exports-foreign-${randomUUID()}@test.local`, password: 'exports-test-password-123' },
    });
    expect(reg.status()).toBe(200);
    expect((await foreign.get(`/api/v1/exports/${pending.id}`)).status()).toBe(404);
    expect((await foreign.get(ready.downloadUrl)).status()).toBe(404);
    const list = await (await foreign.get('/api/v1/exports')).json();
    expect(list.data).toEqual([]);
    // A malformed origin is refused for the mutating command.
    expect((await foreign.post('/api/v1/exports', { headers: { ...headers(), Origin: 'https://untrusted.invalid' }, data: { format: 'json' } })).status()).toBe(403);
    void task;
  } finally {
    await foreign.dispose();
  }
});

test('a tampered download token is refused while a valid one is accepted', async ({ page }) => {
  await fixture(page);
  const created = await page.request.post('/api/v1/exports', { headers: headers(), data: { format: 'json' } });
  const pending = await created.json();
  await runExportGeneration(connection.db, { store });
  const ready = await (await page.request.get(`/api/v1/exports/${pending.id}`)).json();
  const url = new URL(ready.downloadUrl, 'http://localhost:3100');

  const good = await page.request.get(ready.downloadUrl);
  expect(good.status()).toBe(200);

  const [payload, sig] = (url.searchParams.get('token') ?? '').split('.');
  const tampered = `${payload}.${sig?.slice(0, -3)}AAA`;
  url.searchParams.set('token', tampered);
  expect((await page.request.get(url.toString())).status()).toBe(403);
  url.searchParams.set('token', 'garbage');
  expect((await page.request.get(url.toString())).status()).toBe(403);
  url.searchParams.delete('token');
  expect((await page.request.get(url.toString())).status()).toBe(403);
});

test('expired exports lose their file and return 410 in API and UI', async ({ page }) => {
  await fixture(page);
  const created = await page.request.post('/api/v1/exports', { headers: headers(), data: { format: 'json' } });
  const pending = await created.json();
  await runExportGeneration(connection.db, { store });
  const ready = await (await page.request.get(`/api/v1/exports/${pending.id}`)).json();

  await connection.db.execute(sql`update exports set expires_at = clock_timestamp() - interval '1 minute' where id=${pending.id}`);
  await expireExports(connection.db, { store });

  expect((await page.request.get(`/api/v1/exports/${pending.id}`)).json().then((b: { status: string }) => b.status)).resolves.toBe('EXPIRED');
  const dl = await page.request.get(ready.downloadUrl);
  expect(dl.status()).toBe(410);
  expect((await dl.json()).code).toBe('EXPORT_EXPIRED');

  await page.goto('/settings');
  await expect(page.locator('[data-export-status="EXPIRED"]')).toHaveCount(1, { timeout: 20_000 });
  await expect(page.getByRole('cell', { name: /expired/i })).toBeVisible();
});
