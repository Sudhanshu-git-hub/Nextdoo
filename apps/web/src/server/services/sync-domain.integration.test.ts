import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { reminders, tasks, trackingEvents, trackingResults, subscriptions } from '@nextdoo/db';
import { requireTestDatabase } from '../../../../../tests/database';
import { getDb } from '../db';
import { getPlan, registerUser } from './accounts';
import { createTask, loadTask } from './tasks';
import { pushMutations } from './sync';
import { createReminder } from './reminders';
await requireTestDatabase();
const account = async () => {
  const u = await registerUser({ email: `domain-${randomUUID()}@test.local`, name: null, passwordHash: 'test-not-login', timeZone: 'UTC' });
  return { userId: u.id, workspaceId: u.workspaceId };
};
type Actor = Awaited<ReturnType<typeof account>>;
const mutation = (id: string, operation: 'create' | 'update' | 'delete', payload = {}, baseVersion: number | null = null) => ({
  mutationId: randomUUID(), entityType: 'task' as const, entityId: id, operation, payload, baseVersion, createdAt: new Date().toISOString(),
});
const push = async (a: Actor, m: ReturnType<typeof mutation>) => (await pushMutations(a, { deviceId: 'domain-test', mutations: [m] })).results[0]!;
const create = (a: Actor) => createTask(a, { workspaceId: a.workspaceId, title: 'Domain invariants', priority: 'NONE', tagIds: [] });

describe('sync uses task domain invariants', () => {
  it('sync create emits the same creation and planning history as online', async () => {
    const a = await account(), id = randomUUID();
    expect((await push(a, mutation(id, 'create', { title: 'Planned offline', dueAt: '2026-09-09T12:00:00.000Z' }))).status).toBe('applied');
    const events = await getDb().select().from(trackingEvents).where(eq(trackingEvents.taskId, id));
    expect(events.map((e) => e.type).sort()).toEqual(['TASK_CREATED', 'TASK_PLANNED']);
  });
  it('completion timestamps, tracking, scoring and reminder cancellation are atomic', async () => {
    const a = await account(), t = await create(a);
    const r = await createReminder(a, { taskId: t.id, scheduledAt: '2026-09-09T12:00:00.000Z', channel: 'WEB' });
    expect((await push(a, mutation(t.id, 'update', { status: 'COMPLETED' }, t.version))).status).toBe('applied');
    expect((await loadTask(a.workspaceId, t.id)).completedAt).toBeInstanceOf(Date);
    expect(await getDb().select().from(trackingEvents).where(and(eq(trackingEvents.taskId, t.id), eq(trackingEvents.type, 'TASK_COMPLETED')))).toHaveLength(1);
    expect(await getDb().select().from(trackingResults).where(eq(trackingResults.taskId, t.id))).toHaveLength(1);
    expect((await getDb().select().from(reminders).where(eq(reminders.id, r!.id)))[0]?.status).toBe('CANCELED');
  });
  it('sync delete cancels reminders and cannot repeatedly increment a deleted task', async () => {
    const a = await account(), t = await create(a);
    const r = await createReminder(a, { taskId: t.id, scheduledAt: '2026-09-09T12:00:00.000Z', channel: 'WEB' });
    await push(a, mutation(t.id, 'delete'));
    await push(a, mutation(t.id, 'delete'));
    expect((await getDb().select().from(reminders).where(eq(reminders.id, r!.id)))[0]?.status).toBe('CANCELED');
    expect((await getDb().select().from(tasks).where(eq(tasks.id, t.id)))[0]?.version).toBe(2);
  });
  it('sync rejects invalid field values without blocking the next mutation', async () => {
    const a = await account();
    const result = await pushMutations(a, { deviceId: 'domain-test', mutations: [mutation(randomUUID(), 'create', { title: ' ', estimateMinutes: -1 }), mutation(randomUUID(), 'create', { title: 'valid' })] });
    expect(result.results.map((r) => r.status)).toEqual(['rejected', 'applied']);
    expect(result.results[0]?.error?.code).toBe('VALIDATION_FAILED');
  });
  it('online and sync concurrent creates cannot overrun the Free task limit', async () => {
    const a = await account();
    await getDb().insert(tasks).values(Array.from({ length: 199 }, () => ({ id: randomUUID(), workspaceId: a.workspaceId, title: 'Capacity fixture' })));
    await Promise.allSettled([create(a), ...Array.from({ length: 4 }, () => push(a, mutation(randomUUID(), 'create', { title: 'Overflow' })))]);
    expect(await getDb().select().from(tasks).where(eq(tasks.workspaceId, a.workspaceId))).toHaveLength(200);
  });
  it('one concurrent mutation ID cannot apply to two targets or changed payloads', async () => {
    const a = await account(), m = mutation(randomUUID(), 'create', { title: 'original' });
    const results = await Promise.all([push(a, m), push(a, { ...m, entityId: randomUUID() })]);
    expect(results.map((r) => r.status).sort()).toEqual(['applied', 'rejected']);
    expect(await getDb().select().from(tasks).where(eq(tasks.workspaceId, a.workspaceId))).toHaveLength(1);
    expect((await push(a, { ...m, payload: { title: 'changed' } })).status).toBe('rejected');
  });
  it('canceled paid subscriptions retain access only through their paid-through date', async () => {
    const a = await account();
    await getDb().update(subscriptions).set({ plan: 'PRO', status: 'CANCELED', currentPeriodEnd: new Date(Date.now() + 86400000) }).where(eq(subscriptions.userId, a.userId));
    expect(await getPlan(a.userId)).toBe('PRO');
    await getDb().update(subscriptions).set({ currentPeriodEnd: new Date(Date.now() - 1) }).where(eq(subscriptions.userId, a.userId));
    expect(await getPlan(a.userId)).toBe('FREE');
  });
});
