import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditLogs, deliverDueReminders, notifications, pushDeliveries, pushSubscriptions, reminders } from '@nextdoo/db';
import { requireTestDatabase } from '../../../../../tests/database';
import { getDb } from '../db';
import { registerUser } from './accounts';
import { createTask } from './tasks';
import { createReminder } from './reminders';
import {
  getVapidPublicKey,
  listPushSubscriptions,
  registerPushSubscription,
} from './push-subscriptions';

// M8-i1 (PRD §6.6): UNCONFIGURED deployment — this worker process has NO
// VAPID keys (none are set anywhere; env is validated/cached lazily, so the
// gate below must see the empty configuration). The feature must degrade
// honestly: 503 on the public-key and subscribe endpoints, PUSH reminders
// rejected at creation, and WEB reminders fully functional. No stub fallback
// exists for an unconfigured deployment.

// (Guard) Ensure no VAPID configuration leaks into this process from a shared
// test environment; the degradation assertions require an empty feature gate.
delete process.env.VAPID_PUBLIC_KEY;
delete process.env.VAPID_PRIVATE_KEY;

await requireTestDatabase();

const p256dh = Buffer.alloc(65, 7).toString('base64url');
const auth = Buffer.alloc(16, 8).toString('base64url');

it('answers 503 PROVIDER_UNAVAILABLE for the public key when VAPID is missing', async () => {
  const u = await registerUser({ email: `pushun-${randomUUID()}@test.local`, passwordHash: 'test', name: null, timeZone: 'UTC' });
  await expect(getVapidPublicKey({ userId: u.id })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
});

it('refuses to collect undeliverable registrations when push is unconfigured', async () => {
  const u = await registerUser({ email: `pushun-${randomUUID()}@test.local`, passwordHash: 'test', name: null, timeZone: 'UTC' });
  await expect(
    registerPushSubscription({ userId: u.id }, { endpoint: `https://push.test.local/${randomUUID()}`, keys: { p256dh, auth } }),
  ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  expect(await getDb().select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, u.id))).toHaveLength(0);
  expect(await listPushSubscriptions({ userId: u.id })).toHaveLength(0);
});

it('rejects PUSH reminders at creation on an unconfigured deployment', async () => {
  const u = await registerUser({ email: `pushun-${randomUUID()}@test.local`, passwordHash: 'test', name: null, timeZone: 'UTC' });
  const actor = { userId: u.id, workspaceId: u.workspaceId };
  const task = await createTask(actor, { workspaceId: actor.workspaceId, title: 'Unconfigured push', dueAt: new Date(Date.now() + 86400000).toISOString(), priority: 'NONE', tagIds: [] });
  await expect(createReminder(actor, { taskId: task.id, scheduledAt: new Date(Date.now() - 60000).toISOString(), channel: 'PUSH' })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  expect(await getDb().select().from(reminders).where(eq(reminders.taskId, task.id))).toHaveLength(0);
});

it('keeps WEB reminders and the notification center fully functional while push is unconfigured', async () => {
  const u = await registerUser({ email: `pushun-${randomUUID()}@test.local`, passwordHash: 'test', name: null, timeZone: 'UTC' });
  const actor = { userId: u.id, workspaceId: u.workspaceId };
  const task = await createTask(actor, { workspaceId: actor.workspaceId, title: 'WEB still works', dueAt: new Date(Date.now() + 86400000).toISOString(), priority: 'NONE', tagIds: [] });
  const r = await createReminder(actor, { taskId: task.id, scheduledAt: new Date(Date.now() - 60000).toISOString(), channel: 'WEB' });
  const result = await deliverDueReminders(getDb());
  // Scoped to THIS reminder: the shared test database may hold other files'
  // due reminders that the global dispatcher delivers concurrently under load
  // (observed cross-file flake, 2026-09-15).
  expect(result.sent).toBeGreaterThanOrEqual(1);
  const dispatched = await getDb().select().from(auditLogs).where(and(eq(auditLogs.action, 'reminder.dispatch'), eq(auditLogs.targetId, r!.id)));
  expect(dispatched).toHaveLength(1);
  expect((await getDb().select().from(reminders).where(eq(reminders.id, r!.id)))[0]!.status).toBe('SENT');
  expect(await getDb().select().from(notifications).where(eq(notifications.reminderId, r!.id))).toHaveLength(1);
  expect(await getDb().select().from(pushDeliveries).where(eq(pushDeliveries.reminderId, r!.id))).toHaveLength(0);
});
