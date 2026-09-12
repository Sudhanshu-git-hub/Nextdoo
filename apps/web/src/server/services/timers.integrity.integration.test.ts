import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { timerSessions, trackingEvents } from '@nextdoo/db';
import { requireTestDatabase } from '../../../../../tests/database';
import { getDb } from '../db';
import { registerUser } from './accounts';
import { createTask, loadTask } from './tasks';
import { getActiveTimer, logTime, startTimer, updateTimer } from './timers';
import { currentCursor, pullChanges } from './sync';
await requireTestDatabase();
async function fixture() {
  const u = await registerUser({ email: `timer-${randomUUID()}@test.local`, name: null, passwordHash: 'test-not-login', timeZone: 'UTC' });
  const actor = { userId: u.id, workspaceId: u.workspaceId };
  const task = await createTask(actor, { workspaceId: u.workspaceId, title: 'Timer integrity', priority: 'NONE', tagIds: [] });
  return { actor, task };
}
const time = (minute: number) => new Date(Date.UTC(2026, 8, 8, 8, minute)).toISOString();

describe('timer integrity', () => {
  it('four concurrent starts preserve all sessions but have exactly one canonical open timer', async () => {
    const { actor, task } = await fixture();
    await Promise.all(Array.from({ length: 4 }, (_, i) => startTimer(actor, task.id, `device-${i}`, time(i))));
    const rows = await getDb().select().from(timerSessions).where(eq(timerSessions.userId, actor.userId));
    expect(rows).toHaveLength(4);
    expect(rows.filter((r) => ['RUNNING', 'PAUSED'].includes(r.status))).toHaveLength(1);
    expect(rows.filter((r) => r.status === 'OVERLAPPED')).toHaveLength(3);
    expect(rows.every((r) => !r.endedAt || r.endedAt >= r.startedAt)).toBe(true);
  });
  it('an older offline start never ends the newer canonical session before its start', async () => {
    const { actor, task } = await fixture();
    const newer = await startTimer(actor, task.id, 'newer', time(20));
    const older = await startTimer(actor, task.id, 'older', time(10));
    expect((await getActiveTimer(actor.userId))?.id).toBe(newer.id);
    expect(older.status).toBe('OVERLAPPED');
    expect(new Date(older.endedAt!).getTime()).toBeGreaterThanOrEqual(new Date(older.startedAt).getTime());
  });
  it('timestamps cannot move backwards across pause/resume or stop transitions', async () => {
    const { actor, task } = await fixture();
    const timer = await startTimer(actor, task.id, 'clock', time(10));
    await expect(updateTimer(actor, timer.id, 'stop', time(5))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await updateTimer(actor, timer.id, 'pause', time(20));
    await expect(updateTimer(actor, timer.id, 'resume', time(15))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await updateTimer(actor, timer.id, 'resume', time(25));
    const stopped = await updateTimer(actor, timer.id, 'stop', time(30));
    expect(stopped.elapsedSeconds).toBe(15 * 60);
  });
  it('overlapped terminal sessions cannot be stopped again and credited twice', async () => {
    const { actor, task } = await fixture();
    const first = await startTimer(actor, task.id, 'one', time(10));
    await startTimer(actor, task.id, 'two', time(20));
    expect((await loadTask(actor.workspaceId, task.id)).actualMinutes).toBe(10);
    await expect(updateTimer(actor, first.id, 'stop', time(25))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await loadTask(actor.workspaceId, task.id)).actualMinutes).toBe(10);
  });
  it('credited time increments task version and publishes a sync delta', async () => {
    const { actor, task } = await fixture();
    const cursor = await currentCursor(actor.workspaceId);
    await logTime(actor, task.id, 15);
    const updated = await loadTask(actor.workspaceId, task.id);
    expect(updated.actualMinutes).toBe(15); expect(updated.version).toBe(task.version + 1);
    expect((await pullChanges(actor.workspaceId, cursor, 100)).changes).toEqual(expect.arrayContaining([expect.objectContaining({ entityId: task.id, version: updated.version, payload: expect.objectContaining({ actualMinutes: 15 }) })]));
  });
});

it('repeated sub-minute sessions preserve seconds instead of rounding each session away', async () => {
  const { actor, task } = await fixture();
  for (let i = 0; i < 4; i++) {
    const timer = await startTimer(actor, task.id, 'short', time(i));
    await updateTimer(actor, timer.id, 'stop', new Date(new Date(time(i)).getTime() + 30000).toISOString());
  }
  expect((await loadTask(actor.workspaceId, task.id)).actualMinutes).toBe(2);
});

it('manual time preserves the submitted annotation in durable tracking history', async () => {
  const { actor, task } = await fixture();
  await logTime(actor, task.id, 3, 'Recovered work note');
  const rows = await getDb().select().from(trackingEvents).where(eq(trackingEvents.taskId, task.id));
  expect(rows.find((r) => r.type === 'TIME_LOGGED')?.payload).toMatchObject({ note: 'Recovered work note' });
});
