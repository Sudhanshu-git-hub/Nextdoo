import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '@nextdoo/contracts';

/**
 * Integration tests against a real PostgreSQL instance.
 *
 * These exercise the invariants that cannot be proven with pure unit tests:
 * optimistic locking, append-only tracking, workspace isolation and soft
 * deletion. They are skipped (not failed) when no database is configured, so a
 * checkout without `pnpm dev:services` running still has a green suite.
 */

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:55432/nextdoo';

let ctx: Awaited<ReturnType<typeof setup>> | null = null;

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

async function setup() {
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.AUTH_SECRET ??= 'test-only-secret-0123456789abcdefghij';

  const { registerUser } = await import('./accounts');
  const tasks = await import('./tasks');
  const tracking = await import('./tracking');
  const { getDb } = await import('../db');

  const email = `it-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
  const user = await registerUser({
    email,
    passwordHash: 'scrypt$deadbeef$deadbeef',
    name: 'Integration Test',
    timeZone: 'UTC',
  });

  const other = await registerUser({
    email: `other-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`,
    passwordHash: 'scrypt$deadbeef$deadbeef',
    name: 'Other Tenant',
    timeZone: 'UTC',
  });

  return {
    tasks,
    tracking,
    getDb,
    actor: { userId: user.id, workspaceId: user.workspaceId, requestId: 'test' },
    otherActor: { userId: other.id, workspaceId: other.workspaceId, requestId: 'test' },
  };
}

/**
 * Probed at module scope, not in `beforeAll`: `it.skip` is chosen while the
 * suite is being collected, which happens before any hook has run.
 */
const available = await probe();

beforeAll(async () => {
  if (available) ctx = await setup();
}, 30000);

afterAll(async () => {
  if (!ctx) return;
  const { closeDb } = await import('../db');
  await closeDb();
});

const maybe = () => (available ? it : it.skip);

if (!available) {
  console.warn(`[integration] no database at ${DATABASE_URL} — skipping. Run \`pnpm dev:services\` first.`);
}

describe('task service (integration)', () => {
  maybe()('creates a task and records an append-only tracking event', async () => {
    const { tasks, tracking, actor } = ctx!;
    const task = await tasks.createTask(actor, {
      workspaceId: actor.workspaceId,
      title: 'Integration task',
      estimateMinutes: 45,
      priority: 'MEDIUM',
      tagIds: [],
    } as never);

    expect(task.id).toBeTruthy();
    expect(task.version).toBe(1);
    expect(task.status).toBe('ACTIVE');

    const events = await tracking.listTrackingEvents(actor.workspaceId, task.id);
    expect(events.map((e) => e.type)).toContain('TASK_CREATED');
  });

  maybe()('rejects a stale version instead of overwriting a concurrent edit', async () => {
    const { tasks, actor } = ctx!;
    const task = await tasks.createTask(actor, {
      workspaceId: actor.workspaceId,
      title: 'Optimistic locking',
      tagIds: [],
      priority: 'NONE',
    } as never);

    const updated = await tasks.updateTask(actor, task.id, { title: 'First write', version: 1 } as never);
    expect(updated.version).toBe(2);

    // A second device still believes it holds version 1.
    await expect(
      tasks.updateTask(actor, task.id, { title: 'Second write', version: 1 } as never),
    ).rejects.toThrow(AppError);

    const current = await tasks.loadTask(actor.workspaceId, task.id);
    expect(current.title).toBe('First write');
  });

  maybe()('completing then reopening leaves a full, ordered event history', async () => {
    const { tasks, tracking, actor } = ctx!;
    const task = await tasks.createTask(actor, {
      workspaceId: actor.workspaceId,
      title: 'Lifecycle',
      tagIds: [],
      priority: 'NONE',
    } as never);

    const completed = await tasks.completeTask(actor, task.id, task.version);
    expect(completed.status).toBe('COMPLETED');
    expect(completed.completedAt).toBeTruthy();

    const reopened = await tasks.reopenTask(actor, task.id, completed.version);
    expect(reopened.status).toBe('ACTIVE');
    expect(reopened.completedAt).toBeNull();

    const types = (await tracking.listTrackingEvents(actor.workspaceId, task.id)).map((e) => e.type);
    // History is additive: completing and reopening both survive.
    expect(types).toContain('TASK_COMPLETED');
    expect(types).toContain('TASK_REOPENED');
  });

  maybe()('refuses to complete an already completed task', async () => {
    const { tasks, actor } = ctx!;
    const task = await tasks.createTask(actor, {
      workspaceId: actor.workspaceId,
      title: 'Double completion',
      tagIds: [],
      priority: 'NONE',
    } as never);
    const done = await tasks.completeTask(actor, task.id, task.version);
    await expect(tasks.completeTask(actor, task.id, done.version)).rejects.toThrow(AppError);
  });

  maybe()('does not leak tasks across workspaces', async () => {
    const { tasks, actor, otherActor } = ctx!;
    const task = await tasks.createTask(actor, {
      workspaceId: actor.workspaceId,
      title: 'Tenant isolation',
      tagIds: [],
      priority: 'NONE',
    } as never);

    // The other tenant must not be able to read it, even with the exact id.
    await expect(tasks.loadTask(otherActor.workspaceId, task.id)).rejects.toThrow(AppError);

    const { data } = await tasks.queryTasks(otherActor.workspaceId, {
      workspaceId: otherActor.workspaceId,
      includeArchived: false,
      limit: 50,
    } as never);
    expect(data.find((t) => t.id === task.id)).toBeUndefined();
  });

  maybe()('rescheduling counts the move so analytics can surface it', async () => {
    const { tasks, actor } = ctx!;
    const task = await tasks.createTask(actor, {
      workspaceId: actor.workspaceId,
      title: 'Slipping task',
      dueAt: new Date(Date.now() + 3_600_000).toISOString(),
      tagIds: [],
      priority: 'NONE',
    } as never);

    const moved = await tasks.rescheduleTask(
      actor,
      task.id,
      task.version,
      new Date(Date.now() + 86_400_000).toISOString(),
      'Ran out of time',
    );
    expect(moved.rescheduleCount).toBe(1);
  });

  maybe()('soft deletion hides the task from queries but retains the row', async () => {
    const { tasks, actor } = ctx!;
    const task = await tasks.createTask(actor, {
      workspaceId: actor.workspaceId,
      title: 'Soft delete',
      tagIds: [],
      priority: 'NONE',
    } as never);

    await tasks.deleteTask(actor, task.id);

    const { data } = await tasks.queryTasks(actor.workspaceId, {
      workspaceId: actor.workspaceId,
      includeArchived: false,
      limit: 100,
    } as never);
    expect(data.find((t) => t.id === task.id)).toBeUndefined();

    // Restorable — the user's data was not destroyed.
    const restored = await tasks.restoreTask(actor, task.id);
    expect(restored.status).toBe('ACTIVE');
  });

  maybe()('tracking events cannot be mutated after the fact', async () => {
    const { tasks, getDb, actor } = ctx!;
    const task = await tasks.createTask(actor, {
      workspaceId: actor.workspaceId,
      title: 'Immutable history',
      tagIds: [],
      priority: 'NONE',
    } as never);
    await tasks.completeTask(actor, task.id, task.version);

    const db = getDb();
    // The database enforces append-only via a trigger, not just convention.
    await expect(
      db.execute(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (await import('drizzle-orm')).sql`update tracking_events set type = 'TASK_CREATED' where task_id = ${task.id}`,
      ),
    ).rejects.toThrow();
  });
});
