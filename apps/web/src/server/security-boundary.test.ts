import { afterEach, expect, it, vi } from 'vitest';
import { publicRoute } from './http';
import { redact } from './observability';
import { sendMail } from './mailer';
const handler = publicRoute({ routeName: 'test.security', rateLimitPerMinute: 100 }, async () => ({ performed: true }));
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
it('rejects foreign Origin and opaque-origin mutations before performing an action', async () => {
  for (const origin of ['https://evil.invalid', 'null']) {
    const response = await handler(new Request('https://nextdoo.test/api/v1/action', { method: 'POST', headers: { Origin: origin } }));
    expect(response.status).toBe(403);
  }
});
it('rejects cross-site fetch metadata without Origin but permits a same-origin JSON request', async () => {
  expect((await handler(new Request('https://nextdoo.test/api/v1/action', { method: 'POST', headers: { 'Sec-Fetch-Site': 'cross-site' } }))).status).toBe(403);
  expect((await handler(new Request('https://nextdoo.test/api/v1/action', { method: 'POST', headers: { Origin: 'https://nextdoo.test', 'Content-Type': 'application/json' } }))).status).toBe(200);
});
it('production logging redacts credentials inside URLs and driver error strings', () => {
  vi.stubEnv('NODE_ENV', 'production');
  const result = JSON.stringify(redact({ url: 'https://app.test/reset?token=SECRET', error: 'Failed query parameters: PRIVATE', nested: { mfaSecretEncrypted: 'CIPHER' } }));
  expect(result).not.toContain('SECRET'); expect(result).not.toContain('PRIVATE'); expect(result).not.toContain('CIPHER');
});
it('unconfigured production mail never logs raw credentials or claims delivery', async () => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('DATABASE_URL', process.env.DATABASE_URL ?? 'postgres://unused/unit');
  vi.stubEnv('AUTH_SECRET', process.env.AUTH_SECRET ?? 'unit-test-not-used-to-connect-123456789');
  const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
  await expect(sendMail('reset-password', 'private@test.local', 'https://app.test/reset?token=SECRET')).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  expect(JSON.stringify(logs.mock.calls)).not.toContain('SECRET');
});
