import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditLogs, idempotencyKeys, outbox, tasks, trackingEvents, users, workspaces } from '@nextdoo/db';
import { requireTestDatabase } from '../../../../../tests/database';
import { getDb } from '../db';
import { registerUser } from './accounts';
import { createTask } from './tasks';
import { purgeDueAccounts } from './data-rights';
await requireTestDatabase();
async function fixture(days: number) {
  const u = await registerUser({ email: `purge-${randomUUID()}@test.local`, name: null, passwordHash: 'test-not-login', timeZone: 'UTC' });
  const actor = { userId: u.id, workspaceId: u.workspaceId };
  const task = await createTask(actor, { workspaceId: u.workspaceId, title: `Private content ${randomUUID()}`, priority: 'NONE', tagIds: [] });
  await getDb().update(users).set({ deletionRequestedAt: new Date(Date.now() - days * 86400000) }).where(eq(users.id, u.id));
  await getDb().insert(idempotencyKeys).values({ key: randomUUID(), userId: u.id, scope: 'test-purge', requestHash: 'test', responseBody: task, responseStatus: 200, expiresAt: new Date(Date.now() + 86400000) });
  return { actor, task };
}

describe('policy-safe account purge', () => {
  it('purges an expired account WITH history and private response/outbox data, but retains audit evidence', async () => {
    const { actor, task } = await fixture(31);
    const before = await getDb().select().from(auditLogs).where(eq(auditLogs.actorId, actor.userId));
    expect(before.length).toBeGreaterThan(0);
    expect(await purgeDueAccounts()).toContain(actor.userId);
    expect(await getDb().select().from(users).where(eq(users.id, actor.userId))).toHaveLength(0);
    expect(await getDb().select().from(tasks).where(eq(tasks.id, task.id))).toHaveLength(0);
    expect(await getDb().select().from(trackingEvents).where(eq(trackingEvents.workspaceId, actor.workspaceId))).toHaveLength(0);
    expect(await getDb().select().from(idempotencyKeys).where(eq(idempotencyKeys.userId, actor.userId))).toHaveLength(0);
    expect(await getDb().select().from(outbox).where(eq(outbox.workspaceId, actor.workspaceId))).toHaveLength(0);
    // All pre-purge evidence remains, and the destructive step itself is
    // recorded as exactly one new account.purged compliance row.
    const after = await getDb().select().from(auditLogs).where(eq(auditLogs.actorId, actor.userId));
    const beforeIds = new Set(before.map((r) => r.id));
    expect(after.filter((r) => beforeIds.has(r.id))).toHaveLength(before.length);
    const added = after.filter((r) => !beforeIds.has(r.id));
    expect(added).toHaveLength(1);
    expect(added[0]!.action).toBe('account.purged');
  });
  it('the real worker purge job also removes accounts with history', async () => {
    const { actor } = await fixture(31);
    const { JOBS } = await import('../../../../worker/src/jobs');
    const { sql } = await import('../../../../worker/src/runtime');
    try {
      await JOBS.find((j) => j.name === 'accounts.purge')!.run();
      expect(await getDb().select().from(users).where(eq(users.id, actor.userId))).toHaveLength(0);
    } finally { await sql.end(); }
  });
  it('does not purge a live/grace-period account and cannot rewrite or delete its history', async () => {
    const { actor, task } = await fixture(1);
    expect(await purgeDueAccounts()).not.toContain(actor.userId);
    await expect(getDb().delete(trackingEvents).where(eq(trackingEvents.taskId, task.id))).rejects.toThrow();
    await expect(getDb().update(trackingEvents).set({ payload: {} }).where(eq(trackingEvents.taskId, task.id))).rejects.toThrow();
    await expect(getDb().delete(workspaces).where(eq(workspaces.id, actor.workspaceId))).rejects.toThrow();
    expect(await getDb().select().from(trackingEvents).where(eq(trackingEvents.taskId, task.id))).toHaveLength(1);
  });
});
