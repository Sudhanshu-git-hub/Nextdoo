import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTaskSchema } from '@nextdoo/contracts';
import { reminders, tasks, subscriptions } from '@nextdoo/db';
import { requireTestDatabase } from '../../../../../tests/database';
import { getDb } from '../db';
import { getPlan, registerUser } from './accounts';
import { createTask, deleteTask, loadTask, restoreTask, updateTask } from './tasks';
import { createReminder, dispatchDueReminders } from './reminders';
await requireTestDatabase();
async function fixture() {
  const u = await registerUser({ email: `lifecycle-${randomUUID()}@test.local`, name: null, passwordHash: 'test-not-login', timeZone: 'UTC' });
  const actor = { userId: u.id, workspaceId: u.workspaceId };
  const input = createTaskSchema.parse({ workspaceId: u.workspaceId, title: 'Lifecycle integrity', dueAt: '2026-09-09T12:00:00.000Z' });
  return { actor, input, task: await createTask(actor, input) };
}
it('does not silently discard accepted recurrence data when no recurrence writer exists', async () => {
  const { actor, input } = await fixture();
  const recurring = createTaskSchema.parse({ ...input, recurrenceRule: { freq: 'DAILY', interval: 1, timeZone: 'UTC' } });
  await expect(createTask(actor, recurring)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  expect(await getDb().select().from(tasks).where(eq(tasks.workspaceId, actor.workspaceId))).toHaveLength(1);
});
it('restoration cannot revive an expired deletion or bypass the task limit', async () => {
  const { actor, task } = await fixture();
  await deleteTask(actor, task.id);
  await getDb().update(tasks).set({ deletedAt: new Date(Date.now() - 31 * 86400000) }).where(eq(tasks.id, task.id));
  await expect(restoreTask(actor, task.id)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  await getDb().update(tasks).set({ deletedAt: new Date() }).where(eq(tasks.id, task.id));
  await getDb().insert(tasks).values(Array.from({ length: 200 }, () => ({ id: randomUUID(), workspaceId: actor.workspaceId, title: 'Capacity' })));
  await expect(restoreTask(actor, task.id)).rejects.toMatchObject({ code: 'ENTITLEMENT_LIMIT_REACHED' });
});
it('generic due-date changes preserve reschedule intent and move relative reminders', async () => {
  const { actor, task } = await fixture();
  const reminder = await createReminder(actor, { taskId: task.id, minutesBeforeDue: 10, channel: 'WEB' });
  await updateTask(actor, task.id, { version: task.version, dueAt: '2026-09-10T12:00:00.000Z' });
  expect((await loadTask(actor.workspaceId, task.id)).rescheduleCount).toBe(1);
  const [row] = await getDb().select().from(reminders).where(eq(reminders.id, reminder!.id));
  expect(row?.scheduledAt.toISOString()).toBe('2026-09-10T11:50:00.000Z');
});
it('the alternate reminder dispatcher binds timestamps correctly even for an empty claim', async () => {
  await expect(dispatchDueReminders(0)).resolves.toMatchObject({ sent: 0 });
});
it('paid grace access ends at its stored deadline', async () => {
  const { actor } = await fixture();
  for (const status of ['GRACE_PERIOD', 'PAST_DUE'] as const) {
    await getDb().update(subscriptions).set({ plan: 'PRO', status, graceEndsAt: new Date(Date.now() - 1) }).where(eq(subscriptions.userId, actor.userId));
    expect(await getPlan(actor.userId)).toBe('FREE');
    await getDb().update(subscriptions).set({ graceEndsAt: new Date(Date.now() + 86400000) }).where(eq(subscriptions.userId, actor.userId));
    expect(await getPlan(actor.userId)).toBe('PRO');
  }
});

it('delete/restore advance versions and cannot make a stale PATCH valid again', async () => {
  const { actor, task } = await fixture();
  await deleteTask(actor, task.id);
  const restored = await restoreTask(actor, task.id);
  expect(restored.version).toBe(task.version + 2);
  await expect(updateTask(actor, task.id, { version: task.version, title: 'Stale edit' })).rejects.toMatchObject({ code: 'RESOURCE_VERSION_CONFLICT' });
});
