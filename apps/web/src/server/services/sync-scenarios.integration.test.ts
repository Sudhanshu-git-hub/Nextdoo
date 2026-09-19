import { beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import { tasks, syncTombstones, syncMutations, syncChanges, timerSessions, conflictSnapshots } from '@nextdoo/db';
import { getDb } from '../db';

/**
 * Explicit scenario matrix for sync protocol v1 (PRD §10, roadmap item 7):
 * SY-01 through SY-09, plus push/pull ordering, tombstone protection,
 * duplicate/replay protection and tenant isolation.
 *
 * These are DB-backed end-to-end tests of the protocol as two devices would
 * exercise it: push mutations, pull by cursor, reconcile.
 */

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:55432/nextdoo';
const DEVICE_A = '44444444-4444-4444-8444-444444444901';
const DEVICE_B = '44444444-4444-4444-8444-444444444902';

async function probe(): Promise<true> {
  const { requireTestDatabase } = await import('../../../../../tests/database');
  return requireTestDatabase();
}

const available = await probe();
const maybe = () => (available ? it : it.skip);

let ctx: {
  sync: typeof import('./sync');
  tasksSvc: typeof import('./tasks');
  actor: { userId: string; workspaceId: string; requestId: string };
  actorB: { userId: string; workspaceId: string; requestId: string };
} | null = null;

let counter = 0;
function mutationId(): string {
  counter += 1;
  const tail = `${Date.now().toString(16)}${counter}`.slice(-12).padStart(12, '0');
  return `56565656-5656-4656-8656-${tail}`;
}
function entityUuid(): string {
  counter += 1;
  const tail = `${Date.now().toString(16)}${counter}`.slice(-12).padStart(12, '0');
  return `57575757-5757-4757-8757-${tail}`;
}

beforeAll(async () => {
  if (!available) return;
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.AUTH_SECRET ??= 'test-only-secret-0123456789abcdefghij';

  const { registerUser } = await import('./accounts');
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const user = await registerUser({
    email: `sync-scen-a-${stamp}@test.local`,
    passwordHash: 'scrypt$deadbeef$deadbeef',
    name: 'Sync Scenario A',
    timeZone: 'UTC',
  });
  const userB = await registerUser({
    email: `sync-scen-b-${stamp}@test.local`,
    passwordHash: 'scrypt$deadbeef$deadbeef',
    name: 'Sync Scenario B',
    timeZone: 'UTC',
  });

  ctx = {
    sync: await import('./sync'),
    tasksSvc: await import('./tasks'),
    actor: { userId: user.id, workspaceId: user.workspaceId, requestId: 'test' },
    actorB: { userId: userB.id, workspaceId: userB.workspaceId, requestId: 'test' },
  };
}, 30000);

async function newTask(title: string) {
  const { tasksSvc, actor } = ctx!;
  return tasksSvc.createTask(actor, {
    workspaceId: actor.workspaceId,
    title,
    tagIds: [],
    priority: 'NONE',
  } as never);
}

function push(device: string, mutations: Array<Record<string, unknown>>) {
  const { actor } = ctx!;
  return ctx!.sync.pushMutations(actor, { deviceId: device, mutations: mutations as never });
}

describe('sync scenario matrix (integration)', () => {
  maybe()('SY-01: an offline create with a client UUID is accepted and visible to the other device via pull', async () => {
    const { sync } = ctx!;
    const taskId = entityUuid();
    const dueAt = new Date(Date.now() + 86_400_000).toISOString();

    const { results } = await push(DEVICE_A, [{
      mutationId: mutationId(),
      entityType: 'task',
      entityId: taskId,
      operation: 'create',
      baseVersion: null,
      payload: { title: 'Captured offline on device A', dueAt, tagIds: [], priority: 'NONE', timeZone: 'UTC' },
      createdAt: new Date().toISOString(),
    }]);

    expect(results[0]!.status).toBe('applied');
    expect((results[0]!.entity as { id: string }).id).toBe(taskId);

    // Device B pulls from zero and must see the created task.
    const page = await sync.pullChanges(ctx!.actor.workspaceId, 0, 200);
    const change = page.changes.find((c) => c.entityId === taskId);
    expect(change).toBeDefined();
    expect(change!.operation).toBe('create');
    expect((change!.payload as { title: string }).title).toBe('Captured offline on device A');
  });

  maybe()('SY-02: replaying an identical push is a duplicate and never creates a second entity', async () => {
    const { sync, actor } = ctx!;
    const taskId = entityUuid();
    const mutation = {
      mutationId: mutationId(),
      entityType: 'task' as const,
      entityId: taskId,
      operation: 'create' as const,
      baseVersion: null,
      payload: { title: 'Replayed create', tagIds: [], priority: 'NONE', timeZone: 'UTC' },
      createdAt: new Date().toISOString(),
    };

    const first = await sync.pushMutations(actor, { deviceId: DEVICE_A, mutations: [mutation] });
    expect(first.results[0]!.status).toBe('applied');

    // Simulated network retry: the exact same batch again.
    const second = await sync.pushMutations(actor, { deviceId: DEVICE_A, mutations: [mutation] });
    expect(second.results[0]!.status).toBe('duplicate');
    expect((second.results[0]!.entity as { id: string }).id).toBe(taskId);

    const db = getDb();
    const rows = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.version).toBe(1);
  });

  maybe()('SY-03: concurrent edits to different fields on two devices are both retained', async () => {
    const task = await newTask('Two devices, two fields');
    const { sync, actor } = ctx!;

    const [resA, resB] = await Promise.all([
      sync.pushMutations(actor, { deviceId: DEVICE_A, mutations: [{
        mutationId: mutationId(),
        entityType: 'task',
        entityId: task.id,
        operation: 'update',
        baseVersion: task.version,
        payload: { priority: 'HIGH' },
        createdAt: new Date().toISOString(),
      }] }),
      sync.pushMutations(actor, { deviceId: DEVICE_B, mutations: [{
        mutationId: mutationId(),
        entityType: 'task',
        entityId: task.id,
        operation: 'update',
        baseVersion: task.version,
        payload: { estimateMinutes: 45 },
        createdAt: new Date().toISOString(),
      }] }),
    ]);

    expect(resA.results[0]!.status).toBe('applied');
    expect(resB.results[0]!.status).toBe('applied');

    const db = getDb();
    const [final] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(final!.priority).toBe('HIGH');
    expect(final!.estimateMinutes).toBe(45);
  });

  maybe()('SY-04: a same-field conflict is surfaced, no content is lost, and a resolution applies it', async () => {
    const task = await newTask('Original title');
    const { sync } = ctx!;

    // Device A rewrites the title first…
    const first = await push(DEVICE_A, [{
      mutationId: mutationId(),
      entityType: 'task',
      entityId: task.id,
      operation: 'update',
      baseVersion: task.version,
      payload: { title: 'Device A version of the title' },
      createdAt: new Date().toISOString(),
    }]);
    expect(first.results[0]!.status).toBe('applied');

    // …device B, still on the old base, rewrites it too.
    const second = await push(DEVICE_B, [{
      mutationId: mutationId(),
      entityType: 'task',
      entityId: task.id,
      operation: 'update',
      baseVersion: task.version,
      payload: { title: 'Device B version of the title' },
      createdAt: new Date().toISOString(),
    }]);
    expect(second.results[0]!.status).toBe('conflict');

    const conflicts = await sync.listConflicts(ctx!.actor.workspaceId);
    const ours = conflicts.find((c) => c.entityId === task.id && c.resolvedAt === null);
    expect(ours).toBeDefined();
    expect((ours!.localPayload as { title: string }).title).toBe('Device B version of the title');
    expect((ours!.serverPayload as { title: string }).title).toBe('Device A version of the title');

    // Server still holds A's value; B's text is recoverable, not gone.
    const db = getDb();
    const [now] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(now!.title).toBe('Device A version of the title');

    await sync.resolveConflict(ctx!.actor as never, ours!.id, 'local');
    const [after] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(after!.title).toBe('Device B version of the title');
    const remaining = await sync.listConflicts(ctx!.actor.workspaceId);
    expect(remaining.some((c) => c.id === ours!.id && c.resolvedAt === null)).toBe(false);
  });

  maybe()('SY-05: delete wins, the tombstone propagates via pull, and restore resurrects the task', async () => {
    const task = await newTask('Scheduled for deletion');
    const { sync } = ctx!;

    const del = await push(DEVICE_A, [{
      mutationId: mutationId(),
      entityType: 'task',
      entityId: task.id,
      operation: 'delete',
      baseVersion: task.version,
      payload: {},
      createdAt: new Date().toISOString(),
    }]);
    expect(del.results[0]!.status).toBe('applied');

    // B still has a pending edit based on the pre-delete version.
    const stale = await push(DEVICE_B, [{
      mutationId: mutationId(),
      entityType: 'task',
      entityId: task.id,
      operation: 'update',
      baseVersion: task.version,
      payload: { title: 'Late edit after remote delete' },
      createdAt: new Date().toISOString(),
    }]);
    expect(stale.results[0]!.status).toBe('rejected');

    // Pull stream must carry the deletion so B removes it locally.
    const page = await sync.pullChanges(ctx!.actor.workspaceId, 0, 500);
    const change = [...page.changes].reverse().find((c) => c.entityId === task.id && c.operation === 'delete');
    expect(change).toBeDefined();

    // A tombstone row guards restore semantics.
    const db = getDb();
    const [tomb] = await db.select().from(syncTombstones).where(eq(syncTombstones.entityId, task.id));
    expect(tomb).toBeDefined();

    await ctx!.tasksSvc.restoreTask(ctx!.actor as never, task.id);
    const [restored] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(restored!.status).toBe('ACTIVE');
    const [tombAfter] = await db.select().from(syncTombstones).where(eq(syncTombstones.entityId, task.id));
    expect(tombAfter).toBeUndefined();
  });

  maybe()('push applies same-entity mutations in batch order and pull returns them by sequence', async () => {
    const task = await newTask('Ordered batch');
    const { sync } = ctx!;

    const { results } = await push(DEVICE_A, [
      { mutationId: mutationId(), entityType: 'task', entityId: task.id, operation: 'update', baseVersion: task.version, payload: { title: 'step one' }, createdAt: new Date().toISOString() },
      { mutationId: mutationId(), entityType: 'task', entityId: task.id, operation: 'update', baseVersion: task.version, payload: { priority: 'MEDIUM' }, createdAt: new Date().toISOString() },
      { mutationId: mutationId(), entityType: 'task', entityId: task.id, operation: 'update', baseVersion: task.version, payload: { estimateMinutes: 30 }, createdAt: new Date().toISOString() },
    ]);

    // Each acknowledgement reflects the state at its position in the sequence.
    expect((results[0]!.entity as { title: string }).title).toBe('step one');
    expect((results[0]!.entity as { priority: string }).priority).not.toBe('MEDIUM');
    expect((results[1]!.entity as { title: string; priority: string }).priority).toBe('MEDIUM');
    expect((results[2]!.entity as { estimateMinutes: number }).estimateMinutes).toBe(30);

    const db = getDb();
    const [final] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(final!.version).toBe(task.version + 3);

    // Pull is strictly ordered by sequence; a second page from the cursor
    // continues where the first stopped.
    const first = await sync.pullChanges(ctx!.actor.workspaceId, 0, 2);
    expect(first.hasMore).toBe(true);
    const second = await sync.pullChanges(ctx!.actor.workspaceId, first.cursor, 2);
    for (let i = 1; i < first.changes.length; i += 1) {
      expect(Number(first.changes[i]!.sequence)).toBeGreaterThan(Number(first.changes[i - 1]!.sequence));
    }
    if (second.changes.length) {
      expect(Number(second.changes[0]!.sequence)).toBeGreaterThan(Number(first.changes[first.changes.length - 1]!.sequence));
    }
  });

  maybe()('tombstones protect deleted tasks: delete-of-deleted is a duplicate and edits are preserved, not applied', async () => {
    const task = await newTask('Tombstone protection');
    const { sync } = ctx!;

    const first = await push(DEVICE_A, [{
      mutationId: mutationId(),
      entityType: 'task',
      entityId: task.id,
      operation: 'delete',
      baseVersion: task.version,
      payload: {},
      createdAt: new Date().toISOString(),
    }]);
    expect(first.results[0]!.status).toBe('applied');

    const again = await push(DEVICE_B, [{
      mutationId: mutationId(),
      entityType: 'task',
      entityId: task.id,
      operation: 'delete',
      baseVersion: task.version,
      payload: {},
      createdAt: new Date().toISOString(),
    }]);
    expect(again.results[0]!.status).toBe('duplicate');

    const edit = await push(DEVICE_B, [{
      mutationId: mutationId(),
      entityType: 'task',
      entityId: task.id,
      operation: 'update',
      baseVersion: task.version,
      payload: { title: 'Must survive in a snapshot' },
      createdAt: new Date().toISOString(),
    }]);
    expect(edit.results[0]!.status).toBe('rejected');

    const db = getDb();
    const [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row!.status).toBe('DELETED');
    expect(row!.title).toBe('Tombstone protection');

    const conflicts = await sync.listConflicts(ctx!.actor.workspaceId);
    const ours = conflicts.find((c) => c.entityId === task.id && c.resolvedAt === null);
    expect((ours?.localPayload as { title?: string })?.title).toBe('Must survive in a snapshot');
    // Retained for the 30-day restore window per PRD §10.6.
    expect(ours!.expiresAt.getTime() - Date.now()).toBeGreaterThan(29 * 86_400_000);
  });

  maybe()('duplicate protection: replaying an update returns the original outcome without advancing state', async () => {
    const task = await newTask('Replay update');
    const { sync } = ctx!;
    const mutation = {
      mutationId: mutationId(),
      entityType: 'task' as const,
      entityId: task.id,
      operation: 'update' as const,
      baseVersion: task.version,
      payload: { priority: 'LOW' },
      createdAt: new Date().toISOString(),
    };

    const first = await sync.pushMutations(ctx!.actor, { deviceId: DEVICE_A, mutations: [mutation] });
    const versionAfterFirst = (first.results[0]!.entity as { version: number }).version;
    expect(first.results[0]!.status).toBe('applied');

    const replay = await sync.pushMutations(ctx!.actor, { deviceId: DEVICE_B, mutations: [mutation] });
    expect(replay.results[0]!.status).toBe('duplicate');
    expect((replay.results[0]!.entity as { version: number }).version).toBe(versionAfterFirst);

    const db = getDb();
    const [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row!.version).toBe(versionAfterFirst);
  });

  maybe()('tenant isolation: one account cannot read or write another account\'s entities', async () => {
    const { sync, actorB } = ctx!;
    const task = await newTask('Private to account A');

    // B pushing an update against A\'s entity id finds nothing in B\'s scope.
    const { results } = await sync.pushMutations(actorB, { deviceId: DEVICE_B, mutations: [{
      mutationId: mutationId(),
      entityType: 'task',
      entityId: task.id,
      operation: 'update',
      baseVersion: task.version,
      payload: { title: 'Tenant leak attempt' },
      createdAt: new Date().toISOString(),
    }] });
    expect(results[0]!.status).toBe('rejected');

    // Relabelling the push with A\'s workspace under B\'s session is refused.
    await expect(
      sync.pushMutations(actorB, { workspaceId: ctx!.actor.workspaceId, deviceId: DEVICE_B, mutations: [{
        mutationId: mutationId(),
        entityType: 'task',
        entityId: task.id,
        operation: 'update',
        baseVersion: task.version,
        payload: { title: 'Relabel attempt' },
        createdAt: new Date().toISOString(),
      }] }),
    ).rejects.toThrow(/not the authenticated workspace/i);

    const db = getDb();
    const [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row!.title).toBe('Private to account A');
    // B\'s pull stream contains none of A\'s changes.
    const page = await sync.pullChanges(actorB.workspaceId, 0, 200);
    expect(page.changes.some((c) => c.entityId === task.id)).toBe(false);
  });

  maybe()('completion preservation: a concurrent completion outranks a queued status edit', async () => {
    const task = await newTask('Finish race');
    const { sync } = ctx!;

    const done = await push(DEVICE_A, [{
      mutationId: mutationId(),
      entityType: 'task',
      entityId: task.id,
      operation: 'update',
      baseVersion: task.version,
      payload: { status: 'COMPLETED' },
      createdAt: new Date().toISOString(),
    }]);
    expect(done.results[0]!.status).toBe('applied');

    const staleStatus = await push(DEVICE_B, [{
      mutationId: mutationId(),
      entityType: 'task',
      entityId: task.id,
      operation: 'update',
      baseVersion: task.version,
      payload: { status: 'ACTIVE' },
      createdAt: new Date().toISOString(),
    }]);

    const db = getDb();
    const [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    // Completion is preserved no matter what the stale edit requested.
    expect(row!.status).toBe('COMPLETED');
    // And the refused edit is not silently lost — it is retained for review.
    const conflicts = await sync.listConflicts(ctx!.actor.workspaceId);
    expect(conflicts.some((c) => c.entityId === task.id && (c.localPayload as { status?: string }).status === 'ACTIVE')).toBe(true);
    expect(staleStatus.results[0]!.entity).toBeDefined();
  });

  maybe()('SY-06: complete on A, reschedule on B — the completion is preserved, the new due date stands', async () => {
    const task = await newTask('Complete vs reschedule');

    // A completes it.
    const done = await push(DEVICE_A, [{
      mutationId: mutationId(),
      entityType: 'task',
      entityId: task.id,
      operation: 'update',
      baseVersion: task.version,
      payload: { status: 'COMPLETED' },
      createdAt: new Date().toISOString(),
    }]);
    expect(done.results[0]!.status).toBe('applied');

    // B, still on the pre-completion base, reschedules (no status field).
    const nextDue = new Date(Date.now() + 48 * 3600000).toISOString();
    const reschedule = await push(DEVICE_B, [{
      mutationId: mutationId(),
      entityType: 'task',
      entityId: task.id,
      operation: 'update',
      baseVersion: task.version,
      payload: { dueAt: nextDue },
      createdAt: new Date().toISOString(),
    }]);
    expect(reschedule.results[0]!.status).toBe('applied');

    const db = getDb();
    const [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    // The scalar due-date change is last-write-wins and applies…
    expect(row!.dueAt!.toISOString()).toBe(new Date(nextDue).toISOString());
    // …but the completion outranks the stale base and survives.
    expect(row!.status).toBe('COMPLETED');
    expect(row!.completedAt).not.toBeNull();
  });

  maybe()('SY-07: a timer running on two devices keeps both sessions and flags the overlap', async () => {
    const task = await newTask('Two-device timer');
    const { actor } = ctx!;
    const { startTimer } = await import('./timers');

    const base = Date.now();
    // Device A starts first.
    const a = await startTimer(actor, task.id, DEVICE_A, new Date(base).toISOString());
    // Device B starts a minute later — the second device must not delete the
    // first: it closes it and flags OVERLAPPED.
    const b = await startTimer(actor, task.id, DEVICE_B, new Date(base + 60000).toISOString());

    expect(a.status).toBe('RUNNING');
    expect(b.status).toBe('RUNNING');

    const db = getDb();
    const [aRow] = await db.select().from(timerSessions).where(eq(timerSessions.id, a.id));
    const [bRow] = await db.select().from(timerSessions).where(eq(timerSessions.id, b.id));
    // Both rows are retained — neither is ever deleted.
    expect(aRow).toBeDefined();
    expect(bRow).toBeDefined();
    expect(aRow!.status).toBe('OVERLAPPED');
    expect(bRow!.status).toBe('RUNNING');
    expect(aRow!.endedAt).not.toBeNull();
    expect(aRow!.accumulatedSeconds).toBeGreaterThanOrEqual(59);
    // The canonical session is the newer one (PRD §6.7).
    expect(bRow!.deviceId).toBe(DEVICE_B);

    // A third, chronologically older session from another device is recorded
    // as OVERLAPPED instead of re-opening the canonical one.
    const c = await startTimer(actor, task.id, '33333333-3333-4333-8333-333333333903', new Date(base - 30000).toISOString());
    expect(c.status).toBe('OVERLAPPED');
    const [bAfter] = await db.select().from(timerSessions).where(eq(timerSessions.id, b.id));
    expect(bAfter!.status).toBe('RUNNING');
    const [cRow] = await db.select().from(timerSessions).where(eq(timerSessions.id, c.id));
    expect(cRow).toBeDefined();
    expect(cRow!.status).toBe('OVERLAPPED');
    expect(cRow!.accumulatedSeconds).toBeGreaterThanOrEqual(29);
  });

  maybe()('SY-08: a 10-minute clock skew cannot reorder the stream — server timestamps are authoritative', async () => {
    const task = await newTask('Clock skew');
    const { sync } = ctx!;

    // Device B believes its clock is 10 minutes AHEAD.
    const skewed = new Date(Date.now() + 10 * 60000).toISOString();
    const first = await push(DEVICE_B, [{
      mutationId: mutationId(),
      entityType: 'task',
      entityId: task.id,
      operation: 'update',
      baseVersion: task.version,
      payload: { title: 'Skewed device wrote first' },
      createdAt: skewed,
    }]);
    expect(first.results[0]!.status).toBe('applied');

    // Device A (correct clock) writes second.
    const after = await push(DEVICE_A, [{
      mutationId: mutationId(),
      entityType: 'task',
      entityId: task.id,
      operation: 'update',
      baseVersion: (first.results[0]!.entity as { version: number }).version,
      payload: { title: 'Correct device wrote second' },
      createdAt: new Date().toISOString(),
    }]);
    expect(after.results[0]!.status).toBe('applied');

    // Pull order is the SERVER processing order, not the client clocks.
    const page = await sync.pullChanges(ctx!.actor.workspaceId, 0, 500);
    const seq = (t: string) => page.changes.filter((c) => c.entityId === task.id && (c.payload as { title?: string }).title === t).map((c) => Number(c.sequence));
    expect(seq('Skewed device wrote first')).toHaveLength(1);
    expect(seq('Correct device wrote second')).toHaveLength(1);
    expect(seq('Correct device wrote second')[0]!).toBeGreaterThan(seq('Skewed device wrote first')[0]!);

    // Server-recorded timestamps on the sync stream are server time — never
    // the skewed client time (a 10-minute skew would be far outside this).
    const db = getDb();
    const rows = await db
      .select()
      .from(syncChanges)
      .where(and(eq(syncChanges.workspaceId, ctx!.actor.workspaceId), eq(syncChanges.entityId, task.id)))
      .orderBy(desc(syncChanges.createdAt));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const r of rows) {
      expect(Math.abs(r.createdAt.getTime() - Date.now())).toBeLessThan(5 * 60000);
    }
  });

  maybe()('SY-09: a batch with one invalid mutation applies the others and quarantines the bad one', async () => {
    const { sync } = ctx!;
    // A task that will be deleted before the batch arrives.
    const doomed = await newTask('Deleted before batch');
    const del = await push(DEVICE_A, [{ mutationId: mutationId(), entityType: 'task', entityId: doomed.id, operation: 'delete', baseVersion: doomed.version, payload: {}, createdAt: new Date().toISOString() }]);
    expect(del.results[0]!.status).toBe('applied');

    const id1 = entityUuid();
    const badId = mutationId();
    const badCreatedAt = new Date().toISOString();

    const { results } = await push(DEVICE_B, [
      { mutationId: mutationId(), entityType: 'task', entityId: id1, operation: 'create', baseVersion: null, payload: { title: 'Good one', tagIds: [], priority: 'NONE' }, createdAt: new Date().toISOString() },
      // Invalid: an edit arriving for a task deleted on another device.
      { mutationId: badId, entityType: 'task', entityId: doomed.id, operation: 'update', baseVersion: doomed.version, payload: { title: 'Late edit, kept for review' }, createdAt: badCreatedAt },
      { mutationId: mutationId(), entityType: 'task', entityId: id1, operation: 'update', baseVersion: 1, payload: { estimateMinutes: 25 }, createdAt: new Date().toISOString() },
    ]);

    // Partial batch failure: the good mutations are acknowledged individually.
    expect(results[0]!.status).toBe('applied');
    expect(results[1]!.status).toBe('rejected');
    expect(results[1]!.error).toBeDefined();
    expect(results[2]!.status).toBe('applied');

    const db = getDb();
    const [good] = await db.select().from(tasks).where(eq(tasks.id, id1));
    expect(good).toBeDefined();
    expect(good!.estimateMinutes).toBe(25);
    const [doomedRow] = await db.select().from(tasks).where(eq(tasks.id, doomed.id));
    // The deletion stands — the late edit did not resurrect it.
    expect(doomedRow!.status).toBe('DELETED');

    // The refused edit is not silently lost: a snapshot holds the content.
    const conflicts = await sync.listConflicts(ctx!.actor.workspaceId);
    expect(conflicts.some((c) => c.entityId === doomed.id && (c.localPayload as { title: string }).title === 'Late edit, kept for review')).toBe(true);

    // And the mutation is quarantined in the ledger: a replay of the SAME
    // mutation returns the original rejection, and a different payload under
    // the same id is refused — nothing is silently re-run.
    const [recorded] = await db.select().from(syncMutations).where(eq(syncMutations.mutationId, badId));
    expect(recorded).toBeDefined();
    expect(recorded!.status).toBe('rejected');
    const replay = await push(DEVICE_B, [{ mutationId: badId, entityType: 'task', entityId: doomed.id, operation: 'update', baseVersion: doomed.version, payload: { title: 'Late edit, kept for review' }, createdAt: badCreatedAt }]);
    expect(replay.results[0]!.status).toBe('rejected');
    const [doomedAfter] = await db.select().from(tasks).where(eq(tasks.id, doomed.id));
    expect(doomedAfter!.status).toBe('DELETED');
    const swapped = await push(DEVICE_B, [{ mutationId: badId, entityType: 'task', entityId: doomed.id, operation: 'update', baseVersion: doomed.version, payload: { title: 'Something else entirely' }, createdAt: badCreatedAt }]);
    expect(swapped.results[0]!.status).toBe('rejected');
    expect((swapped.results[0]!.error as { code: string }).code).toBe('IDEMPOTENCY_CONFLICT');
  });

  maybe()('conflict resolution: server keeps the canonical row, local re-applies through the task path, replays are safe, and tenants cannot touch each other', async () => {
    const { sync, actor, actorB } = ctx!;
    const task = await newTask('Adjudicate me');

    // A and B both rewrite the title from the same base → conflict.
    await push(DEVICE_A, [{ mutationId: mutationId(), entityType: 'task', entityId: task.id, operation: 'update', baseVersion: task.version, payload: { title: 'Server stands' }, createdAt: new Date().toISOString() }]);
    const conflict = await push(DEVICE_B, [{ mutationId: mutationId(), entityType: 'task', entityId: task.id, operation: 'update', baseVersion: task.version, payload: { title: 'Local wins' }, createdAt: new Date().toISOString() }]);
    expect(conflict.results[0]!.status).toBe('conflict');

    const open = await sync.listConflicts(actor.workspaceId);
    const snapshot = open.find((c) => c.entityId === task.id);
    expect(snapshot).toBeDefined();

    // 'server' marks the snapshot resolved and changes nothing else.
    const db = getDb();
    const [before] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    await sync.resolveConflict(actor as never, snapshot!.id, 'server');
    const [afterServer] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    const [resolvedRow] = await db.select().from(conflictSnapshots).where(eq(conflictSnapshots.id, snapshot!.id));
    expect(afterServer!.title).toBe('Server stands');
    expect(afterServer!.version).toBe(before!.version);
    expect(resolvedRow!.resolvedAt).not.toBeNull();
    expect(resolvedRow!.resolution).toBe('server');
    expect((await sync.listConflicts(actor.workspaceId)).some((c) => c.id === snapshot!.id)).toBe(false);

    // A fresh conflict, resolved 'local': the preserved payload is re-applied
    // through the normal task command path (version + 1, sync change emitted).
    await push(DEVICE_A, [{ mutationId: mutationId(), entityType: 'task', entityId: task.id, operation: 'update', baseVersion: afterServer!.version, payload: { title: 'Server round two' }, createdAt: new Date().toISOString() }]);
    await push(DEVICE_B, [{ mutationId: mutationId(), entityType: 'task', entityId: task.id, operation: 'update', baseVersion: afterServer!.version, payload: { title: 'Local round two' }, createdAt: new Date().toISOString() }]);
    const open2 = await sync.listConflicts(actor.workspaceId);
    const snapshot2 = open2.find((c) => c.entityId === task.id);
    expect(snapshot2).toBeDefined();
    const seqBefore = (await sync.pullChanges(actor.workspaceId, 0, 1000)).cursor;
    const [preResolve] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    await sync.resolveConflict(actor as never, snapshot2!.id, 'local');
    const [afterLocal] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(afterLocal!.title).toBe('Local round two');
    // Exactly one write through the normal task path.
    expect(afterLocal!.version).toBe(preResolve!.version + 1);
    const pulled = await sync.pullChanges(actor.workspaceId, Number(seqBefore), 1000);
    expect(pulled.changes.some((c) => c.entityId === task.id && c.operation === 'update')).toBe(true);

    // Re-resolving an already-resolved snapshot is a no-op, not a second write.
    await sync.resolveConflict(actor as never, snapshot2!.id, 'local');
    const [afterReplay] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(afterReplay!.version).toBe(afterLocal!.version);

    // Tenant isolation: the other tenant neither sees it nor can resolve it.
    expect((await sync.listConflicts(actorB.workspaceId)).some((c) => c.id === snapshot!.id)).toBe(false);
    await sync.resolveConflict(actorB as never, snapshot!.id, 'local');
    const [untouched] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(untouched!.title).toBe('Local round two');
  });
});
