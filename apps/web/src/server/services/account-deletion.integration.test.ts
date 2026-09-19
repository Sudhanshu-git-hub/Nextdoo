import { randomUUID } from 'node:crypto';
import { and, count, eq, isNull, or, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * M6-i7 regression for the account-deletion lifecycle (PRD §6.1 acceptance
 * "re-authentication" + "defined retention period", §11.1 risk table
 * "Re-authentication, retention window, audit, restore path", §13.5,
 * §14.3 `POST /v1/account/deletion` + cancel).
 *
 * Shared integration database (services are bound to the process-wide pool);
 * every fixture is a fresh account that the tests destroy through the real
 * purge path, so the suite is self-cleaning.
 *
 * Covered: re-auth success/failure · exact grace boundary · cancel/restore
 * before purge · repeated requests keep the original deadline · session
 * invalidation · verification/reset email suppression at the real boundary ·
 * complete account-data removal · protected records that must remain ·
 * export/attachment file cleanup · billing/entitlement cleanup · tenant
 * isolation incl. partial failure + next-pass retry through the real worker
 * sweep · idempotent reruns · email re-use before/after purge.
 *
 * Worker-level retry/backoff/dead-letter behaviour is covered by
 * apps/worker/src/account-purge.integration.test.ts; the user-visible
 * browser flow by apps/web/e2e/account-deletion.spec.ts.
 */

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:55432/nextdoo';

async function probe(): Promise<true> {
  const { requireTestDatabase } = await import('../../../../../tests/database');
  return requireTestDatabase();
}

const available = await probe();
const maybe = () => (available ? it : it.skip);

type Ctx = {
  db: Awaited<ReturnType<typeof import('../db').getDb>>;
  rights: typeof import('./data-rights');
  tokens: typeof import('./auth-tokens');
  auth: typeof import('../auth');
  schema: typeof import('@nextdoo/db');
};

let ctx: Ctx | null = null;

beforeAll(async () => {
  if (!available) return;
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.AUTH_SECRET ??= 'test-only-secret-0123456789abcdefghij';

  const { getDb } = await import('../db');
  ctx = {
    db: getDb(),
    rights: await import('./data-rights'),
    tokens: await import('./auth-tokens'),
    auth: await import('../auth'),
    schema: await import('@nextdoo/db'),
  };
}, 30000);

const PASSWORD = 'deletion-lifecycle-password-1';
const DAY = 86_400_000;
/** Fixed reference instant for exact-boundary assertions (real time never enters the comparison). */
const NOW = new Date('2026-09-12T00:00:00.000Z');

async function newUser(): Promise<{ userId: string; workspaceId: string; email: string }> {
  const { registerUser } = await import('./accounts');
  const email = `del-${randomUUID()}@test.local`;
  const u = await registerUser({
    email,
    passwordHash: await ctx!.auth.hashPassword(PASSWORD),
    name: null,
    timeZone: 'UTC',
  });
  return { userId: u.id, workspaceId: u.workspaceId, email: u.email };
}

/** Dates the deletion request as if it had happened at NOW + offsetMs. */
async function requestAt(userId: string, offsetMs: number): Promise<void> {
  const { users } = ctx!.schema;
  await ctx!.db.update(users).set({ deletionRequestedAt: new Date(NOW.getTime() + offsetMs) }).where(eq(users.id, userId));
}

/** Backdates the request past the grace window and runs the real purge. */
async function destroy(userId: string): Promise<void> {
  await requestAt(userId, -31 * DAY);
  await ctx!.rights.purgeDueAccounts(NOW);
}

/** Small in-memory object store standing in for the durable file stores. */
function fakeStore() {
  const files = new Set<string>();
  const store = {
    write: async (key: string, data: Uint8Array) => { files.add(key); void data; },
    read: async (key: string) => (files.has(key) ? new Uint8Array([1]) : null),
    remove: async (key: string) => { files.delete(key); },
  };
  return { files, store };
}

describe('account deletion lifecycle (integration)', () => {
  maybe()('re-authentication: a wrong password schedules nothing, the correct one schedules 30 days out', async () => {
    const s = ctx!.schema;
    const user = await newUser();

    await expect(ctx!.rights.requestAccountDeletion(user.userId, 'definitely-not-the-password'))
      .rejects.toThrow(/not correct/i);
    expect((await ctx!.rights.getDeletionStatus(user.userId)).scheduled).toBe(false);

    const status = await ctx!.rights.requestAccountDeletion(user.userId, PASSWORD);
    expect(status.scheduled).toBe(true);
    expect((Date.parse(status.purgeAfter!) - Date.parse(status.requestedAt!)) / DAY).toBe(30);
    expect(await ctx!.db.select({ id: s.users.id }).from(s.users).where(eq(s.users.id, user.userId))).toHaveLength(1);
    await destroy(user.userId);
  });

  maybe()('exact grace boundary: requested exactly 30 days before the run is due, one millisecond earlier is not', async () => {
    const s = ctx!.schema;
    const due = await newUser();
    const early = await newUser();

    await requestAt(due.userId, -30 * DAY); // exactly at the boundary
    await requestAt(early.userId, -30 * DAY + 1); // one ms inside the window

    expect(await ctx!.rights.purgeDueAccounts(NOW)).toContain(due.userId);
    expect(await ctx!.db.select({ id: s.users.id }).from(s.users).where(eq(s.users.id, due.userId))).toHaveLength(0);

    expect(await ctx!.rights.purgeDueAccounts(NOW)).not.toContain(early.userId);
    expect(await ctx!.db.select({ id: s.users.id }).from(s.users).where(eq(s.users.id, early.userId))).toHaveLength(1);
    await destroy(early.userId);
  });

  maybe()('cancelling during the grace window restores the account and stops the purge (the login restore path)', async () => {
    const user = await newUser();
    await ctx!.rights.requestAccountDeletion(user.userId, PASSWORD);

    // The login route calls exactly this when the owner signs back in.
    await ctx!.rights.cancelAccountDeletion(user.userId);
    const status = await ctx!.rights.getDeletionStatus(user.userId);
    expect(status.scheduled).toBe(false);
    expect(status.purgeAfter).toBeNull();

    // The restored account is no longer purge-due even after real time passes.
    expect(await ctx!.rights.purgeDueAccounts()).not.toContain(user.userId);
    await destroy(user.userId);
  });

  maybe()('repeated deletion requests are idempotent: the original deadline is never extended', async () => {
    const user = await newUser();
    await ctx!.rights.requestAccountDeletion(user.userId, PASSWORD);

    // The owner asks again 20 days later.
    await requestAt(user.userId, -20 * DAY);
    const second = await ctx!.rights.requestAccountDeletion(user.userId, PASSWORD);

    expect(second.requestedAt).toBe(new Date(NOW.getTime() - 20 * DAY).toISOString());
    expect(second.purgeAfter).toBe(new Date(NOW.getTime() + 10 * DAY).toISOString());
    await destroy(user.userId);
  });

  maybe()('requesting deletion invalidates every session immediately', async () => {
    const s = ctx!.schema;
    const user = await newUser();
    const tokenA = await ctx!.auth.createSession(user.userId, 'web');
    const tokenB = await ctx!.auth.createSession(user.userId, 'desktop');
    expect(await ctx!.auth.resolveSession(tokenA)).not.toBeNull();

    await ctx!.rights.requestAccountDeletion(user.userId, PASSWORD);

    const sessions = await ctx!.db
      .select({ revokedAt: s.sessions.revokedAt })
      .from(s.sessions)
      .where(eq(s.sessions.userId, user.userId));
    expect(sessions).toHaveLength(2);
    expect(sessions.every((r) => r.revokedAt !== null)).toBe(true);
    expect(await ctx!.auth.resolveSession(tokenA)).toBeNull();
    expect(await ctx!.auth.resolveSession(tokenB)).toBeNull();
    await destroy(user.userId);
  });

  maybe()('reset/verification emails: issuable during the grace window, suppressed once it expires, dead after purge', async () => {
    const s = ctx!.schema;
    const user = await newUser();
    const unconsumedResetTokens = async () => {
      const [row] = await ctx!.db
        .select({ n: count() })
        .from(s.authTokens)
        .where(and(eq(s.authTokens.userId, user.userId), eq(s.authTokens.purpose, 'PASSWORD_RESET'), isNull(s.authTokens.consumedAt)));
      return Number(row?.n ?? 0);
    };

    // During the window the account is still live: a reset credential is a
    // normal operation (the PRD does not mandate suppression while pending).
    await requestAt(user.userId, -1 * DAY);
    await ctx!.tokens.requestPasswordReset(user.email);
    expect(await unconsumedResetTokens()).toBe(1);

    // An outstanding verification re-send is also possible while pending.
    await expect(ctx!.tokens.requestEmailVerification(user.userId, user.email)).resolves.toBeUndefined();

    // Once the grace period has elapsed the address is treated as unknown:
    // no credential, no email, no enumeration signal.
    await requestAt(user.userId, -31 * DAY);
    await expect(ctx!.tokens.requestPasswordReset(user.email)).resolves.toBeUndefined();
    expect(await unconsumedResetTokens()).toBe(1); // still only the pre-expiry one

    // After the purge the account is gone: nothing can be issued, and the
    // pre-purge credentials are cascade-removed.
    await ctx!.rights.purgeDueAccounts(NOW);
    expect(await ctx!.db.select({ id: s.users.id }).from(s.users).where(eq(s.users.id, user.userId))).toHaveLength(0);
    await expect(ctx!.tokens.requestEmailVerification(user.userId, user.email)).rejects.toThrow();
    await expect(ctx!.tokens.requestPasswordReset(user.email)).resolves.toBeUndefined();
    const [row] = await ctx!.db.select({ n: count() }).from(s.authTokens).where(eq(s.authTokens.userId, user.userId));
    expect(Number(row?.n ?? 0)).toBe(0);
  });

  maybe()('complete account-data removal: every user- and workspace-scoped row is gone', async () => {
    const s = ctx!.schema;
    const user = await newUser();
    const actor = { userId: user.userId, workspaceId: user.workspaceId };
    const now = Date.now();

    const { createTask } = await import('./tasks');
    const task = await createTask(actor, { workspaceId: user.workspaceId, title: 'Purge fixture task', priority: 'NONE', tagIds: [] });
    await ctx!.db.insert(s.reminders).values({
      id: randomUUID(), workspaceId: user.workspaceId, taskId: task.id, userId: user.userId,
      scheduledAt: new Date(now + 60_000), minutesBeforeDue: 10,
    });
    await ctx!.db.insert(s.trackingEvents).values({
      id: randomUUID(), workspaceId: user.workspaceId, taskId: task.id,
      type: 'TASK_STARTED', occurredAt: new Date(now - 60_000), idempotencyKey: randomUUID(),
    });
    await ctx!.db.insert(s.syncTombstones).values({
      id: randomUUID(), workspaceId: user.workspaceId, entityType: 'task', entityId: task.id,
      deletedAt: new Date(now - 60_000), purgeAfter: new Date(now + DAY),
    });
    await ctx!.db.insert(s.authTokens).values({
      id: randomUUID(), userId: user.userId, purpose: 'PASSWORD_RESET',
      tokenHash: `hash-${randomUUID()}`, expiresAt: new Date(now + 30 * 60_000),
    });
    await ctx!.db.insert(s.recoveryCodes).values({ id: randomUUID(), userId: user.userId, codeHash: `hash-${randomUUID()}` });
    await ctx!.db.insert(s.deviceRegistrations).values({ id: randomUUID(), userId: user.userId, deviceId: `dev-${randomUUID()}`, platform: 'web' });
    await ctx!.db.insert(s.userPreferences).values({ userId: user.userId, key: 'weekStart', value: 1 });
    await ctx!.db.insert(s.mailDeliveries).values({ id: randomUUID(), userId: user.userId, kind: 'reset-password', encryptedMessage: 'sealed', expiresAt: new Date(now + DAY) });
    await ctx!.db.insert(s.outbox).values({ id: randomUUID(), eventType: 'task.created', workspaceId: user.workspaceId, actorId: user.userId, entityType: 'task', entityId: task.id, payload: {} });
    await ctx!.db.insert(s.idempotencyKeys).values({ key: randomUUID(), scope: 'task.create', userId: user.userId, requestHash: 'h', responseStatus: 200, responseBody: {}, expiresAt: new Date(now + DAY) });
    // A live paid subscription that must die with the account.
    await ctx!.db.update(s.subscriptions).set({ plan: 'PRO', status: 'ACTIVE', currentPeriodEnd: new Date(now + 30 * DAY) }).where(eq(s.subscriptions.userId, user.userId));
    await ctx!.db.insert(s.entitlements).values({ id: randomUUID(), userId: user.userId, feature: 'max_tasks', limitValue: 500 });

    await requestAt(user.userId, -31 * DAY);
    await ctx!.rights.purgeDueAccounts(NOW);

    const zero = async (label: string, table: PgTable, where: SQL) => {
      const [row] = await ctx!.db.select({ n: count() }).from(table).where(where);
      expect(Number(row?.n ?? 0), `expected 0 rows — ${label}`).toBe(0);
    };
    await zero('user row', s.users, eq(s.users.id, user.userId));
    await zero('workspace row', s.workspaces, eq(s.workspaces.id, user.workspaceId));
    await zero('task row', s.tasks, eq(s.tasks.id, task.id));
    await zero('reminder row', s.reminders, eq(s.reminders.workspaceId, user.workspaceId));
    await zero('tracking event row', s.trackingEvents, eq(s.trackingEvents.workspaceId, user.workspaceId));
    await zero('sync tombstone row', s.syncTombstones, eq(s.syncTombstones.workspaceId, user.workspaceId));
    await zero('auth token row', s.authTokens, eq(s.authTokens.userId, user.userId));
    await zero('recovery code row', s.recoveryCodes, eq(s.recoveryCodes.userId, user.userId));
    await zero('device registration row', s.deviceRegistrations, eq(s.deviceRegistrations.userId, user.userId));
    await zero('preference row', s.userPreferences, eq(s.userPreferences.userId, user.userId));
    await zero('mail delivery row', s.mailDeliveries, eq(s.mailDeliveries.userId, user.userId));
    await zero('outbox row', s.outbox, eq(s.outbox.workspaceId, user.workspaceId));
    await zero('idempotency key row', s.idempotencyKeys, eq(s.idempotencyKeys.userId, user.userId));
    await zero('subscription row', s.subscriptions, eq(s.subscriptions.userId, user.userId));
    await zero('entitlement row', s.entitlements, eq(s.entitlements.userId, user.userId));
  });

  maybe()('protected records remain: audit evidence and provider billing events outlive the account', async () => {
    const s = ctx!.schema;
    const user = await newUser();
    const actor = { userId: user.userId, workspaceId: user.workspaceId };

    const { createTask } = await import('./tasks');
    await createTask(actor, { workspaceId: user.workspaceId, title: 'Evidence fixture task', priority: 'NONE', tagIds: [] });
    const providerEventId = `evt_${randomUUID()}`;
    await ctx!.db.insert(s.billingEvents).values({
      provider: 'STRIPE', providerEventId, type: 'invoice.paid',
      userId: user.userId, payload: { amount: 400 },
    });

    await requestAt(user.userId, -31 * DAY);
    const before = await ctx!.db
      .select({ id: s.auditLogs.id })
      .from(s.auditLogs)
      .where(or(eq(s.auditLogs.workspaceId, user.workspaceId), and(eq(s.auditLogs.actorId, user.userId), isNull(s.auditLogs.workspaceId))));
    expect(before.length).toBeGreaterThan(0);

    await ctx!.rights.purgeDueAccounts(NOW);

    // Every audit row — workspace-scoped and account-level — survives, plus
    // the compliance record of the destructive step itself.
    const after = await ctx!.db
      .select({ id: s.auditLogs.id, action: s.auditLogs.action, metadata: s.auditLogs.metadata })
      .from(s.auditLogs)
      .where(or(eq(s.auditLogs.workspaceId, user.workspaceId), and(eq(s.auditLogs.actorId, user.userId), isNull(s.auditLogs.workspaceId))));
    const beforeIds = new Set(before.map((a) => a.id));
    expect(after.filter((a) => beforeIds.has(a.id))).toHaveLength(before.length); // none lost
    const newIds = after.filter((a) => !beforeIds.has(a.id));
    expect(newIds).toHaveLength(1); // exactly the compliance record
    const purgedRow = newIds[0]!;
    expect(purgedRow.action).toBe('account.purged');
    expect(purgedRow.metadata).toHaveProperty('deletionRequestedAt');
    expect(purgedRow.metadata).toHaveProperty('purgedAt');
    expect(after.some((a) => a.action === 'account.registered')).toBe(true);

    // Provider billing evidence (PRD §13.5: billing records as required by
    // tax and accounting obligations) is not a cascade target.
    const billing = await ctx!.db.select({ id: s.billingEvents.providerEventId }).from(s.billingEvents).where(eq(s.billingEvents.userId, user.userId));
    expect(billing).toHaveLength(1);
  });

  maybe()('exports and attachments: rows cascade and object files are removed — no private file outlives the account', async () => {
    const s = ctx!.schema;
    const user = await newUser();
    const actor = { userId: user.userId, workspaceId: user.workspaceId };
    const { createTask } = await import('./tasks');
    const task = await createTask(actor, { workspaceId: user.workspaceId, title: 'File fixture task', priority: 'NONE', tagIds: [] });

    const exportKey = `exports/${user.userId}/bundle.json`;
    const attachmentKey = `attachments/${user.userId}/receipt.png`;
    await ctx!.db.insert(s.exports).values({
      id: randomUUID(), userId: user.userId, workspaceId: user.workspaceId,
      status: 'READY', objectKey: exportKey, sizeBytes: 42,
    });
    await ctx!.db.insert(s.attachments).values({
      id: randomUUID(), workspaceId: user.workspaceId, taskId: task.id, uploaderId: user.userId,
      objectKey: attachmentKey, fileName: 'receipt.png', contentType: 'image/png', sizeBytes: 42,
    });

    const store = fakeStore();
    store.files.add(exportKey);
    store.files.add(attachmentKey);
    await requestAt(user.userId, -31 * DAY);
    const purged = await ctx!.schema.purgeAccount(
      ctx!.db, user.userId, new Date(NOW.getTime() - 30 * DAY),
      { artifactStore: store.store, attachmentStore: store.store },
    );
    expect(purged).toBe(true);

    expect(store.files.has(exportKey)).toBe(false);
    expect(store.files.has(attachmentKey)).toBe(false);
    expect(store.files.size).toBe(0);
    expect(await ctx!.db.select({ id: s.exports.id }).from(s.exports).where(eq(s.exports.userId, user.userId))).toHaveLength(0);
    expect(await ctx!.db.select({ id: s.attachments.id }).from(s.attachments).where(eq(s.attachments.workspaceId, user.workspaceId))).toHaveLength(0);
  });

  maybe()('billing and entitlement state cascade with the account while provider billing evidence remains', async () => {
    const s = ctx!.schema;
    const user = await newUser();
    const now = Date.now();
    await ctx!.db.update(s.subscriptions).set({
      plan: 'TEAM', status: 'ACTIVE', provider: 'STRIPE',
      providerCustomerId: `cus_${randomUUID()}`, providerSubscriptionId: `sub_${randomUUID()}`,
      currentPeriodEnd: new Date(now + 30 * DAY),
    }).where(eq(s.subscriptions.userId, user.userId));
    await ctx!.db.insert(s.entitlements).values({ id: randomUUID(), userId: user.userId, feature: 'seats', limitValue: 5 });
    await ctx!.db.insert(s.billingEvents).values({ provider: 'STRIPE', providerEventId: `evt_${randomUUID()}`, type: 'customer.subscription.updated', userId: user.userId, payload: {} });

    await requestAt(user.userId, -31 * DAY);
    await ctx!.rights.purgeDueAccounts(NOW);

    expect(await ctx!.db.select({ id: s.subscriptions.id }).from(s.subscriptions).where(eq(s.subscriptions.userId, user.userId))).toHaveLength(0);
    expect(await ctx!.db.select({ id: s.entitlements.id }).from(s.entitlements).where(eq(s.entitlements.userId, user.userId))).toHaveLength(0);
    expect(await ctx!.db.select({ id: s.billingEvents.providerEventId }).from(s.billingEvents).where(eq(s.billingEvents.userId, user.userId))).toHaveLength(1);
  });

  maybe()('tenant isolation with partial failure: one poisoned account cannot block, and is retried on the next pass', async () => {
    const s = ctx!.schema;
    const victim = await newUser(); // poisoned
    const bystander = await newUser(); // healthy, also due
    const owner = await newUser(); // not due; hosts the cross-tenant reference

    // A review note in the OWNER's workspace authored by the victim. The
    // owner's workspace outlives the victim's purge, and its no-action FK on
    // users makes the victim's purge a genuine FK failure — the strongest
    // partial-failure injection the schema allows.
    await ctx!.db.insert(s.reviewNotes).values({
      workspaceId: owner.workspaceId, day: '2026-09-01', body: 'Cross-tenant fixture note', updatedBy: victim.userId,
    });

    await requestAt(victim.userId, -31 * DAY);
    await requestAt(bystander.userId, -31 * DAY);

    // The real worker sweep (same code the accounts.purge job runs).
    const { sweepDueAccounts } = await import('../../../../worker/src/jobs');
    const cutoff = new Date(NOW.getTime() - 30 * DAY);
    const first = await sweepDueAccounts(cutoff);
    expect(first.purged).toContain(bystander.userId);
    expect(first.purged).not.toContain(victim.userId);
    expect(first.failed.map((f) => f.userId)).toEqual([victim.userId]);

    // The bystander is fully gone; the victim and the owner are untouched.
    expect(await ctx!.db.select({ id: s.users.id }).from(s.users).where(eq(s.users.id, bystander.userId))).toHaveLength(0);
    expect(await ctx!.db.select({ id: s.users.id }).from(s.users).where(eq(s.users.id, victim.userId))).toHaveLength(1);
    expect(await ctx!.db.select({ id: s.users.id }).from(s.users).where(eq(s.users.id, owner.userId))).toHaveLength(1);

    // Audit evidence for both outcomes.
    const victimAudit = await ctx!.db.select({ action: s.auditLogs.action, metadata: s.auditLogs.metadata }).from(s.auditLogs).where(and(eq(s.auditLogs.actorId, victim.userId), isNull(s.auditLogs.workspaceId)));
    expect(victimAudit.some((a) => a.action === 'account.purge_failed' && typeof (a.metadata as Record<string, unknown>).error === 'string')).toBe(true);
    const bystanderAudit = await ctx!.db.select({ action: s.auditLogs.action }).from(s.auditLogs).where(and(eq(s.auditLogs.actorId, bystander.userId), isNull(s.auditLogs.workspaceId)));
    expect(bystanderAudit.some((a) => a.action === 'account.purged')).toBe(true);

    // Next pass after the reference is repaired: the victim is finally purged.
    await ctx!.db.delete(s.reviewNotes).where(and(eq(s.reviewNotes.workspaceId, owner.workspaceId), eq(s.reviewNotes.updatedBy, victim.userId)));
    const second = await sweepDueAccounts(cutoff);
    expect(second.purged).toEqual([victim.userId]);
    expect(second.failed).toEqual([]);

    // The owner's account and its data are completely untouched by all of this.
    expect(await ctx!.db.select({ id: s.workspaces.id }).from(s.workspaces).where(eq(s.workspaces.id, owner.workspaceId))).toHaveLength(1);
    await destroy(owner.userId);
  });

  maybe()('idempotent rerun: purging an already-purged account is a no-op and the next sweep finds nothing', async () => {
    const user = await newUser();
    await requestAt(user.userId, -31 * DAY);
    const cutoff = new Date(NOW.getTime() - 30 * DAY);

    const once = await ctx!.schema.purgeAccount(ctx!.db, user.userId, cutoff);
    expect(once).toBe(true);
    // A crash/restart after the commit: the recheck under lock finds no user.
    const again = await ctx!.schema.purgeAccount(ctx!.db, user.userId, cutoff);
    expect(again).toBe(false);
    expect(await ctx!.rights.purgeDueAccounts(NOW)).not.toContain(user.userId);
  });

  maybe()('email re-use: refused while the deletion is pending, allowed once the account is purged', async () => {
    const user = await newUser();
    await ctx!.rights.requestAccountDeletion(user.userId, PASSWORD);

    const { registerUser } = await import('./accounts');
    await expect(registerUser({
      email: user.email,
      passwordHash: await ctx!.auth.hashPassword('brand-new-password-1'),
      name: null,
      timeZone: 'UTC',
    })).rejects.toThrow(/cannot be registered/i);

    await destroy(user.userId);
    const reborn = await registerUser({
      email: user.email,
      passwordHash: await ctx!.auth.hashPassword('brand-new-password-1'),
      name: null,
      timeZone: 'UTC',
    });
    expect(reborn.id).not.toBe(user.userId);
    expect((await ctx!.rights.getDeletionStatus(reborn.id)).scheduled).toBe(false);
    await destroy(reborn.id);
  });
});
