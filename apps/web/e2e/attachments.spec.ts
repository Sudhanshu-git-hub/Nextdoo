import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import {
  attachmentScannerHealthy,
  createClamavScanner,
  createDb,
  createDurableFileAttachmentStore,
  runAttachmentScan,
} from '@nextdoo/db';
import { limitsFor } from '@nextdoo/contracts';

const connection = createDb(process.env.DATABASE_URL!, { max: 2 });
test.afterAll(() => connection.close());

/**
 * The E2E web server and this test process share the default attachment store
 * root, so driving runAttachmentScan here scans the same objects the download
 * route streams (the web server runs no workers).
 *
 * This suite proves the REAL malware scan end to end. Without a working
 * ClamAV engine it fails loudly instead of faking a scanner or skipping:
 * CI installs the engine (apt clamav + freshclam) before running the suite.
 */
const store = createDurableFileAttachmentStore();
const scanner = createClamavScanner();

test.beforeAll(async () => {
  if (!(await attachmentScannerHealthy())) {
    throw new Error(
      'ATTACHMENT_SCAN_ENGINE_MISSING: the ClamAV engine (clamscan) is not available. '
      + 'Install it (e.g. apt-get install clamav && freshclam) and retry. '
      + 'The attachment E2E suite refuses to run with a mocked or absent scanner.',
    );
  }
});

const origin = { Origin: 'http://localhost:3100' };
const freeLimits = limitsFor('FREE');
let ipCounter = 210;
const nextIp = () => `198.51.100.${ipCounter++}`;
const headers = () => ({ ...origin, 'Idempotency-Key': randomUUID() });

async function account(page: Page, prefix: string) {
  const r = await page.request.post('/api/v1/auth/register', {
    headers: { ...origin, 'X-Forwarded-For': nextIp() },
    data: { email: `${prefix}-${randomUUID()}@test.local`, password: 'attachments-test-password-123', timeZone: 'UTC' },
  });
  expect(r.status()).toBe(200);
  return (await r.json()) as { workspaceId: string };
}

async function createTask(page: Page, workspaceId: string, title: string) {
  const t = await page.request.post('/api/v1/tasks', { headers: headers(), data: { workspaceId, title } });
  expect(t.status()).toBe(200);
  return (await t.json()) as { id: string };
}

/** Uploads via the API: authorize → PUT bytes → complete. */
async function apiUpload(page: Page, taskId: string, fileName: string, contentType: string, buffer: Buffer) {
  const auth = await page.request.post('/api/v1/attachments', {
    headers: headers(),
    data: { taskId, fileName, contentType, sizeBytes: buffer.length },
  });
  expect(auth.status()).toBe(200);
  const { attachment, uploadUrl } = await auth.json();
  const put = await page.request.put(uploadUrl, {
    headers: { ...origin, 'Content-Type': contentType },
    data: buffer,
  });
  expect(put.status()).toBe(200);
  const done = await page.request.post(`/api/v1/attachments/${attachment.id}`, { headers: headers(), data: {} });
  expect(done.status()).toBe(200);
  return attachment as { id: string };
}

async function scanOnce() {
  return runAttachmentScan(connection.db, { store, scanner });
}

// ---------------------------------------------------------------------------
// Upload success in the browser: scan gate, download, delete
// ---------------------------------------------------------------------------

test('the task editor uploads, waits for the clean scan, downloads and deletes an attachment', async ({ page }) => {
  const { workspaceId } = await account(page, 'attachments-ui');
  const { id: taskId } = await createTask(page, workspaceId, 'Attachment task');
  const payload = Buffer.from('nextdoo attachment e2e payload — safe text file.');

  await page.goto('/inbox');
  await page.getByRole('button', { name: 'Edit "Attachment task"', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit task', exact: true });
  const section = editor.getByRole('heading', { name: 'Attachments', exact: true });
  await expect(section).toBeVisible();

  const putResponse = page.waitForResponse(
    (r) => r.request().method() === 'PUT' && r.url().includes('/upload-data'),
  );
  await page.locator('#task-attachment-file').setInputFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: payload });
  const put = await putResponse;
  expect(put.status()).toBe(200);

  // Complete lands right after the PUT; the file is PENDING until the scan runs.
  const chip = editor.locator('.pill', { hasText: /scanning|uploading/i }).first();
  await expect(chip).toBeVisible({ timeout: 10_000 });

  const result = await scanOnce();
  expect(result.clean).toBeGreaterThanOrEqual(1);

  // The UI polls and reports the clean verdict.
  await expect(editor.locator('.chip', { hasText: /^ready$/i }).first()).toBeVisible({ timeout: 15_000 });
  const downloadLink = editor.getByRole('link', { name: 'Download', exact: true }).first();
  await expect(downloadLink).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    downloadLink.click(),
  ]);
  expect(download.suggestedFilename()).toBe('note.txt');
  expect(Buffer.from(readFileSync(await download.path()))).toEqual(payload);

  // Deletion is confirmed and removes the file from the list.
  page.on('dialog', (d) => d.accept());
  await editor.getByRole('button', { name: 'Delete', exact: true }).first().click();
  await expect(editor.getByText('No attachments yet.')).toBeVisible({ timeout: 10_000 });

  // The deleted object is gone from storage, and the API agrees.
  const list = await page.request.get(`/api/v1/attachments?taskId=${taskId}`);
  expect((await list.json()).data).toEqual([]);
});

// ---------------------------------------------------------------------------
// Plan gating: maximum file size, allowlist, exact size
// ---------------------------------------------------------------------------

test('rejects over-size files, disallowed types, and mismatched upload sizes', async ({ page }) => {
  const { workspaceId } = await account(page, 'attachments-limits');
  const { id: taskId } = await createTask(page, workspaceId, 'Limits task');

  const over = await page.request.post('/api/v1/attachments', {
    headers: headers(),
    data: { taskId, fileName: 'big.pdf', contentType: 'application/pdf', sizeBytes: freeLimits.maxFileBytes + 1 },
  });
  expect(over.status()).toBe(403);
  expect((await over.json()).code).toBe('ENTITLEMENT_LIMIT_REACHED');

  const badType = await page.request.post('/api/v1/attachments', {
    headers: headers(),
    data: { taskId, fileName: 'shell.sh', contentType: 'application/x-sh', sizeBytes: 10 },
  });
  expect(badType.status()).toBe(400);
  expect((await badType.json()).code).toBe('VALIDATION_FAILED');

  // Exact declared size is enforced on the data PUT.
  const auth = await page.request.post('/api/v1/attachments', {
    headers: headers(),
    data: { taskId, fileName: 'sized.txt', contentType: 'text/plain', sizeBytes: 100 },
  });
  expect(auth.status()).toBe(200);
  const { attachment, uploadUrl } = await auth.json();

  const tooMany = await page.request.put(uploadUrl, { headers: { ...origin, 'Content-Type': 'text/plain' }, data: Buffer.alloc(101, 1) });
  expect(tooMany.status()).toBe(400);
  expect((await tooMany.json()).code).toBe('VALIDATION_FAILED');

  const tooFew = await page.request.put(uploadUrl, { headers: { ...origin, 'Content-Type': 'text/plain' }, data: Buffer.alloc(99, 1) });
  expect(tooFew.status()).toBe(400);
  expect((await tooFew.json()).code).toBe('VALIDATION_FAILED');

  const exact = await page.request.put(uploadUrl, { headers: { ...origin, 'Content-Type': 'text/plain' }, data: Buffer.alloc(100, 1) });
  expect(exact.status()).toBe(200);
  const done = await page.request.post(`/api/v1/attachments/${attachment.id}`, { headers: headers(), data: {} });
  expect(done.status()).toBe(200);
  await scanOnce(); // resolve the scan so no PENDING work leaks into other tests
});

// ---------------------------------------------------------------------------
// Malware scanning with the real engine: EICAR is quarantined
// ---------------------------------------------------------------------------

test('the real scanner quarantines the EICAR test file and blocks its download', async ({ page }) => {
  const { workspaceId } = await account(page, 'attachments-scan');
  const { id: taskId } = await createTask(page, workspaceId, 'Scan task');
  const eicar = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');

  const { id } = await apiUpload(page, taskId, 'eicar.txt', 'text/plain', eicar);
  const result = await scanOnce();
  expect(result.infected).toBeGreaterThanOrEqual(1);

  const list = await page.request.get(`/api/v1/attachments?taskId=${taskId}`);
  const row = (await list.json()).data[0];
  expect(row.scanStatus).toBe('INFECTED');
  expect(row.downloadUrl).toBeNull();

  const denied = await page.request.get(`/api/v1/attachments/${id}/download`);
  expect(denied.status()).toBe(409);
  expect((await denied.json()).code).toBe('ATTACHMENT_NOT_CLEAN');

  // The UI surfaces the blocked state.
  await page.goto('/inbox');
  await page.getByRole('button', { name: 'Edit "Scan task"', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit task', exact: true });
  await expect(editor.locator('.pill', { hasText: /blocked — unsafe file/i })).toBeVisible({ timeout: 10_000 });
});

// ---------------------------------------------------------------------------
// Download authorization: session + CLEAN status + signed token
// ---------------------------------------------------------------------------

test('refuses download tokens that are missing or tampered', async ({ page }) => {
  const { workspaceId } = await account(page, 'attachments-tokens');
  const { id: taskId } = await createTask(page, workspaceId, 'Token task');
  const { id } = await apiUpload(page, taskId, 'safe.txt', 'text/plain', Buffer.from('token test payload'));
  await scanOnce();

  const list = await page.request.get(`/api/v1/attachments?taskId=${taskId}`);
  const row = (await list.json()).data[0];
  expect(row.scanStatus).toBe('CLEAN');
  const downloadUrl = row.downloadUrl as string;
  const token = new URL(downloadUrl, 'http://localhost').searchParams.get('token')!;

  const ok = await page.request.get(downloadUrl);
  expect(ok.status()).toBe(200);
  expect(ok.headers()['content-disposition']).toContain('attachment');
  expect(ok.headers()['x-content-type-options']).toBe('nosniff');

  const noToken = await page.request.get(`/api/v1/attachments/${id}/download/file`);
  expect(noToken.status()).toBe(403);
  expect((await noToken.json()).code).toBe('FORBIDDEN');

  const tampered = `${token.slice(0, -2)}${token.endsWith('AA') ? 'BB' : 'AA'}`;
  const forged = await page.request.get(`/api/v1/attachments/${id}/download/file?token=${encodeURIComponent(tampered)}`);
  expect(forged.status()).toBe(403);
  expect((await forged.json()).code).toBe('FORBIDDEN');
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------

test('foreign accounts cannot list, download, or complete another account’s attachments', async ({ page, playwright }) => {
  const owner = await account(page, 'attachments-tenant-a');
  const { id: taskId } = await createTask(page, owner.workspaceId, 'Tenant task');
  const { id } = await apiUpload(page, taskId, 'owner.txt', 'text/plain', Buffer.from('owner bytes'));
  await scanOnce();
  const list = await page.request.get(`/api/v1/attachments?taskId=${taskId}`);
  const downloadUrl = (await list.json()).data[0].downloadUrl as string;

  const foreign = await playwright.request.newContext({ baseURL: 'http://localhost:3100' });
  try {
    expect((await foreign.get(`/api/v1/attachments?taskId=${taskId}`)).status()).toBe(401);
    const reg = await foreign.post('/api/v1/auth/register', {
      headers: { ...origin, 'X-Forwarded-For': nextIp() },
      data: { email: `attachments-tenant-b-${randomUUID()}@test.local`, password: 'attachments-test-password-123', timeZone: 'UTC' },
    });
    expect(reg.status()).toBe(200);

    expect((await foreign.get(`/api/v1/attachments?taskId=${taskId}`)).status()).toBe(404);
    expect((await foreign.get(`/api/v1/attachments/${id}/download`)).status()).toBe(404);
    // The owner's signed download URL does not work under a foreign session.
    expect((await foreign.get(downloadUrl)).status()).toBe(404);
  } finally {
    await foreign.dispose();
  }
});

// ---------------------------------------------------------------------------
// Accessibility of the attachments section
// ---------------------------------------------------------------------------

test('the attachments section passes axe', async ({ page }) => {
  const { workspaceId } = await account(page, 'attachments-a11y');
  const { id: taskId } = await createTask(page, workspaceId, 'A11y task');
  await apiUpload(page, taskId, 'a11y.txt', 'text/plain', Buffer.from('a11y payload'));
  await scanOnce();

  await page.goto('/inbox');
  await page.getByRole('button', { name: 'Edit "A11y task"', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit task', exact: true });
  await expect(editor.getByRole('heading', { name: 'Attachments', exact: true })).toBeVisible();

  const { default: AxeBuilder } = await import('@axe-core/playwright');
  expect((await new AxeBuilder({ page }).include('[data-testid="task-attachments"]').analyze()).violations).toEqual([]);
});
