import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it } from 'vitest';
import { and, asc, eq, sql } from 'drizzle-orm';
import {
  deliverDueReminders,
  deliverPushDeliveries,
  notifications,
  purgeAccount,
  pushDeliveries,
  pushSubscriptions,
  reminders,
  users,
  type PushTransport,
} from '@nextdoo/db';
import { requireTestDatabase } from '../../../../../tests/database';
import { getDb } from '../db';
import { registerUser } from './accounts';
import { completeTask, createTask } from './tasks';
import { createReminder } from './reminders';
import {
  listPushSubscriptions,
  registerPushSubscription,
  removePushSubscription,
} from './push-subscriptions';

// M8-i1 (PRD §6.6): this file exercises the CONFIGURED deployment path. The
// fixed test VAPID pair only enables the feature gate — delivery itself is
// always driven by a deterministic stub transport injected below (no real
// push provider, no network). The unconfigured 503 degradation is covered in
// push-unconfigured.integration.test.ts.
process.env.VAPID_PUBLIC_KEY = Buffer.alloc(65, 1).toString('base64url');
process.env.VAPID_PRIVATE_KEY = Buffer.alloc(32, 2).toString('base64url');

await requireTestDatabase();

// The push queue is a shared, durable surface: start every test from a clean
// queue so rows queued (but not delivered) by an earlier test in this file —
// or a previously interrupted run — cannot skew the absolute delivery counts.
beforeEach(async () => {
  await getDb().execute(sql`delete from push_deliveries`);
  await getDb().execute(sql`delete from push_subscriptions`);
});

type Actor = { userId: string; workspaceId: string };
type DeliveryCall = { endpoint: string; payload: string };

async function fixture(title = 'Push task'): Promise<{ actor: Actor; task: Awaited<ReturnType<typeof createTask>> }> {
  const u = await registerUser({ email: `push-${randomUUID()}@test.local`, passwordHash: 'test', name: null, timeZone: 'UTC' });
  const actor = { userId: u.id, workspaceId: u.workspaceId };
  return { actor, task: await createTask(actor, { workspaceId: actor.workspaceId, title, dueAt: new Date(Date.now() + 86400000).toISOString(), priority: 'NONE', tagIds: [] }) };
}

const P256DH_A = Buffer.alloc(65, 3).toString('base64url');
const P256DH_B = Buffer.alloc(65, 4).toString('base64url');
const AUTH = Buffer.alloc(16, 5).toString('base64url');
const endpointFor = (tag: string) => `https://push.test.local/${tag}/${randomUUID()}`;

function stubTransport(respond: (call: { endpoint: string; n: number }) => number, calls: DeliveryCall[]): PushTransport {
  return {
    async send(subscription, payload) {
      calls.push({ endpoint: subscription.endpoint, payload });
      return { statusCode: respond({ endpoint: subscription.endpoint, n: calls.length }) };
    },
  };
}

async function deliveriesFor(reminderId: string) {
  return getDb().select().from(pushDeliveries).where(eq(pushDeliveries.reminderId, reminderId)).orderBy(asc(pushDeliveries.id));
}

it('registers, validates, dedupes and removes user-scoped push subscriptions', async () => {
  const { actor } = await fixture();
  const other = await fixture();
  const endpointA = endpointFor('a'), endpointB = endpointFor('b');
  // Validation: non-URL endpoints, missing keys, malformed base64url and
  // out-of-range keys are all rejected without persisting anything.
  await expect(registerPushSubscription({ userId: actor.userId }, { endpoint: 'not-a-url', keys: { p256dh: P256DH_A, auth: AUTH } })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  await expect(registerPushSubscription({ userId: actor.userId }, { endpoint: endpointA, keys: { p256dh: P256DH_A } })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  await expect(registerPushSubscription({ userId: actor.userId }, { endpoint: endpointA, keys: { p256dh: 'short', auth: AUTH } })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  await expect(registerPushSubscription({ userId: actor.userId }, { endpoint: endpointA, keys: { p256dh: P256DH_A, auth: AUTH, extra: 1 } })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  await expect(registerPushSubscription({ userId: actor.userId }, { endpoint: endpointA, expirationTime: 'not-a-timestamp', keys: { p256dh: P256DH_A, auth: AUTH } })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  expect(await listPushSubscriptions({ userId: actor.userId })).toHaveLength(0);

  // Two devices for the same user; re-registering the same endpoint dedupes.
  expect(await registerPushSubscription({ userId: actor.userId }, { endpoint: endpointA, keys: { p256dh: P256DH_A, auth: AUTH } })).toEqual({ created: true, total: 1 });
  expect(await registerPushSubscription({ userId: actor.userId }, { endpoint: endpointA, keys: { p256dh: P256DH_A, auth: AUTH } })).toEqual({ created: false, total: 1 });
  expect(await registerPushSubscription({ userId: actor.userId }, { endpoint: endpointB, keys: { p256dh: P256DH_B, auth: AUTH } })).toEqual({ created: true, total: 2 });
  const listed = await listPushSubscriptions({ userId: actor.userId });
  expect(listed).toHaveLength(2);
  expect(listed.every((r) => typeof r.endpoint === 'string' && typeof r.createdAt === 'string')).toBe(true);

  // Isolation: the other user sees nothing and cannot remove this user's rows.
  expect(await listPushSubscriptions({ userId: other.actor.userId })).toHaveLength(0);
  expect(await removePushSubscription({ userId: other.actor.userId }, { endpoint: endpointA })).toEqual({ removed: false });
  expect(await listPushSubscriptions({ userId: actor.userId })).toHaveLength(2);

  // Removal is user-scoped and idempotent.
  expect(await removePushSubscription({ userId: actor.userId }, { endpoint: endpointA })).toEqual({ removed: true });
  expect(await removePushSubscription({ userId: actor.userId }, { endpoint: endpointA })).toEqual({ removed: false });
  expect(await listPushSubscriptions({ userId: actor.userId })).toEqual([expect.objectContaining({ endpoint: endpointB })]);
});

it('dispatches a PUSH reminder durably per subscription with one in-app record, without doubling', async () => {
  const { actor, task } = await fixture('Long push title');
  const e1 = endpointFor('e1'), e2 = endpointFor('e2');
  await registerPushSubscription({ userId: actor.userId }, { endpoint: e1, keys: { p256dh: P256DH_A, auth: AUTH } });
  await registerPushSubscription({ userId: actor.userId }, { endpoint: e2, keys: { p256dh: P256DH_B, auth: AUTH } });
  const r = await createReminder(actor, { taskId: task.id, scheduledAt: new Date(Date.now() - 60000).toISOString(), channel: 'PUSH' });

  const [first, second] = await Promise.all([deliverDueReminders(getDb()), deliverDueReminders(getDb())]);
  // Concurrent dispatch must not double-queue: the reminder dispatches once.
  expect(first.sent + second.sent).toBe(1);
  const reminder = (await getDb().select().from(reminders).where(eq(reminders.id, r!.id)))[0]!;
  expect(reminder.status).toBe('SENT');
  const rows = await deliveriesFor(r!.id);
  expect(rows).toHaveLength(2);
  expect(rows.every((row) => row.status === 'PENDING' && row.userId === actor.userId && row.workspaceId === actor.workspaceId && row.taskId === task.id)).toBe(true);
  const payload = JSON.parse(rows[0]!.payload) as Record<string, unknown>;
  expect(payload).toMatchObject({ title: task.title, taskId: task.id, url: '/tasks' });
  expect(payload.body).toBeTruthy();
  // Exactly one durable in-app record per reminder (the notification center
  // surface), independent of the device count.
  expect(await getDb().select().from(notifications).where(eq(notifications.reminderId, r!.id))).toHaveLength(1);

  // Re-running dispatch is a no-op: the reminder is no longer SCHEDULED.
  await deliverDueReminders(getDb());
  expect(await deliveriesFor(r!.id)).toHaveLength(2);
  expect(await getDb().select().from(notifications).where(eq(notifications.reminderId, r!.id))).toHaveLength(1);
  // The (reminder, subscription) unique key is the crash-retry guarantee: a
  // duplicate queueing attempt for the same pair must be impossible.
  const target = rows[0]!;
  await expect(getDb().insert(pushDeliveries).values({ id: randomUUID(), reminderId: r!.id, subscriptionId: target.subscriptionId, userId: actor.userId, workspaceId: actor.workspaceId, taskId: task.id, payload: 'x', status: 'PENDING', expiresAt: new Date(Date.now() + 86400000) })).rejects.toBeTruthy();
  expect(await deliveriesFor(r!.id)).toHaveLength(2);
});

it('fails a PUSH reminder at dispatch with no subscriptions and exposes the reason', async () => {
  const { actor, task } = await fixture();
  const r = await createReminder(actor, { taskId: task.id, scheduledAt: new Date(Date.now() - 60000).toISOString(), channel: 'PUSH' });
  expect(await deliverDueReminders(getDb())).toMatchObject({ failed: 1 });
  expect((await getDb().select().from(reminders).where(eq(reminders.id, r!.id)))[0]!).toMatchObject({ status: 'FAILED', lastError: 'NO_PUSH_SUBSCRIPTIONS' });
  expect(await deliveriesFor(r!.id)).toHaveLength(0);
  expect(await getDb().select().from(notifications).where(eq(notifications.reminderId, r!.id))).toHaveLength(0);
});

it('respects completion, cancellation and the 24h expiry window for PUSH reminders', async () => {
  const a = await fixture(), expired = await fixture();
  await registerPushSubscription({ userId: a.actor.userId }, { endpoint: endpointFor('c1'), keys: { p256dh: P256DH_A, auth: AUTH } });
  await registerPushSubscription({ userId: expired.actor.userId }, { endpoint: endpointFor('c2'), keys: { p256dh: P256DH_A, auth: AUTH } });
  const pending = await createReminder(a.actor, { taskId: a.task.id, scheduledAt: new Date(Date.now() - 60000).toISOString(), channel: 'PUSH' });
  const stale = await createReminder(expired.actor, { taskId: expired.task.id, scheduledAt: new Date(Date.now() - 86400000 - 1000).toISOString(), channel: 'PUSH' });
  await completeTask(a.actor, a.task.id, a.task.version);
  await deliverDueReminders(getDb());
  expect((await getDb().select().from(reminders).where(eq(reminders.id, pending!.id)))[0]!.status).toBe('CANCELED');
  expect(await deliveriesFor(pending!.id)).toHaveLength(0);
  expect((await getDb().select().from(reminders).where(eq(reminders.id, stale!.id)))[0]!.status).toBe('EXPIRED');
  expect(await deliveriesFor(stale!.id)).toHaveLength(0);
});

it('delivers to every registered device exactly once through the transport', async () => {
  const { actor, task } = await fixture();
  const e1 = endpointFor('d1'), e2 = endpointFor('d2');
  await registerPushSubscription({ userId: actor.userId }, { endpoint: e1, keys: { p256dh: P256DH_A, auth: AUTH } });
  await registerPushSubscription({ userId: actor.userId }, { endpoint: e2, keys: { p256dh: P256DH_B, auth: AUTH } });
  const r = await createReminder(actor, { taskId: task.id, scheduledAt: new Date(Date.now() - 60000).toISOString(), channel: 'PUSH' });
  await deliverDueReminders(getDb());
  const calls: DeliveryCall[] = [];
  const result = await deliverPushDeliveries(getDb(), 10, stubTransport(() => 200, calls));
  expect(result).toMatchObject({ processed: 2, sent: 2, failed: 0, gone: 0, retrying: 0 });
  expect(new Set(calls.map((c) => c.endpoint))).toEqual(new Set([e1, e2]));
  const rows = await deliveriesFor(r!.id);
  expect(rows).toHaveLength(2);
  expect(rows.every((row) => row.status === 'SENT' && row.payload === '' && row.sentAt !== null)).toBe(true);
  // The in-app record survives delivery (it is the durable history surface).
  expect(await getDb().select().from(notifications).where(eq(notifications.reminderId, r!.id))).toHaveLength(1);
  expect((await getDb().select().from(reminders).where(eq(reminders.id, r!.id)))[0]!.lastError).toBeNull();
});

it('retries transient provider failures with backoff and terminates at five attempts', async () => {
  const { actor, task } = await fixture();
  const e1 = endpointFor('r1');
  await registerPushSubscription({ userId: actor.userId }, { endpoint: e1, keys: { p256dh: P256DH_A, auth: AUTH } });
  const r = await createReminder(actor, { taskId: task.id, scheduledAt: new Date(Date.now() - 60000).toISOString(), channel: 'PUSH' });
  await deliverDueReminders(getDb());
  const calls: DeliveryCall[] = [];
  const alwaysDown = stubTransport(() => 500, calls);
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    if (attempt > 1) await getDb().execute(sql`update push_deliveries set next_attempt_at = now() where reminder_id=${r!.id}::uuid`);
    const result = await deliverPushDeliveries(getDb(), 10, alwaysDown);
    expect(result).toMatchObject({ processed: 1, retrying: 1, failed: 0 });
    const [row] = await deliveriesFor(r!.id);
    expect(row!.status).toBe('PENDING');
    expect(row!.attempts).toBe(attempt);
    expect(row!.payload).not.toBe('');
    // Backoff: next claim only at now() + 2^attempts seconds (capped at 300).
    // The bound is a literal: interval 'n seconds' must not be parameterized.
    const expected = Math.min(300, 2 ** attempt);
    const [rowWindow] = await getDb().execute<{ within: string }>(sql.raw(`select case when next_attempt_at > now() and next_attempt_at <= now() + interval '${expected + 2} seconds' then 'yes' else 'no' end as within from push_deliveries where id='${row!.id}'::uuid`));
    expect(rowWindow?.within).toBe('yes');
    // While backed off, the row must not be claimable.
    expect(await deliverPushDeliveries(getDb(), 10, alwaysDown)).toMatchObject({ processed: 0 });
  }
  // Fifth attempt is terminal: FAILED, payload scrubbed, reason exposed on
  // the reminder history.
  await getDb().execute(sql`update push_deliveries set next_attempt_at = now() where reminder_id=${r!.id}::uuid`);
  const final = await deliverPushDeliveries(getDb(), 10, alwaysDown);
  expect(final).toMatchObject({ processed: 1, failed: 1, retrying: 0 });
  const [row] = await deliveriesFor(r!.id);
  expect(row).toMatchObject({ status: 'FAILED', lastError: 'PUSH_DELIVERY_FAILED', payload: '', attempts: 5 });
  expect((await getDb().select().from(reminders).where(eq(reminders.id, r!.id)))[0]!).toMatchObject({ status: 'SENT', lastError: 'PUSH_DELIVERY_FAILED' });
  expect(calls).toHaveLength(5);
  // Nothing more is claimed for a terminal delivery.
  expect(await deliverPushDeliveries(getDb(), 10, alwaysDown)).toMatchObject({ processed: 0 });
});

it('removes a gone subscription on 410, keeps siblings delivering, and clears the error once any device is sent', async () => {
  const { actor, task } = await fixture();
  const gone = endpointFor('g1'), alive = endpointFor('g2');
  await registerPushSubscription({ userId: actor.userId }, { endpoint: gone, keys: { p256dh: P256DH_A, auth: AUTH } });
  await registerPushSubscription({ userId: actor.userId }, { endpoint: alive, keys: { p256dh: P256DH_B, auth: AUTH } });
  const r = await createReminder(actor, { taskId: task.id, scheduledAt: new Date(Date.now() - 60000).toISOString(), channel: 'PUSH' });
  await deliverDueReminders(getDb());
  const calls: DeliveryCall[] = [];
  const result = await deliverPushDeliveries(getDb(), 10, stubTransport(({ endpoint }) => (endpoint === gone ? 410 : 200), calls));
  expect(result).toMatchObject({ processed: 2, sent: 1, gone: 1, failed: 0 });
  // The gone registration is deleted (idempotent lifecycle), the sibling is SENT.
  expect(await listPushSubscriptions({ userId: actor.userId })).toEqual([expect.objectContaining({ endpoint: alive })]);
  const rows = await deliveriesFor(r!.id);
  expect(rows.map((row) => row.status).sort()).toEqual(['FAILED', 'SENT']);
  // Statuses are tied to the right devices: the gone endpoint's delivery is
  // the terminal one.
  const goneDelivery = rows.find((row) => row.lastError === 'SUBSCRIPTION_GONE');
  expect(goneDelivery?.status).toBe('FAILED');
  const aliveSub = (await getDb().select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, actor.userId)))[0]!;
  expect(rows.find((row) => row.subscriptionId === aliveSub.id)?.status).toBe('SENT');
  // Any successful send clears the reminder-level error.
  expect((await getDb().select().from(reminders).where(eq(reminders.id, r!.id)))[0]!.lastError).toBeNull();
  // Re-register the gone endpoint (a fresh subscription row) and confirm a
  // new 410 removes it again — the 410 path stays idempotent end to end.
  await registerPushSubscription({ userId: actor.userId }, { endpoint: gone, keys: { p256dh: P256DH_A, auth: AUTH } });
  await getDb().execute(sql`insert into push_deliveries (id, reminder_id, subscription_id, user_id, workspace_id, task_id, payload, status, expires_at) select ${randomUUID()}::uuid, ${r!.id}::uuid, s.id, s.user_id, ${actor.workspaceId}::uuid, ${task.id}::uuid, 'x', 'PENDING', now() + interval '24 hours' from push_subscriptions s where s.endpoint=${gone}`);
  const again = await deliverPushDeliveries(getDb(), 10, stubTransport(({ endpoint }) => (endpoint === gone ? 410 : 200), calls));
  expect(again.gone).toBeGreaterThanOrEqual(1);
  expect((await listPushSubscriptions({ userId: actor.userId })).every((s) => s.endpoint !== gone)).toBe(true);
});

it('exposes all-gone as PUSH_SUBSCRIPTIONS_GONE on the reminder history', async () => {
  const { actor, task } = await fixture();
  const e1 = endpointFor('a1'), e2 = endpointFor('a2');
  await registerPushSubscription({ userId: actor.userId }, { endpoint: e1, keys: { p256dh: P256DH_A, auth: AUTH } });
  await registerPushSubscription({ userId: actor.userId }, { endpoint: e2, keys: { p256dh: P256DH_B, auth: AUTH } });
  const r = await createReminder(actor, { taskId: task.id, scheduledAt: new Date(Date.now() - 60000).toISOString(), channel: 'PUSH' });
  await deliverDueReminders(getDb());
  const calls: DeliveryCall[] = [];
  const result = await deliverPushDeliveries(getDb(), 10, stubTransport(() => 404, calls));
  expect(result).toMatchObject({ processed: 2, gone: 2 });
  expect(await listPushSubscriptions({ userId: actor.userId })).toHaveLength(0);
  expect((await getDb().select().from(reminders).where(eq(reminders.id, r!.id)))[0]!).toMatchObject({ status: 'SENT', lastError: 'PUSH_SUBSCRIPTIONS_GONE' });
});

it('leaves WEB reminders untouched and lets both channels coexist on one task', async () => {
  const { actor, task } = await fixture();
  await registerPushSubscription({ userId: actor.userId }, { endpoint: endpointFor('w1'), keys: { p256dh: P256DH_A, auth: AUTH } });
  const web = await createReminder(actor, { taskId: task.id, scheduledAt: new Date(Date.now() - 60000).toISOString(), channel: 'WEB' });
  const push = await createReminder(actor, { taskId: task.id, scheduledAt: new Date(Date.now() - 60000).toISOString(), channel: 'PUSH' });
  await deliverDueReminders(getDb());
  await deliverPushDeliveries(getDb(), 10, stubTransport(() => 200, []));
  expect((await getDb().select().from(reminders).where(eq(reminders.id, web!.id)))[0]!).toMatchObject({ status: 'SENT', channel: 'WEB', lastError: null });
  expect((await getDb().select().from(reminders).where(eq(reminders.id, push!.id)))[0]!).toMatchObject({ status: 'SENT', channel: 'PUSH', lastError: null });
  const notificationsRows = await getDb().select().from(notifications).where(eq(notifications.taskId, task.id));
  expect(notificationsRows).toHaveLength(2);
  expect((await deliveriesFor(push!.id))[0]!.status).toBe('SENT');
  // WEB delivery never touches the push queue; a WEB reminder has no push rows.
  expect(await deliveriesFor(web!.id)).toHaveLength(0);
});

it('expires undelivered push payloads after 24h and scrubs the payload', async () => {
  const { actor, task } = await fixture();
  await registerPushSubscription({ userId: actor.userId }, { endpoint: endpointFor('x1'), keys: { p256dh: P256DH_A, auth: AUTH } });
  const r = await createReminder(actor, { taskId: task.id, scheduledAt: new Date(Date.now() - 60000).toISOString(), channel: 'PUSH' });
  await deliverDueReminders(getDb());
  await getDb().execute(sql`update push_deliveries set expires_at = now() - interval '1 second' where reminder_id=${r!.id}::uuid`);
  const result = await deliverPushDeliveries(getDb(), 10, stubTransport(() => 200, []));
  expect(result).toMatchObject({ expired: 1, processed: 0 });
  expect((await deliveriesFor(r!.id))[0]!).toMatchObject({ status: 'EXPIRED', payload: '' });
});

it('no-ops delivery when no transport is configured and never claims rows', async () => {
  const { actor, task } = await fixture();
  await registerPushSubscription({ userId: actor.userId }, { endpoint: endpointFor('n1'), keys: { p256dh: P256DH_A, auth: AUTH } });
  const r = await createReminder(actor, { taskId: task.id, scheduledAt: new Date(Date.now() - 60000).toISOString(), channel: 'PUSH' });
  await deliverDueReminders(getDb());
  const result = await deliverPushDeliveries(getDb(), 10, null);
  expect(result).toEqual({ processed: 0, sent: 0, failed: 0, gone: 0, retrying: 0, expired: 0 });
  expect((await deliveriesFor(r!.id))[0]!.status).toBe('PENDING');
});

it('keeps a failed device from starving other reminders and stays claimable after a network error', async () => {
  const bad = await fixture(), good = await fixture();
  const e1 = endpointFor('p1'), e2 = endpointFor('p2');
  await registerPushSubscription({ userId: bad.actor.userId }, { endpoint: e1, keys: { p256dh: P256DH_A, auth: AUTH } });
  await registerPushSubscription({ userId: good.actor.userId }, { endpoint: e2, keys: { p256dh: P256DH_A, auth: AUTH } });
  const badReminder = await createReminder(bad.actor, { taskId: bad.task.id, scheduledAt: new Date(Date.now() - 60000).toISOString(), channel: 'PUSH' });
  const goodReminder = await createReminder(good.actor, { taskId: good.task.id, scheduledAt: new Date(Date.now() - 60000).toISOString(), channel: 'PUSH' });
  await deliverDueReminders(getDb());
  // The bad subscription's endpoint is not in the transport's allow-list: it
  // throws (a network-level failure), which must release the lease and retry
  // without starving the good reminder.
  const calls: DeliveryCall[] = [];
  const flaky = stubTransport(({ endpoint }) => { if (endpoint === e1) throw new Error('network down'); return 200; }, calls);
  await getDb().execute(sql`update push_deliveries set next_attempt_at = now() where payload <> ''`);
  const first = await deliverPushDeliveries(getDb(), 10, flaky);
  expect(first).toMatchObject({ processed: 2, sent: 1, retrying: 1 });
  const [badRow] = await getDb().select().from(pushDeliveries).where(eq(pushDeliveries.reminderId, badReminder!.id));
  expect(badRow).toMatchObject({ status: 'PENDING', leaseToken: null });
  // Next pass: the bad row is claimable again and the good one stays SENT.
  await getDb().execute(sql`update push_deliveries set next_attempt_at = now() where reminder_id=${badReminder!.id}::uuid`);
  const second = await deliverPushDeliveries(getDb(), 10, flaky);
  expect(second).toMatchObject({ processed: 1, retrying: 1, sent: 0 });
  const goodRows = await deliveriesFor(goodReminder!.id);
  expect(goodRows).toHaveLength(1);
  expect(goodRows[0]!.status).toBe('SENT');
});

it('account purge removes push registrations and undelivered payloads with the account', async () => {
  const { actor, task } = await fixture();
  await registerPushSubscription({ userId: actor.userId }, { endpoint: endpointFor('z1'), keys: { p256dh: P256DH_A, auth: AUTH } });
  await registerPushSubscription({ userId: actor.userId }, { endpoint: endpointFor('z2'), keys: { p256dh: P256DH_B, auth: AUTH } });
  const r = await createReminder(actor, { taskId: task.id, scheduledAt: new Date(Date.now() - 60000).toISOString(), channel: 'PUSH' });
  await deliverDueReminders(getDb());
  expect(await getDb().select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, actor.userId))).toHaveLength(2);
  expect(await deliveriesFor(r!.id)).toHaveLength(2);
  await getDb().update(users).set({ deletionRequestedAt: new Date(Date.now() - 31 * 86400000) }).where(eq(users.id, actor.userId));
  expect(await purgeAccount(getDb(), actor.userId, new Date(Date.now() - 30 * 86400000))).toBe(true);
  expect(await getDb().select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, actor.userId))).toHaveLength(0);
  expect(await deliveriesFor(r!.id)).toHaveLength(0);
  // No orphaned delivery rows for the purged user anywhere in the queue.
  const orphans = await getDb().execute<{ id: string }>(sql`select id from push_deliveries where user_id=${actor.userId}::uuid`);
  expect(orphans).toHaveLength(0);
});

it('snoozes PUSH reminders through the same history flow as WEB', async () => {
  const { actor, task } = await fixture();
  await registerPushSubscription({ userId: actor.userId }, { endpoint: endpointFor('s1'), keys: { p256dh: P256DH_A, auth: AUTH } });
  const r = await createReminder(actor, { taskId: task.id, scheduledAt: new Date(Date.now() - 60000).toISOString(), channel: 'PUSH' });
  await deliverDueReminders(getDb());
  const { snoozeReminder } = await import('./reminders');
  const next = await snoozeReminder(actor, r!.id, 10);
  expect(next.channel).toBe('PUSH');
  expect(next.id).not.toBe(r!.id);
  expect((await getDb().select().from(reminders).where(and(eq(reminders.id, r!.id))) )[0]!.supersededById).toBe(next.id);
});
