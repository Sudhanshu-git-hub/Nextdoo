import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';

test('unauthenticated users cannot enter the app or query tasks', async ({ page, request }) => {
  await page.goto('/today');
  await expect(page).toHaveURL(/\/login$/);
  const response = await request.get(`/api/v1/tasks?workspaceId=${randomUUID()}`);
  expect(response.status()).toBe(401);
  expect((await response.json()).code).toBe('UNAUTHENTICATED');
});

test('register, capture using keyboard, complete, and review real persisted work', async ({ page }) => {
  await page.goto('/register');
  await page.getByLabel('Email', { exact: true }).fill(`e2e-${randomUUID()}@test.local`);
  await page.getByLabel('Password', { exact: true }).fill('e2e-only-password-123');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page).toHaveURL(/\/today$/);
  const title = `Review ${randomUUID()}`;
  await page.keyboard.press('n');
  await expect(page.locator('#capture')).toBeFocused();
  await page.locator('#capture').fill(`${title} today at 11:59pm for 30 minutes`);
  await page.locator('#capture').press('Enter');
  await expect(page.getByText(title, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: `Complete "${title}"`, exact: true }).click();
  await expect(page.getByText(title, { exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: /Analytics/ }).click();
  await expect(page.getByText('1 of 1 planned', { exact: true })).toBeVisible();
  await expect(page.getByText('Execution score', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: /Settings/ }).click();
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
});

test('focus displays a numeric server-based clock through pause and resume', async ({ page }) => {
  await page.goto('/register');
  await page.getByLabel('Email', { exact: true }).fill(`focus-${randomUUID()}@test.local`);
  await page.getByLabel('Password', { exact: true }).fill('e2e-only-password-123');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page).toHaveURL(/\/today$/);
  const title = `Focus ${randomUUID()}`;
  await page.locator('#capture').fill(`${title} today at 11:59pm for 30 minutes`);
  await page.locator('#capture').press('Enter');
  await expect(page.getByText(title, { exact: true })).toBeVisible();
  await page.getByRole('link', { name: /Focus/ }).click();
  await page.getByRole('button', { name: `Start a focus timer for ${title}`, exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await expect(page.getByRole('timer')).toHaveText(/^\d{2}:\d{2}:\d{2}$/);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
  await expect(page.getByRole('timer')).toHaveText(/^\d{2}:\d{2}:\d{2}$/);
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await expect(page.getByRole('timer')).toHaveText(/^\d{2}:\d{2}:\d{2}$/);
  await page.getByRole('button', { name: 'Stop and save', exact: true }).click();
  await expect(page.getByText('No timer running', { exact: true })).toBeVisible();
});

test('switching accounts cannot expose another workspace cache during a network failure', async ({ page, context }) => {
  const register = async () => {
    await page.goto('/register');
    await page.getByLabel('Email', { exact: true }).fill(`cache-${randomUUID()}@test.local`);
    await page.getByLabel('Password', { exact: true }).fill('e2e-only-password-123');
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
    await expect(page).toHaveURL(/\/today$/);
  };
  await register();
  const secret = `Private ${randomUUID()}`;
  await page.locator('#capture').fill(`${secret} today at 11:59pm for 30 minutes`);
  await page.locator('#capture').press('Enter');
  await expect(page.getByRole('button', { name: `Complete "${secret}"`, exact: true })).toBeVisible();
  // Same browser/IndexedDB, but a different authenticated account. Fault only
  // the task API: account creation and authentication still use the real server.
  await context.clearCookies();
  await page.route('**/api/v1/tasks?**', (route) => route.abort('failed'));
  await register();
  await expect(page.getByText(/Could not load your tasks|Showing your last saved copy/)).toBeVisible();
  await expect(page.getByText(secret, { exact: true })).toHaveCount(0);
});

test('unsupported recurring capture preserves the original text instead of silently creating a one-off task', async ({ page }) => {
  await page.goto('/register');
  await page.getByLabel('Email', { exact: true }).fill(`recurrence-${randomUUID()}@test.local`);
  await page.getByLabel('Password', { exact: true }).fill('e2e-only-password-123');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page).toHaveURL(/\/today$/);
  const text = `Practice ${randomUUID()} every day today at 11:59pm for 30 minutes`;
  await page.locator('#capture').fill(text);
  await page.locator('#capture').press('Enter');
  await expect(page.getByText('Recurring task creation is not implemented yet. No task was created.', { exact: true })).toBeVisible();
  await expect(page.locator('#capture')).toHaveValue(text);
});

test('login backoff survives client IP changes', async ({ page }) => {
  const email = `backoff-${randomUUID()}@test.local`;
  await page.goto('/register');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill('e2e-only-password-123');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page).toHaveURL(/\/today$/);
  const attempt = (ip: string) => page.request.post('/api/v1/auth/login', {
    headers: { Origin: 'http://localhost:3100', 'X-Forwarded-For': ip }, data: { email, password: 'wrong-password-123' },
  });
  expect((await attempt('192.0.2.1')).status()).toBe(401);
  const blocked = await attempt('192.0.2.2');
  expect(blocked.status()).toBe(429);
  expect(Number(blocked.headers()['retry-after'])).toBeGreaterThan(0);
});

test('security headers protect the rendered login page', async ({ page }) => {
  expect((await page.request.get('/api/v1/health')).headers()['x-request-id']).toBeTruthy();
  const response = await page.goto('/login');
  expect(response!.headers()['content-security-policy']).toContain("'nonce-");
  expect(response!.headers()['content-security-policy']).not.toContain("script-src 'self' 'unsafe-inline'");
  expect(response!.headers()['strict-transport-security']).toContain('max-age=');
});

test('existing API paths validate resource IDs and replay timer creation without another session', async ({ request }) => {
  const headers = { Origin: 'http://localhost:3100' };
  const registered = await request.post('/api/v1/auth/register', { headers, data: { email: `api-${randomUUID()}@test.local`, password: 'e2e-only-password-123', timeZone: 'UTC' } });
  expect(registered.status()).toBe(200);
  const { workspaceId } = await registered.json();
  const task = await request.post('/api/v1/tasks', { headers: { ...headers, 'Idempotency-Key': randomUUID() }, data: { workspaceId, title: 'Timer replay' } });
  expect(task.status()).toBe(200);
  const { id } = await task.json(), key = randomUUID();
  const start = () => request.post('/api/v1/timers', { headers: { ...headers, 'Idempotency-Key': key }, data: { taskId: id, deviceId: 'test' } });
  const first = await start(), replay = await start();
  expect(first.status()).toBe(200); expect(replay.status()).toBe(200);
  expect((await replay.json()).id).toBe((await first.json()).id);
  expect((await request.get('/api/v1/tasks/not-a-uuid')).status()).toBe(400);
});

test('exports have request IDs, no-store headers and a durable per-account quota', async ({ request }) => {
  const registered = await request.post('/api/v1/auth/register', { headers: { Origin: 'http://localhost:3100' }, data: { email: `export-${randomUUID()}@test.local`, password: 'e2e-only-password-123', timeZone: 'UTC' } });
  expect(registered.status()).toBe(200);
  const first = await request.get('/api/v1/account/export');
  expect(first.status()).toBe(200);
  expect(first.headers()['cache-control']).toContain('no-store');
  expect(JSON.stringify(await first.json())).not.toContain('passwordHash');
  expect((await request.get('/api/v1/account/export')).status()).toBe(200);
  expect((await request.get('/api/v1/account/export')).status()).toBe(200);
  const fourth = await request.get('/api/v1/account/export');
  expect(fourth.status()).toBe(429); expect(fourth.headers()['retry-after']).toBeTruthy();
  expect(first.headers()['x-request-id']).toBeTruthy();
});

for (const structured of ['#important', '+Work']) {
  test(`unsupported structured capture retains original ${structured} intent`, async ({ page }) => {
    await page.goto('/register');
    await page.getByLabel('Email', { exact: true }).fill(`structured-${randomUUID()}@test.local`);
    await page.getByLabel('Password', { exact: true }).fill('e2e-only-password-123');
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
    await expect(page).toHaveURL(/\/today$/);
    const text = `Prepare ${randomUUID()} today at 11:59pm for 30 minutes ${structured}`;
    await page.locator('#capture').fill(text); await page.locator('#capture').press('Enter');
    await expect(page.getByRole('alert').filter({ hasText: 'Tag and project capture' })).toHaveText('Tag and project capture cannot be saved yet. No task was created; your original text is kept in the input.');
    await expect(page.locator('#capture')).toHaveValue(text);
    const bundle = await (await page.request.get('/api/v1/account/export')).json();
    expect(bundle.tasks).toEqual([]);
  });
}
