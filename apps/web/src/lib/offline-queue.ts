'use client';

/**
 * Client offline mutation queue (PRD §10).
 *
 * Structured data lives in IndexedDB, never localStorage — localStorage is
 * synchronous, size-limited and easily cleared, which would mean silent data loss.
 *
 * Flow: optimistic local write → queue → flush on reconnect → reconcile.
 */

const DB_NAME = 'nextdoo';
const DB_VERSION = 1;
const STORE_MUTATIONS = 'mutations';
const STORE_TASKS = 'tasks';

export interface QueuedMutation {
  mutationId: string;
  entityType: 'task';
  entityId: string;
  operation: 'create' | 'update' | 'delete';
  baseVersion: number | null;
  payload: Record<string, unknown>;
  createdAt: string;
  attempts: number;
  /** Set after repeated hard failures so the UI can surface it for attention. */
  quarantined?: boolean;
  lastError?: string;
}

let dbPromise: Promise<IDBDatabase> | null = null;
let pending = 0;

export function pendingCount(): number {
  return pending;
}

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IndexedDB unavailable'));
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_MUTATIONS)) {
        db.createObjectStore(STORE_MUTATIONS, { keyPath: 'mutationId' });
      }
      if (!db.objectStoreNames.contains(STORE_TASKS)) {
        db.createObjectStore(STORE_TASKS, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

async function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(store, mode);
    const request = fn(transaction.objectStore(store));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function enqueue(mutation: Omit<QueuedMutation, 'attempts' | 'createdAt'>): Promise<void> {
  const record: QueuedMutation = { ...mutation, attempts: 0, createdAt: new Date().toISOString() };
  await tx(STORE_MUTATIONS, 'readwrite', (s) => s.put(record));
  await refreshCount();
}

export async function listQueued(): Promise<QueuedMutation[]> {
  try {
    const all = await tx<QueuedMutation[]>(STORE_MUTATIONS, 'readonly', (s) => s.getAll() as IDBRequest<QueuedMutation[]>);
    return all.filter((m) => !m.quarantined);
  } catch {
    return [];
  }
}

export async function dequeue(mutationId: string): Promise<void> {
  await tx(STORE_MUTATIONS, 'readwrite', (s) => s.delete(mutationId));
  await refreshCount();
}

export async function markFailed(mutationId: string, error: string): Promise<void> {
  try {
    const existing = await tx<QueuedMutation | undefined>(STORE_MUTATIONS, 'readonly', (s) =>
      s.get(mutationId) as IDBRequest<QueuedMutation | undefined>,
    );
    if (!existing) return;
    const attempts = existing.attempts + 1;
    await tx(STORE_MUTATIONS, 'readwrite', (s) =>
      // Quarantine after 5 hard failures rather than discarding the change.
      s.put({ ...existing, attempts, lastError: error, quarantined: attempts >= 5 }),
    );
  } catch {
    /* non-fatal */
  }
}

async function refreshCount(): Promise<void> {
  try {
    pending = (await listQueued()).length;
  } catch {
    pending = 0;
  }
}

export async function cacheTasks(tasks: unknown[]): Promise<void> {
  try {
    const db = await openDb();
    const transaction = db.transaction(STORE_TASKS, 'readwrite');
    const store = transaction.objectStore(STORE_TASKS);
    for (const task of tasks) store.put(task);
  } catch {
    /* cache is best-effort */
  }
}

export async function readCachedTasks<T>(): Promise<T[]> {
  try {
    return await tx<T[]>(STORE_TASKS, 'readonly', (s) => s.getAll() as IDBRequest<T[]>);
  } catch {
    return [];
  }
}

export interface FlushResult {
  applied: number;
  conflicts: number;
  rejected: number;
}

/** Sends queued mutations. Safe to call repeatedly — the server dedupes. */
export async function flushQueue(workspaceId: string, deviceId: string): Promise<FlushResult> {
  const queued = await listQueued();
  const result: FlushResult = { applied: 0, conflicts: 0, rejected: 0 };
  if (!queued.length || !navigator.onLine) return result;

  // Batch cap matches the server limit.
  const batch = queued.slice(0, 200);
  try {
    const response = await fetch('/api/v1/sync/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId,
        mutations: batch.map((m) => ({
          mutationId: m.mutationId,
          entityType: m.entityType,
          entityId: m.entityId,
          operation: m.operation,
          baseVersion: m.baseVersion,
          payload: m.payload,
          createdAt: m.createdAt,
        })),
      }),
    });
    if (!response.ok) throw new Error(`sync failed: ${response.status}`);
    const body = (await response.json()) as { results: Array<{ mutationId: string; status: string }> };

    for (const r of body.results) {
      if (r.status === 'applied' || r.status === 'duplicate') {
        await dequeue(r.mutationId);
        result.applied += 1;
      } else if (r.status === 'conflict') {
        await dequeue(r.mutationId);
        result.conflicts += 1;
      } else {
        // Rejected content stays server-side in conflict_snapshots; drop the queue entry.
        await dequeue(r.mutationId);
        result.rejected += 1;
      }
    }
  } catch (error) {
    for (const m of batch) await markFailed(m.mutationId, error instanceof Error ? error.message : 'unknown');
  }
  await refreshCount();
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

if (typeof window !== 'undefined') {
  void refreshCount();
}
