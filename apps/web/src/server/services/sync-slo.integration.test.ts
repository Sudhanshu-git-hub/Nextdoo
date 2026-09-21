import { beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '../db';

/**
 * SY-10 / PRD §10.9 qualification: 5,000 queued offline mutations across
 * four devices drain against the real server + Postgres, then every
 * integrity property is verified against a reference model.
 *
 * This is the repeatable qualification harness — the same code path is
 * what produced the milestone's recorded numbers. It asserts the hard
 * requirements (no duplicates, no lost mutations, ordering, tombstone
 * protection, conflict preservation, tenant isolation, quarantine/retry)
 * and prints the full measurement summary (latencies, throughput,
 * failures, retries, quarantines, integrity).
 */

async function probe(): Promise<true> {
  const { requireTestDatabase } = await import('../../../../../tests/database');
  return requireTestDatabase();
}

const available = await probe();
const maybe = () => (available ? it : it.skip);

let actors: {
  actor: { userId: string; workspaceId: string };
  foreign: { userId: string; workspaceId: string };
} | null = null;

beforeAll(async () => {
  if (!available) return;
  process.env.AUTH_SECRET ??= 'test-only-secret-0123456789abcdefghij';
  const { registerUser } = await import('./accounts');
  const { getDb } = await import('../db');
  const { subscriptions } = await import('@nextdoo/db');
  const { eq } = await import('drizzle-orm');
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const user = await registerUser({
    email: `sync-slo-${stamp}@test.local`,
    passwordHash: 'scrypt$deadbeef$deadbeef',
    name: 'Sync SLO A',
    timeZone: 'UTC',
  });
  const foreign = await registerUser({
    email: `sync-slo-foreign-${stamp}@test.local`,
    passwordHash: 'scrypt$deadbeef$deadbeef',
    name: 'Sync SLO Foreign',
    timeZone: 'UTC',
  });
  // The §10.9 SLO qualifies the sync engine, which is plan-independent.
  // The main workspace is moved to an unlimited (PRO) plan so the 5,000
  // mutations are not gated by the §18.1 active-task cap — that cap's
  // interaction with the sync queue is verified explicitly in the second
  // test below (FREE plan, 200-task limit).
  await getDb()
    .update(subscriptions)
    .set({ plan: 'PRO', status: 'ACTIVE', currentPeriodEnd: new Date(Date.now() + 365 * 86400000) })
    .where(eq(subscriptions.userId, user.id));
  actors = {
    actor: { userId: user.id, workspaceId: user.workspaceId },
    foreign: { userId: foreign.id, workspaceId: foreign.workspaceId },
  };
}, 30000);

describe('SY-10: 5,000-mutation multi-device drain (PRD §10.9 SLO qualification)', () => {
  maybe()(
    'drains 5,000 offline mutations across 4 devices with zero integrity violations',
    async () => {
      const { runSloScenario } = await import('./sync-slo-harness');
      const summary = await runSloScenario({
        actor: actors!.actor,
        foreignActor: actors!.foreign,
        // Device A's first four drain passes hit a simulated server 500:
        // the queue backs off (2s/4s/8s/16s) and then drains normally.
        failDevicePasses: (device, pass) => device === 'A' && pass <= 4,
      });

      // ---------- The measured results (printed for the record) ----------
      console.log('SY-10 SLO summary:', JSON.stringify(summary, null, 2));

      // ---------- Hard integrity requirements ----------
      expect(summary.totalMutations).toBe(5000);
      // Every mutation reached exactly one terminal outcome
      const total = Object.values(summary.statusCounts).reduce((a, b) => a + b, 0) + 0;
      // (200 connected-burst creates are counted on top of the 5,000)
      expect(total).toBe(5205);
      expect(summary.statusCounts.applied).toBe(4940);
      expect(summary.statusCounts.duplicate).toBe(95);
      expect(summary.statusCounts.conflict).toBe(50);
      expect(summary.statusCounts.rejected).toBe(120);

      // 99.9% integrity: the reference model must match the server exactly
      expect(summary.integrity.integrityRate).toBeGreaterThanOrEqual(0.999);
      expect(summary.integrity.mismatches).toBe(0);
      expect(summary.integrity.mismatchSamples).toEqual([]);

      // No duplicate entities, no ordering violations
      expect(summary.integrity.duplicateEntities).toBe(0);
      expect(summary.integrity.orderingViolations).toBe(0);

      // Tombstone/version protection: deletes hold, updates of deleted are
      // rejected and preserved, delete-of-deleted is a duplicate
      expect(summary.integrity.tombstonesCorrect).toBe(true);

      // Conflict preservation: every same-field conflict and every
      // update-of-deleted produced a recoverable snapshot, payload intact
      expect(summary.integrity.snapshotsFound).toBe(summary.integrity.snapshotsExpected);
      expect(summary.integrity.snapshotsFound).toBe(125);
      expect(summary.integrity.snapshotPayloadPreserved).toBe(true);

      // Ledger matches observed outcomes (idempotency history complete)
      expect(summary.integrity.ledgerMatches).toBe(true);

      // Tenant isolation: foreign attempts rejected, no cross-tenant writes
      expect(summary.integrity.tenantViolations).toBe(0);

      // Quarantine/retry correctness: the 4 simulated 500 passes on device
      // A retried and drained; device Q quarantined after 5 server failures
      // and the user-directed requeue applied exactly once
      expect(summary.simulatedServerFailures).toBe(4 * 200 + 5 * 5);
      expect(summary.peakQuarantined).toBeGreaterThanOrEqual(5);
      expect(summary.finalQuarantined).toBe(170); // conflicts + rejections, payloads kept
      expect(summary.retries).toBeGreaterThanOrEqual(825);

      // Pull side: every device's reconstructed cache equals the server's
      // live state (tombstones applied, no stale resurrection)
      expect(summary.pull.modelMatchesServer).toBe(true);
      expect(summary.pull.modelSize).toBe(summary.pull.serverLiveSize);

      // ---------- §10.9 SLO: 99% of connected mutations ack < 5 s ----------
      expect(summary.connectedBurst.count).toBe(200);
      expect(summary.connectedBurst.pctUnder5s).toBeGreaterThanOrEqual(99);
      expect(summary.connectedBurst.ms.max).toBeLessThan(5000);

      // Sanity: the whole drain completed in a bounded time
      expect(summary.totalDrainMs).toBeGreaterThan(0);
      expect(summary.totalDrainMs).toBeLessThan(600_000);

      // The foreign tenant's 5 own creations exist only in its workspace
      const db = getDb();
      const { tasks } = await import('@nextdoo/db');
      const { eq, count } = await import('drizzle-orm');
      const [foreignCount] = await db
        .select({ n: count() })
        .from(tasks)
        .where(eq(tasks.workspaceId, actors!.foreign.workspaceId));
      expect(Number(foreignCount?.n ?? 0)).toBe(5);
    },
    900_000,
  );

  maybe()(
    'draining past the plan cap rejects over-limit creates, quarantines them and loses nothing',
    async () => {
      // The §18.1 active-task cap (FREE = 200) is a commercial gate the sync
      // layer must respect. A realistic drain can exceed it; the required
      // behavior is: over-limit creates are rejected with a clear code, the
      // client quarantines them (needs-attention), the payload is preserved,
      // and nothing is silently applied or lost.
      const { randomUUID } = await import('node:crypto');
      const { registerUser } = await import('./accounts');
      const { pushMutations } = await import('./sync');
      const { tasks, syncMutations } = await import('@nextdoo/db');
      const { and, eq, count } = await import('drizzle-orm');

      const user = await registerUser({
        email: `sync-slo-cap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`,
        passwordHash: 'scrypt$deadbeef$deadbeef',
        name: 'Sync SLO Cap',
        timeZone: 'UTC',
      });
      const actor = { userId: user.id, workspaceId: user.workspaceId };
      const makeCreate = (i: number) => ({
        mutationId: randomUUID(),
        entityType: 'task' as const,
        entityId: randomUUID(),
        operation: 'create' as const,
        baseVersion: null,
        payload: { title: `Cap ${i}`, priority: 'LOW' },
        createdAt: new Date().toISOString(),
      });

      // Drain 210 creates in client-sized batches (200 + 10)
      const secondMutations = Array.from({ length: 10 }, (_, i) => makeCreate(200 + i));
      const first = await pushMutations(actor, {
        workspaceId: user.workspaceId,
        deviceId: 'cap-device',
        mutations: Array.from({ length: 200 }, (_, i) => makeCreate(i)),
      });
      expect(first.results.every((r) => r.status === 'applied')).toBe(true);
      const second = await pushMutations(actor, {
        workspaceId: user.workspaceId,
        deviceId: 'cap-device',
        mutations: secondMutations,
      });
      expect(second.results.every((r) => r.status === 'rejected')).toBe(true);
      expect(second.results.every((r) => r.error?.code === 'ENTITLEMENT_LIMIT_REACHED')).toBe(true);

      // Server state: exactly 200 tasks, 200 ledger entries, all applied
      const db = getDb();
      const [taskCount] = await db.select({ n: count() }).from(tasks).where(eq(tasks.workspaceId, user.workspaceId));
      expect(Number(taskCount?.n ?? 0)).toBe(200);
      const ledger = await db
        .select({ status: syncMutations.status, n: count() })
        .from(syncMutations)
        .where(eq(syncMutations.workspaceId, user.workspaceId))
        .groupBy(syncMutations.status);
      expect(ledger).toEqual([{ status: 'applied', n: 200 }]);

      // The rejected payloads are preserved client-side (quarantined). Once
      // the cap lifts (upgrade), re-sending the preserved payloads applies
      // each exactly once — same entity ids, no duplicates, no loss.
      const { subscriptions } = await import('@nextdoo/db');
      await db
        .update(subscriptions)
        .set({ plan: 'PRO', status: 'ACTIVE', currentPeriodEnd: new Date(Date.now() + 86400000) })
        .where(eq(subscriptions.userId, user.id));
      const retry = await pushMutations(actor, {
        workspaceId: user.workspaceId,
        deviceId: 'cap-device',
        mutations: secondMutations.map((m) => ({ ...m, mutationId: randomUUID() })),
      });
      expect(retry.results.every((r) => r.status === 'applied')).toBe(true);
      const [afterCount] = await db.select({ n: count() }).from(tasks).where(eq(tasks.workspaceId, user.workspaceId));
      expect(Number(afterCount?.n ?? 0)).toBe(210);
      // exactly the ten preserved entities exist
      const { inArray } = await import('drizzle-orm');
      const [preservedCount] = await db
        .select({ n: count() })
        .from(tasks)
        .where(and(eq(tasks.workspaceId, user.workspaceId), inArray(tasks.id, secondMutations.map((m) => m.entityId))));
      expect(Number(preservedCount?.n ?? 0)).toBe(10);
    },
    300_000,
  );
});
