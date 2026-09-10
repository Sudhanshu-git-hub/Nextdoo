import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { tasks, syncTombstones } from '@nextdoo/db';
import { getDb } from '../db';

/**
 * Explicit scenario matrix for sync protocol v1 (PRD §10, roadmap item 7):
 * SY-01 through SY-05, plus push/pull ordering, tombstone protection,
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
});
