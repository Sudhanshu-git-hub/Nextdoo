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

it('sync cursors are persisted per workspace and never cross accounts', async () => {
  expect(await queue.getCursor(a)).toBe(0);
  await queue.setCursor(a, 41);
  await queue.setCursor(b, 7);
  expect(await queue.getCursor(a)).toBe(41);
  expect(await queue.getCursor(b)).toBe(7);
});

it('cacheTask only stores rows whose own provenance matches the workspace', async () => {
  await queue.cacheTask(a, { id: 't1', workspaceId: a } as never);
  await queue.cacheTask(a, { id: 't2', workspaceId: b } as never); // foreign row
  const rows = await queue.readCachedTasks<{ id: string; workspaceId: string }>(a);
  expect(rows.map((t) => t.id)).toEqual(['t1']);
});

it('applyPullPage applies updates and tombstones, ignores foreign payloads, and advances the cursor', async () => {
  await queue.cacheTask(a, { id: 'keep', workspaceId: a } as never);
  const page = {
    changes: [
      { sequence: 1, entityType: 'task', entityId: 'keep', operation: 'update', payload: { id: 'keep', workspaceId: a, title: 'updated' }, version: 2 },
      { sequence: 2, entityType: 'task', entityId: 'gone', operation: 'delete', payload: { id: 'gone' }, version: 3 },
      { sequence: 3, entityType: 'task', entityId: 'keep', operation: 'update', payload: { id: 'keep', workspaceId: b, title: 'foreign' }, version: 4 },
      { sequence: 4, entityType: 'project', entityId: 'p1', operation: 'update', payload: { id: 'p1', workspaceId: a }, version: 1 },
    ],
    cursor: 4,
    hasMore: false,
  };
  await queue.cacheTask(a, { id: 'gone', workspaceId: a } as never);
  const applied = await queue.applyPullPage(a, page);
  expect(applied).toEqual({ changes: 1, deletions: 1 });
  expect(await queue.getCursor(a)).toBe(4);
  const rows = await queue.readCachedTasks<{ id: string; workspaceId: string; title?: string }>(a);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.title).toBe('updated');
});

it('pullSync follows pagination until the stream is exhausted', async () => {
  let calls = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls += 1;
    const match = String(url).match(/cursor=(\d+)/);
    const cursor = match ? Number(match[1]) : 0;
    const page = cursor < 3
      ? { changes: [{ sequence: 1, entityType: 'task', entityId: 'x1', operation: 'update', payload: { id: 'x1', workspaceId: a }, version: 1 }], cursor: 3, hasMore: true }
      : { changes: [], cursor, hasMore: false };
    return new Response(JSON.stringify(page), { status: 200 });
  }));
  const result = await queue.pullSync(a);
  expect(calls).toBe(2);
  expect(result).toEqual({ changes: 1, deletions: 0 });
  expect(await queue.getCursor(a)).toBe(3);
});

it('pendingSummary splits waiting syncs from items that need attention', async () => {
  const m1 = mutation(a);
  const m2 = mutation(a, randomUUID());
  await queue.enqueue(m1);
  await queue.enqueue(m2);
  await queue.markFailed(a, m2.mutationId, '403', 'client'); // quarantined immediately
  expect(await queue.pendingSummary(a)).toEqual({ queued: 1, attention: 1 });
  expect(await queue.pendingSummary(b)).toEqual({ queued: 0, attention: 0 });
});

it('earliestRetryAt ignores quarantined items and reports the soonest due retry', async () => {
  const m1 = mutation(a);
  const m2 = mutation(a, randomUUID());
  await queue.enqueue(m1);
  await queue.enqueue(m2);
  vi.useFakeTimers({ toFake: ['Date'] });
  await queue.markFailed(a, m1.mutationId, '500', 'server'); // due at now + 1s
  vi.setSystemTime(Date.now() + 2000);
  await queue.markFailed(a, m2.mutationId, '500', 'server'); // due at now + 1s
  const soonest = await queue.earliestRetryAt(a);
  expect(soonest).not.toBeNull();
  expect(soonest).toBeLessThanOrEqual(Date.now());
  vi.setSystemTime(Date.now() + 5000);
  await queue.markFailed(a, m1.mutationId, '403', 'client'); // now quarantined
  const retained = await queue.listQueued(a, true);
  const m2row = retained.find((r) => r.mutationId === m2.mutationId);
  expect(m2row).toBeDefined();
  // Quarantined m1 must not steer the schedule; m2's backoff is the only one.
  expect(await queue.earliestRetryAt(a)).toBe(m2row?.retryAt ?? undefined);
});

it('reconcileOnce drains the queue and then pulls server changes', async () => {
  const m = mutation(a);
  await queue.enqueue(m);
  const fetchMock = vi.fn(async (url: string) => {
    if (String(url).includes('/sync/pull')) {
      return new Response(JSON.stringify({ changes: [{ sequence: 5, entityType: 'task', entityId: 'gone', operation: 'delete', payload: { id: 'gone' }, version: 2 }], cursor: 5, hasMore: false }), { status: 200 });
    }
    return new Response(JSON.stringify({ results: [{ mutationId: m.mutationId, status: 'applied' }], cursor: 5 }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  const result = await queue.reconcileOnce(a, 'device');
  expect(result.applied).toBe(1);
  expect(result.pulledDeletions).toBe(1);
  expect(result.offline).toBe(false);
  expect(await queue.listQueued(a)).toHaveLength(0);
  expect(fetchMock.mock.calls.map(([u]) => String(u))).toEqual(['/api/v1/sync/push', expect.stringContaining('/sync/pull')]);
});

it('reconcileOnce never pulls while offline but still reports the flush outcome', async () => {
  vi.stubGlobal('navigator', { onLine: false });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  const result = await queue.reconcileOnce(a, 'device');
  expect(result.offline).toBe(true);
  expect(result.pulledChanges).toBe(0);
  expect(result.pulledDeletions).toBe(0);
});
