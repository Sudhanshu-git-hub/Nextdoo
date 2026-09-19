import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as metrics from '../metrics';

/**
 * M2 instrumentation (PRD §21.3, §20.3).
 *
 * Verifies the metric events the PRD requires — task creation success rate,
 * task mutation error rate, active-task count gauge, sync-channel tagging —
 * by collecting events through the metrics sink around real domain calls.
 */

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:55432/nextdoo';
const DEVICE_A = '66666666-6666-4666-8666-666666666601';

async function probe(): Promise<true> {
  const { requireTestDatabase } = await import('../../../../../tests/database');
  return requireTestDatabase();
}

const available = await probe();
const maybe = () => (available ? it : it.skip);

type Events = { event: string; context: Record<string, unknown> }[];

let user: { id: string; workspaceId: string };
let events: Events;
let mutationCounter = 0;

function mutationId(): string {
  mutationCounter += 1;
  const tail = `${Date.now().toString(16)}${mutationCounter}`.slice(-12).padStart(12, '0');
  return `66666666-6666-4666-8666-${tail}`;
}

beforeAll(async () => {
  if (!available) return;
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.AUTH_SECRET ??= 'test-only-secret-0123456789abcdefghij';

  const { registerUser } = await import('./accounts');
  user = await registerUser({
    email: `metrics-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`,
    passwordHash: 'scrypt$deadbeef$deadbeef',
    name: 'Metrics Test',
    timeZone: 'UTC',
  });
}, 30000);

beforeEach(() => {
  events = [];
  metrics.setMetricSink((event, context) => events.push({ event, context }));
});

afterEach(() => {
  metrics.setMetricSink(null);
});

describe('task metric events (integration)', () => {
  maybe()('emits task.created with duration and the http channel on a successful create', async () => {
    const tasks = await import('./tasks');
    await tasks.createTask(
      { userId: user.id, workspaceId: user.workspaceId, requestId: 'test' },
      { workspaceId: user.workspaceId, title: 'Metric create ok', tagIds: [], priority: 'NONE' },
    );

    const created = events.find((e) => e.event === 'task.created');
    expect(created).toBeDefined();
    expect(created!.context).toMatchObject({ workspaceId: user.workspaceId, via: 'http' });
    expect(Number(created!.context.durationMs)).toBeGreaterThanOrEqual(0);
    // Count-changing create also emits the active-task gauge.
    expect(events.some((e) => e.event === 'workspace.active_tasks' && Number(e.context.activeTasks) >= 1)).toBe(true);
  });

  maybe()('emits task.create_failed with the AppError code and rethrows', async () => {
    const tasks = await import('./tasks');
    await expect(
      tasks.createTask(
        { userId: user.id, workspaceId: user.workspaceId, requestId: 'test' },
        { workspaceId: user.workspaceId, title: 'Bad project', projectName: 'no-such-project-xyz', tagIds: [], priority: 'NONE' },
      ),
    ).rejects.toThrow();

    const failed = events.find((e) => e.event === 'task.create_failed');
    expect(failed).toBeDefined();
    expect(failed!.context.code).toBe('VALIDATION_FAILED');
    expect(failed!.context.via).toBe('http');
    expect(events.some((e) => e.event === 'task.created')).toBe(false);
    expect(events.some((e) => e.event === 'workspace.active_tasks')).toBe(false);
  });

  maybe()('emits task.mutated for complete/reopen and the gauge moves down then up', async () => {
    const tasks = await import('./tasks');
    const actor = { userId: user.id, workspaceId: user.workspaceId, requestId: 'test' };
    const task = await tasks.createTask(actor, { workspaceId: user.workspaceId, title: 'Metric complete', tagIds: [], priority: 'NONE' });
    const beforeCount = events.filter((e) => e.event === 'workspace.active_tasks').length;

    events.length = 0;
    const completed = await tasks.completeTask(actor, task.id, task.version);
    expect(events.map((e) => e.event)).toContain('task.mutated');
    const completedEvent = events.find((e) => e.event === 'task.mutated')!;
    expect(completedEvent.context).toMatchObject({ operation: 'complete', via: 'http' });
    expect(completedEvent.context.activeTasks).toBeUndefined();

    const gaugeAfterComplete = events.filter((e) => e.event === 'workspace.active_tasks');
    expect(gaugeAfterComplete).toHaveLength(1);
    expect(Number(gaugeAfterComplete[0]!.context.activeTasks)).toBeGreaterThanOrEqual(0);

    events.length = 0;
    const reopened = await tasks.reopenTask(actor, completed.id, completed.version);
    const gaugeAfterReopen = events.filter((e) => e.event === 'workspace.active_tasks');
    expect(gaugeAfterReopen).toHaveLength(1);
    expect(Number(gaugeAfterReopen[0]!.context.activeTasks)).toBeGreaterThan(Number(gaugeAfterComplete[0]!.context.activeTasks));
    expect(reopened.status).toBe('ACTIVE');
    expect(beforeCount).toBeGreaterThanOrEqual(1);
  });

  maybe()('emits task.mutation_failed with the conflict code on a version mismatch', async () => {
    const tasks = await import('./tasks');
    const actor = { userId: user.id, workspaceId: user.workspaceId, requestId: 'test' };
    const task = await tasks.createTask(actor, { workspaceId: user.workspaceId, title: 'Metric conflict', tagIds: [], priority: 'NONE' });

    events.length = 0;
    await expect(tasks.updateTask(actor, task.id, { version: 999, title: 'Stale write' })).rejects.toThrow();
    const failed = events.find((e) => e.event === 'task.mutation_failed');
    expect(failed).toBeDefined();
    expect(failed!.context).toMatchObject({ operation: 'update', code: 'RESOURCE_VERSION_CONFLICT', via: 'http' });
    expect(events.some((e) => e.event === 'task.mutated')).toBe(false);
  });

  maybe()('does not emit the active-task gauge for count-preserving mutations', async () => {
    const tasks = await import('./tasks');
    const actor = { userId: user.id, workspaceId: user.workspaceId, requestId: 'test' };
    const task = await tasks.createTask(actor, { workspaceId: user.workspaceId, title: 'Metric no gauge', tagIds: [], priority: 'NONE' });

    events.length = 0;
    await tasks.updateTask(actor, task.id, { version: task.version, title: 'Renamed without gauge' });
    expect(events.map((e) => e.event)).toContain('task.mutated');
    expect(events.some((e) => e.event === 'workspace.active_tasks')).toBe(false);
  });

  maybe()('tags mutations arriving through sync with via:sync', async () => {
    const syncService = await import('./sync');
    const tasksService = await import('./tasks');
    const actor = { userId: user.id, workspaceId: user.workspaceId, requestId: 'test' };
    const task = await tasksService.createTask(actor, { workspaceId: user.workspaceId, title: 'Metric sync', tagIds: [], priority: 'NONE' });

    events.length = 0;
    const { results } = await syncService.pushMutations(actor, {
      deviceId: DEVICE_A,
      mutations: [
        {
          mutationId: mutationId(),
          entityType: 'task',
          entityId: task.id,
          operation: 'update',
          baseVersion: task.version,
          payload: { title: 'Updated over sync' },
          createdAt: new Date().toISOString(),
        },
      ],
    } as never);
    expect(results[0]!.status).toBe('applied');
    const mutated = events.find((e) => e.event === 'task.mutated');
    expect(mutated).toBeDefined();
    expect(mutated!.context).toMatchObject({ operation: 'update', via: 'sync' });
  });
});
