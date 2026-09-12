import { randomUUID } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { conflictSnapshots, syncChanges, syncMutations, tasks } from '@nextdoo/db';
import { getDb } from '../db';
import { pullChanges, pushMutations, type MutationResult } from './sync';

/**
 * SY-10 / PRD §10.9 qualification harness: a repeatable 5,000-mutation
 * multi-device offline drain against the real server + database.
 *
 * The workload mirrors what the client queue actually sends
 * (lib/offline-queue.ts): batches of at most 200 mutations, only each
 * entity's oldest pending command is eligible (independent entities make
 * progress, followers wait), applied/duplicate dequeue the mutation,
 * conflict/rejected quarantine it, server errors retry with backoff and
 * quarantine after five attempts. The harness simulates exactly that loop
 * and injects simulated server 5xx failures to exercise the retry and
 * quarantine paths, then verifies integrity against a reference model the
 * workload generator builds as it emits each mutation.
 *
 * Workload (5,000 mutations, 4 devices, 1 tenant; plus isolation + SLO
 * probes reported separately):
 *   A 2500: 1900 create, 30 create-then-complete, 300 title updates,
 *           100 completes, 50 deletes, 50 updates-of-deleted (tombstone),
 *           40 stale-base scalar updates (LWW), 20 lost-ack replays,
 *           10 invalid creates (poison)
 *   B 1245: 800 create, 200 description updates, 100 completes,
 *           50 deletes, 25 same-id lost-ack replays, 25 same-entity
 *           re-creates under a new id, 30 timer_session (unsupported,
 *           poison isolation), 10 stale-base scalar updates,
 *           5 creates referencing a missing project (poison)
 *   C 1000: 600 create, 50 same-field conflicts against device A's tasks
 *           (stale base, diverged title -> preserved snapshot), 50
 *           cross-field merges (stale base, scalar-only -> LWW),
 *           300 self updates
 *   D  255: 150 create, 55 deletes, 25 delete-of-deleted (duplicate),
 *           25 updates-of-deleted (tombstone)
 *
 * Expected totals (derived, asserted):
 *   applied 4735, duplicate 95, conflict 50, rejected 120
 *   task rows 3480, unresolved conflict snapshots 125
 */

export interface Actor { userId: string; workspaceId: string }

export interface SloSummary {
  totalMutations: number;
  quarantineMutations: number;
  perDevice: Record<string, number>;
  statusCounts: Record<string, number>;
  simulatedServerFailures: number;
  retries: number;
  peakQuarantined: number;
  finalQuarantined: number;
  drainWallMs: Record<string, number>;
  totalDrainMs: number;
  throughputMutPerSec: number;
  passLatencyMs: { p50: number; p95: number; p99: number; max: number; passes: number };
  mutationAckMs: { p50: number; p95: number; p99: number; max: number };
  rejectionCodes: Record<string, number>;
  rejectionSamples: Array<{ code: string; detail: string; operation: string }>;
  connectedBurst: {
    count: number;
    ms: { p50: number; p95: number; p99: number; max: number };
    pctUnder5s: number;
    allUnder5s: boolean;
    mutPerSec: number;
  };
  pull: {
    perDevice: Record<string, { changes: number; deletions: number; ms: number }>;
    finalCursor: number;
    modelMatchesServer: boolean;
    modelSize: number;
    serverLiveSize: number;
  };
  integrity: {
    entitiesChecked: number;
    mismatches: number;
    mismatchSamples: string[];
    integrityRate: number;
    duplicateEntities: number;
    orderingViolations: number;
    snapshotsExpected: number;
    snapshotsFound: number;
    snapshotPayloadPreserved: boolean;
    tombstonesCorrect: boolean;
    ledgerMatches: boolean;
    ledgerCounts: Record<string, number>;
    tenantViolations: number;
  };
}

interface QueuedMut {
  mutationId: string;
  entityType: 'task' | 'timer_session';
  entityId: string;
  operation: 'create' | 'update' | 'delete';
  baseVersion: number | null;
  payload: Record<string, unknown>;
  createdAt: string;
  attempts: number;
  retries: number;
  retryAt: number;
  quarantined: boolean;
  deleted: boolean;
}

interface ExpectedEntity {
  status: 'ACTIVE' | 'COMPLETED' | 'DELETED';
  version: number;
  title: string;
  description: string | null;
  priority: string;
  dueAt: string;
  changeOps: string[];
}

interface DeviceState {
  name: string;
  deviceId: string;
  queue: QueuedMut[];
}

const BATCH = 200; // identical to offline-queue.ts flush()
const PRIORITIES = ['NONE', 'LOW', 'MEDIUM', 'HIGH'] as const;

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] ?? 0;
}

function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

/** Deterministic title/due values keyed by index — no RNG ambiguity. */
function createPayload(prefix: string, i: number, t0: number): Record<string, unknown> {
  return {
    title: `${prefix} ${i}`,
    priority: PRIORITIES[i % PRIORITIES.length]!,
    dueAt: new Date(t0 + i * 60_000).toISOString(),
    estimateMinutes: 30 + (i % 6) * 15,
  };
}

export interface SloWorkload {
  devices: DeviceState[];
  quarantineDevice: DeviceState;
  expected: Map<string, ExpectedEntity>;
  c2Titles: Map<string, string>;
  aTargetEntities: string[];
  foreignTargetEntities: string[];
  snapshotsExpected: number;
  totalMutations: number;
  quarantineMutations: number;
  /** Replays of mutation ids that were already ledgered (original stays the single row). */
  replayedOfRecorded: number;
}

/**
 * Builds the 5,000-mutation workload and the reference model in one pass.
 * Generation order per device == queue order; devices drain A, B, C, D.
 */
export function buildWorkload(t0: number): SloWorkload {
  const a: DeviceState = { name: 'A', deviceId: 'slo-device-a', queue: [] };
  const b: DeviceState = { name: 'B', deviceId: 'slo-device-b', queue: [] };
  const c: DeviceState = { name: 'C', deviceId: 'slo-device-c', queue: [] };
  const d: DeviceState = { name: 'D', deviceId: 'slo-device-d', queue: [] };
  const q: DeviceState = { name: 'Q', deviceId: 'slo-device-q', queue: [] };
  const expected = new Map<string, ExpectedEntity>();
  const c2Titles = new Map<string, string>();
  let clock = t0;
  let n = 0;
  let replayedOfRecorded = 0;

  const nextCreated = (): string => {
    clock += 1000;
    return isoAt(clock);
  };
  const enqueue = (dev: DeviceState, m: Omit<QueuedMut, 'attempts' | 'retries' | 'retryAt' | 'quarantined' | 'deleted'>) => {
    dev.queue.push({ ...m, attempts: 0, retries: 0, retryAt: 0, quarantined: false, deleted: false });
    n += 1;
  };
  const make = (): string => randomUUID();
  const bump = (id: string, patch: Partial<ExpectedEntity>, op?: string) => {
    const e = expected.get(id)!;
    e.version += 1;
    Object.assign(e, patch);
    if (op) e.changeOps.push(op);
  };

  // ---------- Device A (2500) ----------
  const aCreateIds: string[] = [];
  for (let i = 0; i < 1900; i += 1) {
    const id = make();
    const payload = createPayload('A', i, t0);
    enqueue(a, { mutationId: make(), entityType: 'task', entityId: id, operation: 'create', baseVersion: null, payload, createdAt: nextCreated() });
    expected.set(id, { status: 'ACTIVE', version: 1, title: payload.title as string, description: null, priority: payload.priority as string, dueAt: payload.dueAt as string, changeOps: ['create'] });
    aCreateIds.push(id);
  }
  // A2: 300 title updates on the first 300 (base current -> clean fast-forward)
  const aTitleIds = aCreateIds.slice(0, 300);
  aTitleIds.forEach((id, i) => {
    const e = expected.get(id)!;
    const title = `A2 ${i}`;
    enqueue(a, { mutationId: make(), entityType: 'task', entityId: id, operation: 'update', baseVersion: e.version, payload: { title }, createdAt: nextCreated() });
    bump(id, { title }, 'update');
  });
  // A3: 100 completes (next 100 untouched creates)
  aCreateIds.slice(300, 400).forEach((id) => {
    const e = expected.get(id)!;
    enqueue(a, { mutationId: make(), entityType: 'task', entityId: id, operation: 'update', baseVersion: e.version, payload: { status: 'COMPLETED', completedAt: nextCreated() }, createdAt: nextCreated() });
    bump(id, { status: 'COMPLETED' }, 'update');
  });
  // A4: 50 deletes (next 50 untouched creates)
  const aDeletedIds = aCreateIds.slice(400, 450);
  aDeletedIds.forEach((id) => {
    const e = expected.get(id)!;
    enqueue(a, { mutationId: make(), entityType: 'task', entityId: id, operation: 'delete', baseVersion: e.version, payload: {}, createdAt: nextCreated() });
    bump(id, { status: 'DELETED' }, 'delete');
  });
  // A5: 50 updates of the deleted tasks (stale base -> tombstone rejection + snapshot)
  aDeletedIds.forEach((id, i) => {
    enqueue(a, { mutationId: make(), entityType: 'task', entityId: id, operation: 'update', baseVersion: 1, payload: { title: `A5 lost ${i}` }, createdAt: nextCreated() });
  });
  // A6: 30 creates already completed (create + complete in one payload)
  for (let i = 0; i < 30; i += 1) {
    const eid = make();
    expected.set(eid, { status: 'COMPLETED', version: 2, title: `A6 ${i}`, description: null, priority: 'LOW', dueAt: new Date(t0 + i * 60_000).toISOString(), changeOps: ['create', 'update'] });
    enqueue(a, { mutationId: make(), entityType: 'task', entityId: eid, operation: 'create', baseVersion: null, payload: { title: `A6 ${i}`, priority: 'LOW', dueAt: new Date(t0 + i * 60_000).toISOString(), status: 'COMPLETED', completedAt: nextCreated() }, createdAt: nextCreated() });
  }
  // A7: 20 lost-ack replays of already-acknowledged creates (same mutation id)
  aCreateIds.slice(450, 470).forEach((id) => {
    const orig = a.queue[aCreateIds.indexOf(id)]!;
    enqueue(a, { mutationId: orig.mutationId, entityType: 'task', entityId: id, operation: 'create', baseVersion: null, payload: orig.payload, createdAt: orig.createdAt });
    replayedOfRecorded += 1;
  });
  // A8: 10 invalid creates (missing title) — rejected, never recorded
  for (let i = 0; i < 10; i += 1) {
    enqueue(a, { mutationId: make(), entityType: 'task', entityId: make(), operation: 'create', baseVersion: null, payload: { priority: 'LOW' }, createdAt: nextCreated() });
  }
  // A9: 40 stale-base scalar updates on title-updated tasks (LWW applies)
  aTitleIds.slice(100, 140).forEach((id, i) => {
    const priority = PRIORITIES[(i + 1) % PRIORITIES.length]!;
    enqueue(a, { mutationId: make(), entityType: 'task', entityId: id, operation: 'update', baseVersion: 1, payload: { priority }, createdAt: nextCreated() });
    bump(id, { priority }, 'update');
  });

  // ---------- Device B (1245) ----------
  const bCreateIds: string[] = [];
  for (let i = 0; i < 800; i += 1) {
    const id = make();
    const payload = createPayload('B', i, t0);
    enqueue(b, { mutationId: make(), entityType: 'task', entityId: id, operation: 'create', baseVersion: null, payload, createdAt: nextCreated() });
    expected.set(id, { status: 'ACTIVE', version: 1, title: payload.title as string, description: null, priority: payload.priority as string, dueAt: payload.dueAt as string, changeOps: ['create'] });
    bCreateIds.push(id);
  }
  bCreateIds.slice(0, 200).forEach((id, i) => {
    const e = expected.get(id)!;
    enqueue(b, { mutationId: make(), entityType: 'task', entityId: id, operation: 'update', baseVersion: e.version, payload: { description: `B2 desc ${i}` }, createdAt: nextCreated() });
    bump(id, { description: `B2 desc ${i}` }, 'update');
  });
  bCreateIds.slice(200, 300).forEach((id) => {
    const e = expected.get(id)!;
    enqueue(b, { mutationId: make(), entityType: 'task', entityId: id, operation: 'update', baseVersion: e.version, payload: { status: 'COMPLETED', completedAt: nextCreated() }, createdAt: nextCreated() });
    bump(id, { status: 'COMPLETED' }, 'update');
  });
  bCreateIds.slice(300, 350).forEach((id) => {
    const e = expected.get(id)!;
    enqueue(b, { mutationId: make(), entityType: 'task', entityId: id, operation: 'delete', baseVersion: e.version, payload: {}, createdAt: nextCreated() });
    bump(id, { status: 'DELETED' }, 'delete');
  });
  // B5a: 25 lost-ack replays (same mutation id)
  bCreateIds.slice(350, 375).forEach((id) => {
    const orig = b.queue.find((m) => m.entityId === id && m.operation === 'create')!;
    enqueue(b, { mutationId: orig.mutationId, entityType: 'task', entityId: id, operation: 'create', baseVersion: null, payload: orig.payload, createdAt: orig.createdAt });
    replayedOfRecorded += 1;
  });
  // B5b: 25 re-creates under a NEW mutation id for the same entity (lost id case)
  bCreateIds.slice(375, 400).forEach((id) => {
    const e = expected.get(id)!;
    enqueue(b, { mutationId: make(), entityType: 'task', entityId: id, operation: 'create', baseVersion: null, payload: { title: e.title, priority: e.priority, dueAt: e.dueAt, estimateMinutes: 30 }, createdAt: nextCreated() });
  });
  // B7: 10 stale-base scalar updates (LWW)
  bCreateIds.slice(400, 410).forEach((id, i) => {
    const priority = PRIORITIES[(i + 2) % PRIORITIES.length]!;
    enqueue(b, { mutationId: make(), entityType: 'task', entityId: id, operation: 'update', baseVersion: 1, payload: { priority }, createdAt: nextCreated() });
    bump(id, { priority }, 'update');
  });
  // B6: 30 timer_session mutations (unsupported entity type — poison isolation)
  for (let i = 0; i < 30; i += 1) {
    enqueue(b, { mutationId: make(), entityType: 'timer_session', entityId: make(), operation: 'create', baseVersion: null, payload: { startedAt: nextCreated() }, createdAt: nextCreated() });
  }
  // B8: 5 creates referencing a missing project (rejected references)
  for (let i = 0; i < 5; i += 1) {
    enqueue(b, { mutationId: make(), entityType: 'task', entityId: make(), operation: 'create', baseVersion: null, payload: { title: `B8 ${i}`, projectId: '99999999-9999-9999-9999-999999999999' }, createdAt: nextCreated() });
  }

  // ---------- Device C (1000) — drains after A, so A's writes are server state ----------
  const cCreateIds: string[] = [];
  for (let i = 0; i < 600; i += 1) {
    const id = make();
    const payload = createPayload('C', i, t0);
    enqueue(c, { mutationId: make(), entityType: 'task', entityId: id, operation: 'create', baseVersion: null, payload, createdAt: nextCreated() });
    expected.set(id, { status: 'ACTIVE', version: 1, title: payload.title as string, description: null, priority: payload.priority as string, dueAt: payload.dueAt as string, changeOps: ['create'] });
    cCreateIds.push(id);
  }
  // C2: 50 same-field conflicts on A's title-updated tasks (base v1, diverged title)
  aTitleIds.slice(0, 50).forEach((id, i) => {
    const title = `C2 conflict ${i}`;
    c2Titles.set(id, title);
    enqueue(c, { mutationId: make(), entityType: 'task', entityId: id, operation: 'update', baseVersion: 1, payload: { title }, createdAt: nextCreated() });
    // server keeps A's value; version unchanged; one preserved snapshot
  });
  // C3: 50 cross-field merges on A's title-updated tasks (scalar-only, stale base)
  aTitleIds.slice(50, 100).forEach((id, i) => {
    const priority = PRIORITIES[(i + 1) % PRIORITIES.length]!;
    enqueue(c, { mutationId: make(), entityType: 'task', entityId: id, operation: 'update', baseVersion: 1, payload: { priority }, createdAt: nextCreated() });
    bump(id, { priority }, 'update');
  });
  // C4: 300 self updates
  cCreateIds.slice(0, 300).forEach((id, i) => {
    const e = expected.get(id)!;
    enqueue(c, { mutationId: make(), entityType: 'task', entityId: id, operation: 'update', baseVersion: e.version, payload: { description: `C4 desc ${i}` }, createdAt: nextCreated() });
    bump(id, { description: `C4 desc ${i}` }, 'update');
  });

  // ---------- Device D (255) ----------
  const dCreateIds: string[] = [];
  for (let i = 0; i < 150; i += 1) {
    const id = make();
    const payload = createPayload('D', i, t0);
    enqueue(d, { mutationId: make(), entityType: 'task', entityId: id, operation: 'create', baseVersion: null, payload, createdAt: nextCreated() });
    expected.set(id, { status: 'ACTIVE', version: 1, title: payload.title as string, description: null, priority: payload.priority as string, dueAt: payload.dueAt as string, changeOps: ['create'] });
    dCreateIds.push(id);
  }
  const dDeleted = dCreateIds.slice(0, 55);
  dDeleted.forEach((id) => {
    const e = expected.get(id)!;
    enqueue(d, { mutationId: make(), entityType: 'task', entityId: id, operation: 'delete', baseVersion: e.version, payload: {}, createdAt: nextCreated() });
    bump(id, { status: 'DELETED' }, 'delete');
  });
  dDeleted.slice(0, 25).forEach((id) => {
    const e = expected.get(id)!;
    enqueue(d, { mutationId: make(), entityType: 'task', entityId: id, operation: 'delete', baseVersion: e.version, payload: {}, createdAt: nextCreated() });
  });
  dDeleted.slice(0, 25).forEach((id, i) => {
    enqueue(d, { mutationId: make(), entityType: 'task', entityId: id, operation: 'update', baseVersion: 1, payload: { title: `D4 lost ${i}` }, createdAt: nextCreated() });
  });

  // ---------- Quarantine device Q (5, separate from the 5,000) ----------
  for (let i = 0; i < 5; i += 1) {
    const id = make();
    const payload = createPayload('Q', i, t0);
    enqueue(q, { mutationId: make(), entityType: 'task', entityId: id, operation: 'create', baseVersion: null, payload, createdAt: nextCreated() });
    expected.set(id, { status: 'ACTIVE', version: 1, title: payload.title as string, description: null, priority: payload.priority as string, dueAt: payload.dueAt as string, changeOps: ['create'] });
  }

  // Tenant-isolation targets (untouched A tasks, known final state)
  const aTargetEntities = aCreateIds.slice(470, 480);
  const foreignTargetEntities = aCreateIds.slice(480, 490);

  return {
    devices: [a, b, c, d],
    quarantineDevice: q,
    expected,
    c2Titles,
    aTargetEntities,
    foreignTargetEntities,
    snapshotsExpected: 125, // 50 C2 conflicts + 50 A5 tombstones + 25 D4 tombstones
    totalMutations: n - q.queue.length,
    quarantineMutations: q.queue.length,
    replayedOfRecorded,
  };
}

export interface SloRunOptions {
  actor: Actor;
  foreignActor: Actor;
  /** Simulated 5xx: which (device, pass) combinations fail at the network level. */
  failDevicePasses?: (device: string, pass: number) => boolean;
  onPass?: (device: string, pass: number, ms: number, failed: boolean) => void;
}

/** The client-side queue state machine, faithful to lib/offline-queue.ts. */
async function drainDevice(
  dev: DeviceState,
  actor: Actor,
  opts: SloRunOptions,
  stats: {
    status: Record<string, number>;
    passMs: number[];
    ackMs: number[];
    serverFailures: number;
    retries: number;
    rejectionCodes: Record<string, number>;
    rejectionSamples: Array<{ code: string; detail: string; operation: string }>;
  },
  clock: { now: number },
): Promise<number> {
  const start = process.hrtime.bigint();
  let pass = 0;
  let guard = 0;
  while (guard < 500) {
    guard += 1;
    const seen = new Set<string>();
    const batch = dev.queue.filter((m) => {
      if (m.deleted || m.quarantined) return false;
      if (seen.has(m.entityId)) return false;
      seen.add(m.entityId);
      return m.retryAt <= clock.now;
    }).slice(0, BATCH);
    if (!batch.length) break;
    pass += 1;
    const t0 = process.hrtime.bigint();
    let results: MutationResult[] | null = null;
    if (opts.failDevicePasses?.(dev.name, pass)) {
      results = null; // simulated server 500 (connection-level failure)
    } else {
      const res = await pushMutations(actor, {
        workspaceId: actor.workspaceId,
        deviceId: dev.deviceId,
        mutations: batch.map((m) => ({
          mutationId: m.mutationId,
          entityType: m.entityType,
          entityId: m.entityId,
          operation: m.operation,
          baseVersion: m.baseVersion,
          payload: m.payload,
          createdAt: m.createdAt,
        })),
      });
      results = res.results;
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (results === null) {
      for (const m of batch) {
        m.attempts += 1;
        m.retries += 1;
        m.quarantined = m.attempts >= 5; // identical to markFailed(kind:'server')
        m.retryAt = clock.now + Math.min(300_000, 1000 * 2 ** Math.min(m.retries - 1, 9));
        stats.serverFailures += 1;
        stats.retries += 1;
      }
      clock.now = Math.max(...batch.map((m) => m.retryAt)); // client waits out backoff
      opts.onPass?.(dev.name, pass, ms, true);
      continue;
    }
    stats.passMs.push(ms);
    for (const m of batch) {
      const reply = results!.find((r) => r.mutationId === m.mutationId);
      stats.ackMs.push(ms); // the batch ack is the mutation ack
      if (reply && (reply.status === 'applied' || reply.status === 'duplicate')) {
        m.deleted = true;
        stats.status[reply.status] = (stats.status[reply.status] ?? 0) + 1;
      } else if (reply && (reply.status === 'conflict' || reply.status === 'rejected')) {
        m.quarantined = true; // markFailed(kind:'client') quarantines immediately
        m.retries += 1;
        stats.retries += 1;
        stats.status[reply.status] = (stats.status[reply.status] ?? 0) + 1;
        if (reply.status === 'rejected' && reply.error) {
          stats.rejectionCodes[reply.error.code] = (stats.rejectionCodes[reply.error.code] ?? 0) + 1;
          if (stats.rejectionSamples.length < 5) {
            stats.rejectionSamples.push({ code: reply.error.code, detail: reply.error.detail, operation: m.operation });
          }
        }
      } else {
        m.attempts += 1;
        m.retries += 1;
        m.quarantined = m.attempts >= 5;
        m.retryAt = clock.now + 2000;
        stats.serverFailures += 1;
        stats.retries += 1;
      }
    }
    opts.onPass?.(dev.name, pass, ms, false);
  }
  if (guard >= 500) throw new Error(`${dev.name}: drain did not converge`);
  return Number(process.hrtime.bigint() - start) / 1e6;
}

async function pullToHead(workspaceId: string): Promise<{ changes: number; deletions: number; ms: number; cursor: number; model: Map<string, Record<string, unknown>> }> {
  const model = new Map<string, Record<string, unknown>>();
  let cursor = 0;
  let changes = 0;
  let deletions = 0;
  const t0 = process.hrtime.bigint();
  for (let page = 0; page < 1000; page += 1) {
    const body = await pullChanges(workspaceId, cursor, 500);
    for (const change of body.changes) {
      if (change.entityType !== 'task') continue;
      if (change.operation === 'delete') {
        model.delete(change.entityId);
        deletions += 1;
      } else {
        const payload = change.payload as { id?: unknown; workspaceId?: unknown };
        if (typeof payload?.id === 'string' && payload.id === change.entityId && payload.workspaceId === workspaceId) {
          model.set(change.entityId, change.payload as Record<string, unknown>);
          changes += 1;
        }
      }
    }
    cursor = body.cursor;
    if (!body.hasMore || body.changes.length === 0) break;
  }
  return { changes, deletions, ms: Number(process.hrtime.bigint() - t0) / 1e6, cursor, model };
}

export async function runSloScenario(opts: SloRunOptions): Promise<SloSummary> {
  const workload = buildWorkload(Date.now());
  const actor = opts.actor;
  const db = getDb();
  const clock = { now: Date.now() };
  const status: Record<string, number> = {};
  const stats = { status, passMs: [] as number[], ackMs: [] as number[], serverFailures: 0, retries: 0, rejectionCodes: {} as Record<string, number>, rejectionSamples: [] as Array<{ code: string; detail: string; operation: string }> };
  const drainWallMs: Record<string, number> = {};
  const perDevice: Record<string, number> = {};

  const addStatus = (source: Record<string, number>) => {
    for (const [k, v] of Object.entries(source)) status[k] = (status[k] ?? 0) + Number(v);
  };
  const tDrain = process.hrtime.bigint();
  let quarantinedTotal = 0;
  let peakQuarantined = 0;
  for (const dev of workload.devices) {
    perDevice[dev.name] = dev.queue.length;
    const ms = await drainDevice(dev, actor, opts, stats, clock);
    drainWallMs[dev.name] = Math.round(ms);
    quarantinedTotal += dev.queue.filter((m) => m.quarantined).length;
    peakQuarantined = Math.max(peakQuarantined, quarantinedTotal);
  }
  // Device Q: five attempts fail (simulated server 500), the queue
  // quarantines, the user requeues (requeueMutation semantics: counters
  // reset, payload kept), and the retry succeeds exactly once.
  {
    const q = workload.quarantineDevice;
    const qOpts: SloRunOptions = { ...opts, failDevicePasses: (d, p) => d === 'Q' && p <= 5 };
    const qStats = { status: {} as Record<string, number>, passMs: [] as number[], ackMs: [] as number[], serverFailures: 0, retries: 0, rejectionCodes: {} as Record<string, number>, rejectionSamples: [] as Array<{ code: string; detail: string; operation: string }> };
    await drainDevice(q, actor, qOpts, qStats, clock);
    const quarantined = q.queue.filter((m) => m.quarantined);
    peakQuarantined = Math.max(peakQuarantined, quarantinedTotal + quarantined.length);
    if (quarantined.length !== 5) throw new Error(`Q: expected 5 quarantined mutations, found ${quarantined.length}`);
    for (const m of quarantined) {
      m.attempts = 0;
      m.retries = 0;
      m.quarantined = false;
      m.retryAt = clock.now; // requeueMutation
    }
    const ms = await drainDevice(q, actor, opts, qStats, clock);
    drainWallMs.Q = (drainWallMs.Q ?? 0) + Math.round(ms);
    addStatus(qStats.status);
    stats.passMs.push(...qStats.passMs);
    stats.ackMs.push(...qStats.ackMs);
    stats.serverFailures += qStats.serverFailures;
    stats.retries += qStats.retries;
    for (const [k, v] of Object.entries(qStats.rejectionCodes)) stats.rejectionCodes[k] = (stats.rejectionCodes[k] ?? 0) + Number(v);
    stats.rejectionSamples.push(...qStats.rejectionSamples.slice(0, 5 - stats.rejectionSamples.length));
  }
  const totalDrainMs = Number(process.hrtime.bigint() - tDrain) / 1e6;
  const finalQuarantined = quarantinedTotal;

  // ---- Connected SLO probe: 200 single-mutation pushes (PRD §10.9 "connected") ----
  const burstT0 = process.hrtime.bigint();
  const burstMs: number[] = [];
  const burstIds: string[] = [];
  for (let i = 0; i < 200; i += 1) {
    const id = randomUUID();
    const payload = createPayload('SLO', i, Date.now());
    const t = process.hrtime.bigint();
    const res = await pushMutations(actor, {
      workspaceId: actor.workspaceId,
      deviceId: 'slo-burst',
      mutations: [{ mutationId: randomUUID(), entityType: 'task', entityId: id, operation: 'create', baseVersion: null, payload, createdAt: new Date().toISOString() }],
    });
    burstMs.push(Number(process.hrtime.bigint() - t) / 1e6);
    burstIds.push(id);
    const reply = res.results[0];
    if (reply?.status === 'applied') {
      workload.expected.set(id, { status: 'ACTIVE', version: 1, title: payload.title as string, description: null, priority: payload.priority as string, dueAt: payload.dueAt as string, changeOps: ['create'] });
      status.applied = (status.applied ?? 0) + 1;
    } else {
      // A connected mutation must never be silently dropped
      throw new Error(`connected burst create not applied: ${JSON.stringify(reply)}`);
    }
  }
  const burstMsSorted = [...burstMs].sort((x, y) => x - y);
  const burstTotalMs = Number(process.hrtime.bigint() - burstT0) / 1e6;
  const under5s = burstMs.filter((ms) => ms < 5000).length;

  // ---- Tenant isolation probes (foreign tenant, outside the 5,000) ----
  let tenantViolations = 0;
  {
    for (const id of workload.aTargetEntities) {
      const e = workload.expected.get(id)!;
      const res = await pushMutations(opts.foreignActor, {
        workspaceId: opts.foreignActor.workspaceId,
        deviceId: 'slo-foreign',
        mutations: [{ mutationId: randomUUID(), entityType: 'task', entityId: id, operation: 'update', baseVersion: e.version, payload: { title: 'FOREIGN INTRUSION' }, createdAt: new Date().toISOString() }],
      });
      if (res.results[0]?.status !== 'rejected') tenantViolations += 1;
      // rejected updates are preserved as recoverable snapshots in the
      // FOREIGN workspace only; main-workspace state must be untouched
      // (verified by the integrity pass below via expected model).
    }
    for (let i = 0; i < 5; i += 1) {
      const id = randomUUID();
      const res = await pushMutations(opts.foreignActor, {
        workspaceId: opts.foreignActor.workspaceId,
        deviceId: 'slo-foreign',
        mutations: [{ mutationId: randomUUID(), entityType: 'task', entityId: id, operation: 'create', baseVersion: null, payload: { title: `Foreign ${i}`, priority: 'LOW' }, createdAt: new Date().toISOString() }],
      });
      if (res.results[0]?.status !== 'applied') tenantViolations += 1;
    }
    let forbidden = false;
    try {
      await pushMutations(opts.foreignActor, {
        workspaceId: actor.workspaceId,
        deviceId: 'slo-foreign',
        mutations: [{ mutationId: randomUUID(), entityType: 'task', entityId: randomUUID(), operation: 'create', baseVersion: null, payload: { title: 'Cross workspace' }, createdAt: new Date().toISOString() }],
      });
    } catch {
      forbidden = true; // expected: FORBIDDEN for a foreign queued workspace
    }
    if (!forbidden) tenantViolations += 1;
  }

  // ---- Pull every device to head and reconstruct its local model ----
  const pullPerDevice: Record<string, { changes: number; deletions: number; ms: number }> = {};
  let modelMatchesServer = true;
  let modelSize = 0;
  let finalCursor = 0;
  let firstModel: Map<string, Record<string, unknown>> | null = null;
  for (const dev of workload.devices) {
    const pulled = await pullToHead(actor.workspaceId);
    pullPerDevice[dev.name] = { changes: pulled.changes, deletions: pulled.deletions, ms: Math.round(pulled.ms) };
    finalCursor = pulled.cursor;
    if (!firstModel) firstModel = pulled.model;
    modelSize = pulled.model.size;
  }

  // ---- Integrity verification against the reference model ----
  const rows = await db.select().from(tasks).where(eq(tasks.workspaceId, actor.workspaceId));
  const byId = new Map<string, typeof rows[number]>();
  let duplicateEntities = 0;
  for (const row of rows) {
    if (byId.has(row.id)) duplicateEntities += 1;
    byId.set(row.id, row);
  }
  const mismatches: string[] = [];
  let entitiesChecked = 0;
  let tombstonesCorrect = true;
  for (const [id, exp] of workload.expected) {
    entitiesChecked += 1;
    const row = byId.get(id);
    if (!row) {
      mismatches.push(`missing ${id} (expected ${exp.status})`);
      continue;
    }
    const ok =
      row.status === exp.status &&
      row.version === exp.version &&
      row.title === exp.title &&
      (row.description ?? null) === exp.description &&
      row.priority === exp.priority &&
      new Date(row.dueAt ?? 0).getTime() === new Date(exp.dueAt).getTime();
    if (!ok) mismatches.push(`${id}: row(${row.status} v${row.version} '${row.title}') != expected(${exp.status} v${exp.version} '${exp.title}')`);
    if (exp.status === 'DELETED' && row.status !== 'DELETED') tombstonesCorrect = false;
  }
  // Every row in the workspace must be accounted for by the model
  for (const [id] of byId) {
    if (!workload.expected.has(id)) {
      entitiesChecked += 1;
      mismatches.push(`unexpected row ${id}`);
    }
  }
  const integrityRate = entitiesChecked > 0 ? 1 - mismatches.length / entitiesChecked : 1;

  // Ordering: per-entity sync_changes versions strictly increase and ops
  // appear in generation order.
  const changes = await db
    .select({ entityId: syncChanges.entityId, sequence: syncChanges.sequence, operation: syncChanges.operation, version: syncChanges.version })
    .from(syncChanges)
    .where(eq(syncChanges.workspaceId, actor.workspaceId))
    .orderBy(asc(syncChanges.sequence));
  let orderingViolations = 0;
  const perEntity = new Map<string, { seq: number; op: string; version: number }[]>();
  for (const ch of changes) {
    const list = perEntity.get(ch.entityId) ?? [];
    if (list.length && ch.version <= list[list.length -1]!.version) orderingViolations += 1;
    list.push({ seq: Number(ch.sequence), op: ch.operation, version: Number(ch.version) });
    perEntity.set(ch.entityId, list);
  }
  for (const [id, exp] of workload.expected) {
    const list = perEntity.get(id);
    const expOps = exp.changeOps;
    if (!list || list.length !== expOps.length) {
      orderingViolations += 1;
      continue;
    }
    for (let i = 0; i < expOps.length; i += 1) {
      if (list[i]!.op !== expOps[i] || list[i]!.version !== i + 1) {
        orderingViolations += 1;
        break;
      }
    }
  }

  // Conflict snapshots: count and preserved local content
  const snapshots = await db
    .select()
    .from(conflictSnapshots)
    .where(and(eq(conflictSnapshots.workspaceId, actor.workspaceId), sql`${conflictSnapshots.resolvedAt} IS NULL`));
  let snapshotPayloadPreserved = true;
  if (snapshots.length !== workload.snapshotsExpected) snapshotPayloadPreserved = false;
  for (const [id, title] of workload.c2Titles) {
    const snap = snapshots.find((s) => s.entityId === id);
    if (!snap || (snap.localPayload as { title?: string } | null)?.title !== title) snapshotPayloadPreserved = false;
  }

  // Ledger: recorded statuses must equal what the drain observed, minus the
  // 45 mutations rejected before recording (10 invalid A8 + 5 invalid B8
  // creates, 30 unsupported timer_session) — and minus nothing else. The 10
  // rejected foreign updates and 5 foreign creates land in the FOREIGN
  // workspace ledger, not this one.
  const ledgerRows = await db
    .select({ status: syncMutations.status })
    .from(syncMutations)
    .where(eq(syncMutations.workspaceId, actor.workspaceId));
  const ledgerCounts: Record<string, number> = {};
  for (const r of ledgerRows) ledgerCounts[r.status] = (ledgerCounts[r.status] ?? 0) + 1;
  // One ledger row per unique mutation id that reached the server:
  //  - the 45 invalid/unsupported mutations were rejected before recording
  //  - replays of already-recorded ids report 'duplicate' but keep their
  //    original row (its first-processing status)
  const UNRECORDED_REJECTED = 45;
  const ledgerMatches =
    (ledgerCounts.applied ?? 0) === (status.applied ?? 0) &&
    (ledgerCounts.duplicate ?? 0) === (status.duplicate ?? 0) - workload.replayedOfRecorded &&
    (ledgerCounts.conflict ?? 0) === (status.conflict ?? 0) &&
    (ledgerCounts.rejected ?? 0) === (status.rejected ?? 0) - UNRECORDED_REJECTED;

  // Local-model equality: every device's pull-reconstructed cache equals
  // the server's live (non-deleted) state — tombstones included.
  if (firstModel) {
    const live = rows.filter((r) => r.status !== 'DELETED');
    modelSize = firstModel.size;
    if (firstModel.size !== live.length) modelMatchesServer = false;
    else {
      for (const row of live) {
        const local = firstModel.get(row.id);
        if (!local || local.title !== row.title || Number(local.version) !== row.version) {
          modelMatchesServer = false;
          break;
        }
      }
    }
    void modelSize;
  }

  const ackSorted = [...stats.ackMs].sort((x, y) => x - y);
  const passSorted = [...stats.passMs].sort((x, y) => x - y);
  const totalMutations = workload.totalMutations;
  return {
    totalMutations,
    quarantineMutations: workload.quarantineMutations,
    perDevice,
    statusCounts: status,
    simulatedServerFailures: stats.serverFailures,
    retries: stats.retries,
    peakQuarantined,
    finalQuarantined,
    drainWallMs,
    totalDrainMs: Math.round(totalDrainMs),
    throughputMutPerSec: Math.round((totalMutations / (totalDrainMs / 1000)) * 10) / 10,
    passLatencyMs: { p50: Math.round(percentile(passSorted, 50)), p95: Math.round(percentile(passSorted, 95)), p99: Math.round(percentile(passSorted, 99)), max: Math.round(Math.max(...passSorted, 0)), passes: passSorted.length },
    mutationAckMs: { p50: Math.round(percentile(ackSorted, 50)), p95: Math.round(percentile(ackSorted, 95)), p99: Math.round(percentile(ackSorted, 99)), max: Math.round(Math.max(...ackSorted, 0)) },
    rejectionCodes: stats.rejectionCodes,
    rejectionSamples: stats.rejectionSamples,
    connectedBurst: {
      count: burstIds.length,
      ms: { p50: Math.round(percentile(burstMsSorted, 50)), p95: Math.round(percentile(burstMsSorted, 95)), p99: Math.round(percentile(burstMsSorted, 99)), max: Math.round(Math.max(...burstMsSorted, 0)) },
      pctUnder5s: Math.round((under5s / burstIds.length) * 10000) / 100,
      allUnder5s: under5s === burstIds.length,
      mutPerSec: Math.round((burstIds.length / (burstTotalMs / 1000)) * 10) / 10,
    },
    pull: {
      perDevice: pullPerDevice,
      finalCursor,
      modelMatchesServer,
      modelSize,
      serverLiveSize: rows.filter((r) => r.status !== 'DELETED').length,
    },
    integrity: {
      entitiesChecked,
      mismatches: mismatches.length,
      mismatchSamples: mismatches.slice(0, 5),
      integrityRate: Math.round(integrityRate * 1e6) / 1e6,
      duplicateEntities,
      orderingViolations,
      snapshotsExpected: workload.snapshotsExpected,
      snapshotsFound: snapshots.length,
      snapshotPayloadPreserved,
      tombstonesCorrect,
      ledgerMatches,
      ledgerCounts,
      tenantViolations,
    },
  };
}
