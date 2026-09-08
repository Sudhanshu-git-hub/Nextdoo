'use client';

/** Scoped durable queue safety; the full offline capture/pull UX is not wired. */
const DB_NAME = 'nextdoo';
const STORE_MUTATIONS = 'mutations_v2';
const STORE_TASKS = 'tasks';
export interface QueuedMutation {
  workspaceId: string;
  mutationId: string;
  entityType: 'task';
  entityId: string;
  operation: 'create' | 'update' | 'delete';
  baseVersion: number | null;
  payload: Record<string, unknown>;
  createdAt: string;
  localOrder?: number;
  attempts: number;
  retries?: number;
  retryAt?: number;
  quarantined?: boolean;
  lastError?: string;
}
let dbPromise: Promise<IDBDatabase> | null = null;
const pending = new Map<string, number>();
export function pendingCount(workspaceId: string): number { return pending.get(workspaceId) ?? 0; }
function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IndexedDB unavailable'));
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      // Unscoped legacy "mutations" are deliberately retained but NEVER sent
      // under a guessed owner. Recover them only after explicit user review.
      if (!db.objectStoreNames.contains(STORE_MUTATIONS)) {
        const store = db.createObjectStore(STORE_MUTATIONS, { keyPath: 'localOrder', autoIncrement: true });
        store.createIndex('identity', ['workspaceId', 'mutationId'], { unique: true });
      }
      if (!db.objectStoreNames.contains(STORE_TASKS)) db.createObjectStore(STORE_TASKS, { keyPath: 'id' });
    };
    request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); dbPromise = null; }; resolve(request.result); };
    request.onerror = () => { dbPromise = null; reject(request.error); };
    request.onblocked = () => { dbPromise = null; reject(new Error('Close older NEXTDOO tabs to upgrade local storage safely.')); };
  });
  return dbPromise;
}
async function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store, mode);
    const request = fn(transaction.objectStore(store));
    // Request success is not transaction success: quota/abort can still fail.
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error('Local transaction aborted'));
  });
}
async function change(workspaceId: string, mutationId: string, update: (current?: QueuedMutation) => QueuedMutation | null): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_MUTATIONS, 'readwrite');
    const store = transaction.objectStore(STORE_MUTATIONS);
    const found = store.index('identity').get([workspaceId, mutationId]);
    found.onsuccess = () => {
      const current = found.result as QueuedMutation | undefined;
      const next = update(current);
      if (next) store.put(next);
      else if (current?.localOrder !== undefined) store.delete(current.localOrder);
    };
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error('Local transaction aborted'));
  });
  await refreshCount(workspaceId);
}
export async function enqueue(mutation: Omit<QueuedMutation, 'attempts' | 'createdAt' | 'localOrder' | 'retries' | 'retryAt' | 'quarantined' | 'lastError'>): Promise<void> {
  if (!mutation.workspaceId) throw new Error('Workspace provenance is required for offline mutations.');
  await change(mutation.workspaceId, mutation.mutationId, (current) => current ?? { ...mutation, attempts: 0, createdAt: new Date().toISOString() });
}
export async function listQueued(workspaceId: string, includeAttention = false): Promise<QueuedMutation[]> {
  const all = await tx<QueuedMutation[]>(STORE_MUTATIONS, 'readonly', (s) => s.getAll());
  return all.filter((m) => m.workspaceId === workspaceId && (includeAttention || !m.quarantined));
}
export async function dequeue(workspaceId: string, mutationId: string): Promise<void> { await change(workspaceId, mutationId, () => null); }
export async function markFailed(workspaceId: string, mutationId: string, error: string, kind: 'network' | 'server' | 'client' = 'server'): Promise<void> {
  await change(workspaceId, mutationId, (current) => {
    if (!current) return null;
    const attempts = current.attempts + (kind === 'server' ? 1 : 0);
    const retries = (current.retries ?? 0) + 1;
    const delay = Math.min(300000, 1000 * 2 ** Math.min(retries - 1, 9));
    return { ...current, attempts, retries, lastError: error, quarantined: kind === 'client' || attempts >= 5,
      retryAt: Date.now() + Math.floor(delay * (0.8 + Math.random() * 0.2)) };
  });
}
export async function refreshCount(workspaceId: string): Promise<void> {
  pending.set(workspaceId, (await listQueued(workspaceId, true)).length);
}
export async function cacheTasks(workspaceId: string, tasks: Array<{ workspaceId: string }>): Promise<void> {
  try {
    const db = await openDb();
    const transaction = db.transaction(STORE_TASKS, 'readwrite');
    const store = transaction.objectStore(STORE_TASKS);
    for (const task of tasks) if (task.workspaceId === workspaceId) store.put(task);
  } catch {
    /* cache is best-effort */
  }
}

export async function readCachedTasks<T extends { workspaceId: string }>(workspaceId: string): Promise<T[]> {
  try {
    const records = await tx<T[]>(STORE_TASKS, 'readonly', (s) => s.getAll() as IDBRequest<T[]>);
    // A browser profile is not an account boundary. Never expose legacy rows
    // without workspace provenance, or rows from another authenticated account.
    return records.filter((record) => record.workspaceId === workspaceId);
  } catch {
    return [];
  }
}

export interface FlushResult { applied: number; conflicts: number; rejected: number }
const inFlight = new Map<string, Promise<FlushResult>>();
export function flushQueue(workspaceId: string, deviceId: string): Promise<FlushResult> {
  const active = inFlight.get(workspaceId);
  if (active) return active;
  const execute = () => flush(workspaceId, deviceId);
  const result = (navigator.locks ? navigator.locks.request(`nextdoo-sync:${workspaceId}`, execute) : execute())
    .finally(() => inFlight.delete(workspaceId));
  inFlight.set(workspaceId, result);
  return result;
}
async function flush(workspaceId: string, deviceId: string): Promise<FlushResult> {
  const result: FlushResult = { applied: 0, conflicts: 0, rejected: 0 };
  if (!navigator.onLine) return result;
  const queued = await listQueued(workspaceId, true);
  // Only each entity's oldest pending command is eligible. Failed/quarantined
  // heads block followers; independent entities can make progress.
  const seen = new Set<string>();
  const batch = queued.filter((m) => {
    if (seen.has(m.entityId)) return false;
    seen.add(m.entityId);
    return !m.quarantined && (m.retryAt ?? 0) <= Date.now();
  }).slice(0, 200);
  if (!batch.length) return result;
  let response: Response;
  try {
    response = await fetch('/api/v1/sync/push', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      workspaceId, deviceId, mutations: batch.map(({ mutationId, entityType, entityId, operation, baseVersion, payload, createdAt }) => ({ mutationId, entityType, entityId, operation, baseVersion, payload, createdAt })),
    }) });
  } catch {
    for (const m of batch) await markFailed(workspaceId, m.mutationId, 'Network unavailable', 'network');
    return result;
  }
  if (!response.ok) {
    const kind = response.status === 429 ? 'network' : response.status >= 500 ? 'server' : 'client';
    for (const m of batch) await markFailed(workspaceId, m.mutationId, `Sync HTTP ${response.status}`, kind);
    return result;
  }
  try {
    const body = await response.json();
    if (!Array.isArray(body.results)) throw new Error('Invalid sync response');
    for (const m of batch) {
      const reply = body.results.find((r: { mutationId?: string }) => r.mutationId === m.mutationId);
      if (reply?.status === 'applied' || reply?.status === 'duplicate') { await dequeue(workspaceId, m.mutationId); result.applied++; }
      else if (reply?.status === 'conflict' || reply?.status === 'rejected') {
        await markFailed(workspaceId, m.mutationId, `Needs attention: ${reply.status}`, 'client');
        if (reply.status === 'conflict') result.conflicts++; else result.rejected++;
      } else await markFailed(workspaceId, m.mutationId, 'Missing canonical acknowledgement', 'server');
    }
  } catch {
    for (const m of batch) await markFailed(workspaceId, m.mutationId, 'Invalid sync response', 'server');
  }
  return result;
}
export function getDeviceId(): string {
  const KEY = 'nextdoo_device_id';
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
  }
  return id;
}

