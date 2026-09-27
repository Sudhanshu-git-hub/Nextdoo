import { randomUUID } from 'node:crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { createTrackerDefinition } from '@nextdoo/core';

const headers = () => ({ Origin: 'http://localhost:3100', 'Idempotency-Key': randomUUID() });
const password = ['security', 'fixture', 'password'].join('-');
async function register(request: APIRequestContext) {
  const result = await request.post('/api/v1/auth/register', { headers: { ...headers(), 'X-Forwarded-For': '192.0.2.240' }, data: { email: `security-${randomUUID()}@test.local`, password, timeZone: 'UTC' } });
  expect(result.status()).toBe(200); return result.json();
}
async function create(request: APIRequestContext, path: string, data: object) {
  const response = await request.post('/api/v1' + path, { headers: headers(), data });
  expect(response.status()).toBe(200); return response.json();
}

test('HTTP ownership boundaries span personal modules, attachment metadata, exports and synchronization', async ({ page, playwright }) => {
  const owner = await register(page.request);
  const stranger = await playwright.request.newContext({ baseURL: 'http://localhost:3100' });
  try {
    await register(stranger);
    const title = 'Private security sentinel ' + randomUUID();
    const task = await create(page.request, '/tasks', { workspaceId: owner.workspaceId, title });
    const goal = await create(page.request, '/goals', { workspaceId: owner.workspaceId, title });
    const tracker = await create(page.request, '/trackers', { workspaceId: owner.workspaceId, name: title, timeZone: 'UTC', startDate: '2026-01-01', definition: createTrackerDefinition() });
    const note = await create(page.request, '/knowledge/notes', { title });
    const source = await create(page.request, '/calendar/center/sources', { name: 'Security calendar', timeZone: 'UTC' });
    const event = await create(page.request, '/calendar/center/events', { sourceId: source.id, title, timeZone: 'UTC', startsAt: '2026-09-27T12:00:00Z', endsAt: '2026-09-27T13:00:00Z' });
    const attachment = await create(page.request, '/attachments', { taskId: task.id, fileName: 'private.txt', contentType: 'text/plain', sizeBytes: 4 });
    for (const path of [`/tasks/${task.id}`, `/goals/${goal.id}`, `/trackers/${tracker.id}`, `/knowledge/notes/${note.id}`, `/calendar/center/events/${event.id}`, `/attachments?taskId=${task.id}`]) {
      expect((await page.request.get('/api/v1' + path)).status()).toBe(200);
      const response = await stranger.get('/api/v1' + path);
      expect(response.status()).toBe(404); expect(await response.text()).not.toContain(title);
    }
    for (const suffix of ['/download', '/download/file?token=invalid']) expect((await stranger.get('/api/v1/attachments/' + attachment.attachment.id + suffix)).status()).toBe(404);
    expect((await stranger.patch('/api/v1/tasks/' + task.id, { headers: headers(), data: { version: 1, title: 'Attempted change' } })).status()).toBe(404);
    expect((await stranger.delete('/api/v1/tasks/' + task.id, { headers: headers() })).status()).toBe(404);
    expect((await stranger.get(`/api/v1/sync/pull?workspaceId=${owner.workspaceId}&cursor=0`)).status()).toBe(403);
    const exported = await stranger.get('/api/v1/account/export');
    expect(exported.status()).toBe(200); expect(await exported.text()).not.toContain(title);
    const insight = await stranger.get('/api/v1/insights?period=custom&from=2026-09-01&to=2026-09-30');
    expect(insight.status()).toBe(200); expect(await insight.text()).not.toContain(title);
    const denial = await stranger.post('/api/v1/account/deletion', { headers: headers(), data: { password: 'incorrect-password' } });
    expect(denial.status()).toBe(400);
    expect((await (await page.request.get('/api/v1/tasks/' + task.id)).json()).title).toBe(title);
    expect((await (await page.request.get('/api/v1/account/deletion')).json()).scheduled).toBe(false);
  } finally { await stranger.dispose(); }
});

test('production browser boundaries preserve CSP, cookies, CSRF, version/replay and session revocation', async ({ page, context }) => {
  const owner = await register(page.request);
  const response = await page.goto('/home');
  expect(response!.headers()['x-content-type-options']).toBe('nosniff');
  expect(response!.headers()['x-frame-options']).toBe('SAMEORIGIN');
  expect(response!.headers()['referrer-policy']).toBe('strict-origin-when-cross-origin');
  expect(response!.headers()['cache-control']).toContain('no-store');
  expect(response!.headers()['strict-transport-security']).toContain('max-age=31536000');
  const csp = response!.headers()['content-security-policy'] ?? '';
  expect(csp).toContain("object-src 'none'"); expect(csp).toContain("frame-ancestors 'self'");
  expect(csp.match(/script-src[^;]+/)![0]).not.toContain('unsafe-inline');
  const nonce = /'nonce-([^']+)'/.exec(csp)![1];
  expect(await page.locator('script[nonce]').first().evaluate(node => (node as HTMLScriptElement).nonce)).toBe(nonce);
  const cookie = (await context.cookies()).find(value => value.name === 'nextdoo_session')!;
  expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });
  const task = await create(page.request, '/tasks', { workspaceId: owner.workspaceId, title: 'Security workflow' });
  const path = '/api/v1/tasks/' + task.id, data = { version: 1, title: 'Saved securely' }, identity = headers();
  expect((await page.request.patch(path, { headers: { ...identity, Origin: 'https://foreign.invalid' }, data })).status()).toBe(403);
  expect((await page.request.patch(path, { headers: { Origin: identity.Origin, 'Idempotency-Key': 'x'.repeat(129) }, data })).status()).toBe(400);
  const saved = await page.request.patch(path, { headers: identity, data }); expect(saved.status()).toBe(200);
  const replay = await page.request.patch(path, { headers: identity, data }); expect(replay.headers()['idempotent-replay']).toBe('true'); expect(await replay.json()).toEqual(await saved.json());
  expect((await page.request.patch(path, { headers: headers(), data })).status()).toBe(409);
  expect((await page.request.get('/api/v1/tasks/' + randomUUID())).status()).toBe(404);
  expect((await page.request.delete(path, { headers: headers() })).status()).toBe(200);
  expect((await page.request.get(path)).status()).toBe(404);
  expect((await page.request.post('/api/v1/auth/logout-all', { headers: headers() })).status()).toBe(200);
  for (const endpoint of ['/account/export', '/account/deletion', '/insights', '/sync/pull', '/attachments?taskId=' + task.id]) expect((await page.request.get('/api/v1' + endpoint)).status()).toBe(401);
  const callback = await page.request.get('/api/v1/calendar/connections/google/callback?state=unknown&code=unknown&returnTo=https://foreign.invalid', { maxRedirects: 0 });
  expect(callback.status()).toBe(307);
  expect(callback.headers().location).toBe('http://localhost:3100/settings?calendar=error=sign_in_failed');
});
