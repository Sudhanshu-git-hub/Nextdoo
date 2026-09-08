import { randomUUID } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
let queue: typeof import('./offline-queue');
const a = randomUUID(), b = randomUUID();
const mutation = (workspaceId = a, entityId = randomUUID(), mutationId = randomUUID()) => ({ workspaceId, entityId, mutationId, entityType: 'task' as const, operation: 'create' as const, baseVersion: null, payload: { title: 'Private offline content' } });
beforeEach(async () => {
  vi.resetModules(); vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('navigator', { onLine: true });
  queue = await import('./offline-queue');
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it('queue records are workspace-scoped and cannot be flushed under another account', async () => {
  const m = mutation(a); await queue.enqueue(m);
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  expect(await queue.listQueued(b)).toHaveLength(0);
  await queue.flushQueue(b, 'test'); expect(fetch).not.toHaveBeenCalled();
  expect(await queue.listQueued(a)).toHaveLength(1);
});
it('local insertion order is FIFO, not UUID order', async () => {
  const first = mutation(a, randomUUID(), 'ffffffff-ffff-4fff-8fff-ffffffffffff');
  const second = mutation(a, first.entityId, '00000000-0000-4000-8000-000000000001');
  await queue.enqueue(first); await queue.enqueue(second);
  expect((await queue.listQueued(a)).map((m) => m.mutationId)).toEqual([first.mutationId, second.mutationId]);
});
it('failed entity heads block their followers and network failures never quarantine content', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const first = mutation(), second = mutation(a, first.entityId);
  await queue.enqueue(first); await queue.enqueue(second);
  const fetch = vi.fn().mockRejectedValue(new TypeError('network unavailable')); vi.stubGlobal('fetch', fetch);
  for (let i = 0; i < 7; i++) { await queue.flushQueue(a, 'test'); vi.setSystemTime(Date.now() + 600000); }
  expect(await queue.listQueued(a)).toHaveLength(2);
  for (const [, init] of fetch.mock.calls) expect(JSON.parse(init.body).mutations).toHaveLength(1);
});
it('rejected and conflicted payloads stay locally recoverable instead of being deleted', async () => {
  const m = mutation(); await queue.enqueue(m);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ results: [{ mutationId: m.mutationId, status: 'rejected' }] }), { status: 200 })));
  await queue.flushQueue(a, 'test');
  const retained = await queue.listQueued(a, true);
  expect(retained).toHaveLength(1); expect(retained[0]?.payload).toEqual(m.payload); expect(retained[0]?.quarantined).toBe(true);
});
it('HTTP 4xx needs attention immediately, not deletion or blind retries', async () => {
  await queue.enqueue(mutation());
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 403 })));
  await queue.flushQueue(a, 'test');
  expect((await queue.listQueued(a, true))[0]?.quarantined).toBe(true);
});
it('acknowledges only submitted IDs and sends an explicit workspace boundary', async () => {
  const own = mutation(a), foreign = mutation(b); await queue.enqueue(own); await queue.enqueue(foreign);
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ results: [{ mutationId: own.mutationId, status: 'applied' }, { mutationId: foreign.mutationId, status: 'applied' }] }), { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  await queue.flushQueue(a, 'test');
  expect(JSON.parse(fetch.mock.calls[0]![1].body).workspaceId).toBe(a);
  expect(await queue.listQueued(b)).toHaveLength(1); expect(await queue.listQueued(a)).toHaveLength(0);
});
