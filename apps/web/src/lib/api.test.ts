import { afterEach, expect, it, vi } from 'vitest';
import { api } from './api';
afterEach(() => vi.unstubAllGlobals());
it.each([
  { 'idempotency-key': 'stable-retry-key' },
  new Headers({ 'Idempotency-Key': 'stable-retry-key' }),
  [['Idempotency-Key', 'stable-retry-key']],
] satisfies HeadersInit[])('preserves explicit mutation identity for each supported HeadersInit form %#', async (headers) => {
  const send = vi.fn(async (_url: string, init: RequestInit) => {
    expect(new Headers(init.headers).get('Idempotency-Key')).toBe('stable-retry-key');
    return Response.json({ ok: true });
  });
  vi.stubGlobal('fetch', send);
  await api('/tasks', { method: 'POST', headers });
  expect(send).toHaveBeenCalledOnce();
});
