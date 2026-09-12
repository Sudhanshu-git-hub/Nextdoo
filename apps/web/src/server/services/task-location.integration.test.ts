import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { tasks, syncChanges, generateRecurrenceBatch } from '@nextdoo/db';
import { createTaskSchema, updateTaskSchema } from '@nextdoo/contracts';
import { requireTestDatabase } from '../../../../../tests/database';
import { getDb } from '../db';
import { registerUser } from './accounts';
import { createTask, updateTask, loadTask } from './tasks';
import { attachRecurrence } from './recurrence';
import { pushMutations } from './sync';

await requireTestDatabase();

const account = async () => {
  const u = await registerUser({ email: `location-${randomUUID()}@test.local`, name: null, passwordHash: 'test-not-login', timeZone: 'UTC' });
  return { userId: u.id, workspaceId: u.workspaceId };
};
type Actor = Awaited<ReturnType<typeof account>>;
const create = (a: Actor, extra: Record<string, unknown> = {}) =>
  createTask(a, createTaskSchema.parse({ workspaceId: a.workspaceId, title: 'Location work', priority: 'NONE', tagIds: [], ...extra }));
const mutation = (id: string, operation: 'create' | 'update', payload: Record<string, unknown>, baseVersion: number | null) => ({
  mutationId: randomUUID(), entityType: 'task' as const, entityId: id, operation, payload, baseVersion, createdAt: new Date().toISOString(),
});
const push = async (a: Actor, m: ReturnType<typeof mutation>) => (await pushMutations(a, { deviceId: 'location-test', mutations: [m] })).results[0]!;

it('create persists location and publishes it in the sync change payload', async () => {
  const a = await account();
  const task = await create(a, { location: '  Lab bench 2  ' });
  expect(task.location).toBe('Lab bench 2');
  const [row] = await getDb().select().from(tasks).where(eq(tasks.id, task.id));
  expect(row!.location).toBe('Lab bench 2');
  const [change] = await getDb().select().from(syncChanges).where(and(eq(syncChanges.entityType, 'task'), eq(syncChanges.entityId, task.id)));
  expect(change!.operation).toBe('create');
  expect(change!.payload).toMatchObject({ location: 'Lab bench 2' });
});

it('update sets, changes and clears location with version bumps and sync payloads', async () => {
  const a = await account();
  const task = await create(a);
  expect(task.location).toBeNull();

  const set = await updateTask(a, task.id, updateTaskSchema.parse({ version: task.version, location: 'Office 4.2' }));
  expect(set).toMatchObject({ location: 'Office 4.2', version: task.version + 1 });

  const changed = await updateTask(a, set.id, updateTaskSchema.parse({ version: set.version, location: 'Remote' }));
  expect(changed.location).toBe('Remote');

  const cleared = await updateTask(a, changed.id, updateTaskSchema.parse({ version: changed.version, location: null }));
  expect(cleared.location).toBeNull();

  const changes = await getDb().select({ payload: syncChanges.payload, version: syncChanges.version, operation: syncChanges.operation })
    .from(syncChanges).where(and(eq(syncChanges.entityType, 'task'), eq(syncChanges.entityId, task.id)))
    .orderBy(syncChanges.sequence);
  // Create emitted a change with a null location; the updates carry each new value.
  const locations = changes.map((c) => (c.payload as { location: string | null }).location);
  expect(changes.map((c) => c.operation)).toEqual(['create', 'update', 'update', 'update']);
  expect(locations).toEqual([null, 'Office 4.2', 'Remote', null]);
  expect(changes.map((c) => c.version)).toEqual([task.version, task.version + 1, task.version + 2, task.version + 3]);
});

it('the shared contract rejects location over the 500 character bound on create and update', async () => {
  const a = await account();
  const tooLongCreate = createTaskSchema.safeParse({ workspaceId: a.workspaceId, title: 'x', priority: 'NONE', tagIds: [], location: 'x'.repeat(501) });
  expect(tooLongCreate.success).toBe(false);
  const tooLongUpdate = updateTaskSchema.safeParse({ version: 1, location: 'x'.repeat(501) });
  expect(tooLongUpdate.success).toBe(false);
  // The boundary itself is accepted end to end.
  const max = 'x'.repeat(500);
  const task = await create(a, { location: max });
  expect(task.location).toBe(max);
  expect(await getDb().select().from(tasks).where(eq(tasks.workspaceId, a.workspaceId))).toHaveLength(1);
});

it('tenant isolation: foreign accounts cannot read or write another workspace location', async () => {
  const a = await account();
  const b = await account();
  const task = await create(a, { location: 'A only' });
  await expect(updateTask(b, task.id, updateTaskSchema.parse({ version: task.version, location: 'Hijacked' }))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  const foreign = await push(b, mutation(task.id, 'update', { location: 'Hijacked' }, task.version));
  expect(foreign.status).toBe('rejected');
  expect((await loadTask(a.workspaceId, task.id)).location).toBe('A only');
});

it('sync create and update carry location through the writable-field boundary', async () => {
  const a = await account();
  const id = randomUUID();
  const created = await push(a, mutation(id, 'create', { title: 'Offline plan', location: 'Warehouse B1' }, null));
  expect(created.status).toBe('applied');
  const row = (await loadTask(a.workspaceId, id));
  expect(row.location).toBe('Warehouse B1');

  const updated = await push(a, mutation(id, 'update', { location: 'Dock 7', bogusField: 'dropped' }, row.version));
  expect(updated.status).toBe('applied');
  expect((await loadTask(a.workspaceId, id)).location).toBe('Dock 7');
});

it('recurrence occurrences inherit the template location', async () => {
  const a = await account();
  const template = await create(a, { location: 'Meeting room 12', dueAt: '2026-09-10T09:00:00Z' });
  const series = await attachRecurrence(a, template.id, { version: template.version, rule: { freq: 'DAILY', interval: 1, count: 3, timeZone: 'UTC' } });
  expect(series.occurrences.length).toBeGreaterThan(1);
  await generateRecurrenceBatch(getDb(), series.id);
  const rows = await getDb().select({ id: tasks.id, location: tasks.location }).from(tasks).where(eq(tasks.workspaceId, a.workspaceId));
  expect(rows.length).toBe(series.occurrences.length);
  expect(rows.every((t) => t.location === 'Meeting room 12')).toBe(true);
});
