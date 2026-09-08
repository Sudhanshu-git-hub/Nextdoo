import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Sync integration tests (PRD §10).
 *
 * The governing rule is that a user's typed content is never silently
 * discarded: anything the server refuses must still be recoverable.
 */

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:55432/nextdoo';
const DEVICE_A = '44444444-4444-4444-8444-444444444401';
const DEVICE_B = '44444444-4444-4444-8444-444444444402';

async function probe(): Promise<boolean> {
  try {
    const { default: postgres } = await import('postgres');
    const sql = postgres(DATABASE_URL, { max: 1, connect_timeout: 3 });
    await sql`select 1`;
    await sql.end();
    return true;
  } catch {
    return false;
  }
}

const available = await probe();
const maybe = () => (available ? it : it.skip);

let ctx: {
  sync: typeof import('./sync');
  tasks: typeof import('./tasks');
  actor: { userId: string; workspaceId: string; requestId: string };
} | null = null;

let counter = 0;
/** Deterministic, unique v4-shaped ids so mutation ids never collide across runs. */
function mutationId(): string {
  counter += 1;
  const tail = `${Date.now().toString(16)}${counter}`.slice(-12).padStart(12, '0');
  return `55555555-5555-4555-8555-${tail}`;
}

beforeAll(async () => {
  if (!available) return;
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.AUTH_SECRET ??= 'test-only-secret-0123456789abcdefghij';

  const { registerUser } = await import('./accounts');
  const user = await registerUser({
    email: `sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`,
    passwordHash: 'scrypt$deadbeef$deadbeef',
    name: 'Sync Test',
    timeZone: 'UTC',
  });

  ctx = {
    sync: await import('./sync'),
    tasks: await import('./tasks'),
    actor: { userId: user.id, workspaceId: user.workspaceId, requestId: 'test' },
  };
}, 30000);

async function newTask(title: string) {
  const { tasks, actor } = ctx!;
  return tasks.createTask(actor, {
    workspaceId: actor.workspaceId,
    title,
    tagIds: [],
    priority: 'NONE',
  } as never);
}

describe('sync engine (integration)', () => {
  maybe()('applies a mutation whose base version matches the server', async () => {
    const { sync, actor } = ctx!;
    const task = await newTask('Fast forward');

    const { results } = await sync.pushMutations(actor, {
      deviceId: DEVICE_A,
      mutations: [
        {
          mutationId: mutationId(),
          entityType: 'task',
          entityId: task.id,
          operation: 'update',
          baseVersion: task.version,
          payload: { title: 'Updated from device A' },
          createdAt: new Date().toISOString(),
        },
      ],
    } as never);

    expect(results[0]!.status).toBe('applied');
  });

  maybe()('treats a replayed mutation id as a duplicate rather than applying it twice', async () => {
    const { sync, actor, tasks } = ctx!;
    const task = await newTask('Replay safety');
    const id = mutationId();

    const mutation = {
      mutationId: id,
      entityType: 'task' as const,
      entityId: task.id,
      operation: 'update' as const,
      baseVersion: task.version,
      payload: { title: 'Applied once' },
      createdAt: new Date().toISOString(),
    };

    const first = await sync.pushMutations(actor, { deviceId: DEVICE_A, mutations: [mutation] } as never);
    const second = await sync.pushMutations(actor, { deviceId: DEVICE_A, mutations: [mutation] } as never);

    expect(first.results[0]!.status).toBe('applied');
    expect(second.results[0]!.status).toBe('duplicate');

    const current = await tasks.loadTask(actor.workspaceId, task.id);
    // Applied exactly once: version advanced by one, not two.
    expect(current.version).toBe(task.version + 1);
  });

  maybe()('escalates a conflicting title edit and preserves the rejected text', async () => {
    const { sync, actor } = ctx!;
    const task = await newTask('Conflict source');

    // Device A wins the race.
    await sync.pushMutations(actor, {
      deviceId: DEVICE_A,
      mutations: [
        {
          mutationId: mutationId(),
          entityType: 'task',
          entityId: task.id,
          operation: 'update',
          baseVersion: task.version,
          payload: { title: 'Title from A' },
          createdAt: new Date().toISOString(),
        },
      ],
    } as never);

    // Device B was offline and still holds the original version.
    const { results } = await sync.pushMutations(actor, {
      deviceId: DEVICE_B,
      mutations: [
        {
          mutationId: mutationId(),
          entityType: 'task',
          entityId: task.id,
          operation: 'update',
          baseVersion: task.version,
          payload: { title: 'Title from B' },
          createdAt: new Date().toISOString(),
        },
      ],
    } as never);

    expect(results[0]!.status).toBe('conflict');

    // The losing text must still be recoverable by the user.
    const conflicts = await sync.listConflicts(actor.workspaceId);
    const saved = conflicts.find((c) => c.entityId === task.id);
    expect(saved).toBeDefined();
    expect(JSON.stringify(saved!.localPayload)).toContain('Title from B');
  });

  maybe()('pull returns changes after a cursor and advances it monotonically', async () => {
    const { sync, actor } = ctx!;
    const before = await sync.currentCursor(actor.workspaceId);

    await newTask('Cursor probe');

    const page = await sync.pullChanges(actor.workspaceId, before, 100);
    expect(page.changes.length).toBeGreaterThan(0);
    expect(page.cursor).toBeGreaterThan(before);
    // Sequences are strictly increasing, so a client can resume safely.
    const sequences = page.changes.map((c) => c.sequence);
    expect([...sequences].sort((a, b) => a - b)).toEqual(sequences);
  });

  maybe()('pulling from the latest cursor returns nothing', async () => {
    const { sync, actor } = ctx!;
    const cursor = await sync.currentCursor(actor.workspaceId);
    const page = await sync.pullChanges(actor.workspaceId, cursor, 100);
    expect(page.changes).toHaveLength(0);
  });

  maybe()('ignores fields that are not client-writable', async () => {
    const { sync, tasks, actor } = ctx!;
    const task = await newTask('Field allow-list');

    await sync.pushMutations(actor, {
      deviceId: DEVICE_A,
      mutations: [
        {
          mutationId: mutationId(),
          entityType: 'task',
          entityId: task.id,
          operation: 'update',
          baseVersion: task.version,
          // `workspaceId` must never be reassignable by a client.
          payload: { title: 'Legit change', workspaceId: '00000000-0000-4000-8000-000000000000' },
          createdAt: new Date().toISOString(),
        },
      ],
    } as never);

    const current = await tasks.loadTask(actor.workspaceId, task.id);
    expect(current.title).toBe('Legit change');
    expect(current.workspaceId).toBe(actor.workspaceId);
  });

  maybe()('isolates failures so one bad mutation does not drop the rest of the batch', async () => {
    const { sync, actor } = ctx!;
    const good = await newTask('Batch survivor');

    const { results } = await sync.pushMutations(actor, {
      deviceId: DEVICE_A,
      mutations: [
        {
          mutationId: mutationId(),
          entityType: 'task',
          entityId: '00000000-0000-4000-8000-00000000dead',
          operation: 'update',
          baseVersion: 1,
          payload: { title: 'Refers to a missing task' },
          createdAt: new Date().toISOString(),
        },
        {
          mutationId: mutationId(),
          entityType: 'task',
          entityId: good.id,
          operation: 'update',
          baseVersion: good.version,
          payload: { title: 'Should still apply' },
          createdAt: new Date().toISOString(),
        },
      ],
    } as never);

    expect(results).toHaveLength(2);
    expect(results[0]!.status).not.toBe('applied');
    expect(results[1]!.status).toBe('applied');
  });
});
