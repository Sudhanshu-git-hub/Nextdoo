import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { createDb, runRetentionPurge, type Database } from '@nextdoo/db';

/**
 * M6-i6 user-visible retention (PRD §12.4 `retention.purge`, §13.5, §18.1).
 *
 * The daily job lives in the worker; this spec drives the same
 * runRetentionPurge the job invokes (the worker's own DB-backed regression
 * covers the job wiring) and then verifies the user-facing consequences:
 *
 * - a task past its 30-day restore window is physically gone: the restore
 *   endpoint 404s instead of offering recovery, and the task API 404s;
 * - a task still inside its window survives the purge and restores normally;
 * - audit history follows the plan (PRO: 30 days): the 40-day-old event is
 *   gone from the signed-in user's history, the 5-day-old one is visible;
 * - the expired task's tombstone is removed with it.
 */
const connection = createDb(process.env.DATABASE_URL!, { max: 2 });
const db: Database = connection.db;
test.afterAll(() => connection.close());

const DAY = 86_400_000;
const origin = { Origin: 'http://localhost:3100' };
const headers = () => ({ ...origin, 'Idempotency-Key': randomUUID() });

test('after 30 days a deleted task is unrecoverable, and audit history follows the plan retention', async ({ page }) => {
  const reg = await page.request.post('/api/v1/auth/register', {
    headers: { ...origin, 'X-Forwarded-For': '198.51.100.222' },
    data: { email: `retention-${randomUUID()}@test.local`, password: 'retention-e2e-password-123', timeZone: 'UTC' },
  });
  expect(reg.status()).toBe(200);
  const { workspaceId } = await reg.json();

  const create = async (title: string) => {
    const r = await page.request.post('/api/v1/tasks', { headers: headers(), data: { workspaceId, title } });
    expect(r.status()).toBe(200);
    return r.json();
  };
  const longGone = await create('Retention long-gone task');
  const stillRecoverable = await create('Retention recoverable task');

  // Both tasks go to the trash through the real API.
  for (const t of [longGone, stillRecoverable]) {
    const del = await page.request.delete(`/api/v1/tasks/${t.id}`, { headers: headers(), data: { version: t.version } });
    expect(del.status()).toBe(200);
  }

  // Simulate elapsed time: the first task left the trash 31 days ago (its
  // restore window closed a day before the purge), the second 29 days ago.
  const now = Date.now();
  await db.$client.unsafe(
    `update tasks set deleted_at = to_timestamp(${(now - 31 * DAY) / 1000}) where id = '${longGone.id}'`,
  );
  await db.$client.unsafe(
    `update sync_tombstones set deleted_at = to_timestamp(${(now - 31 * DAY) / 1000}), purge_after = to_timestamp(${(now - 1 * DAY) / 1000}) where entity_type = 'task' and entity_id = '${longGone.id}'`,
  );
  await db.$client.unsafe(
    `update tasks set deleted_at = to_timestamp(${(now - 29 * DAY) / 1000}) where id = '${stillRecoverable.id}'`,
  );

  // The owner is on PRO (30-day audit retention) when the daily purge runs.
  await db.$client.unsafe(
    `update subscriptions set plan = 'PRO', status = 'ACTIVE', current_period_end = now() + interval '30 days' where user_id = (select owner_id from workspaces where id = '${workspaceId}')`,
  );

  // Non-security audit events with distinct targets: one 40 days old (outside
  // the PRO 30-day window) and one 5 days old (inside it).
  const seedAudit = (targetId: string, daysAgo: number) =>
    db.$client.unsafe(
      `insert into audit_logs (id, workspace_id, actor_id, action, target_type, target_id, created_at)
       values (gen_random_uuid(), '${workspaceId}', (select owner_id from workspaces where id = '${workspaceId}'), 'task.updated', 'task', '${targetId}', now() - interval '${daysAgo} days')`,
    );
  await seedAudit(longGone.id, 40);
  await seedAudit(stillRecoverable.id, 5);

  // The daily purge — exactly what the worker's retention.purge job runs.
  // The tenant-scan cap is raised for this spec: in CI the database is shared
  // with every earlier E2E spec, and the production cap (200 distinct
  // tenants per run, verified in the web integration suite) could otherwise
  // defer THIS workspace to the next run and make the user-visible outcome
  // non-deterministic within a single test.
  const result = await runRetentionPurge(db, { limit: { workspaces: 100_000, accountOwners: 100_000 } });
  expect(result.failures).toEqual([]);
  expect(result.workspacesScanned).toBeGreaterThanOrEqual(1);
  expect(result.auditLogsPurged).toBeGreaterThanOrEqual(1);

  // The long-gone task is physically gone: restore is a 404 (no tombstone
  // to recover), and the task API no longer knows it.
  const restoreGone = await page.request.post(`/api/v1/tasks/${longGone.id}/restore`, { headers: headers(), data: {} });
  expect(restoreGone.status()).toBe(404);
  expect((await page.request.get(`/api/v1/tasks/${longGone.id}`)).status()).toBe(404);
  const goneRows = await db.$client.unsafe(`select count(*) as n from tasks where id = '${longGone.id}'`);
  expect(Number(goneRows[0]?.n ?? 0)).toBe(0);
  const goneTombstones = await db.$client.unsafe(`select count(*) as n from sync_tombstones where entity_type = 'task' and entity_id = '${longGone.id}'`);
  expect(Number(goneTombstones[0]?.n ?? 0)).toBe(0);

  // The still-recoverable task survived the purge and restores normally.
  const restoreRecent = await page.request.post(`/api/v1/tasks/${stillRecoverable.id}/restore`, { headers: headers(), data: {} });
  expect(restoreRecent.status()).toBe(200);
  expect((await restoreRecent.json())).toMatchObject({ status: 'ACTIVE' });

  // Audit history follows the plan: the 5-day event (recoverable task) is
  // visible and still in the database; the 40-day event (long-gone task) is
  // both invisible and physically purged.
  //
  // The assertions are scoped to the seeded 'task.updated' action: the real
  // API operations above also audit these targets (task.created / task.deleted
  // / task.restored) with recent timestamps, which correctly survive a 30-day
  // plan retention and are not what this boundary check measures.
  const audit = await (await page.request.get('/api/v1/audit-logs?category=task&limit=200')).json();
  const rows = audit.data as Array<{ targetId: string | null; action: string }>;
  const seededFor = (taskId: string) => rows.filter((r) => r.targetId === taskId && r.action === 'task.updated');
  expect(seededFor(stillRecoverable.id)).toHaveLength(1);
  expect(seededFor(longGone.id)).toHaveLength(0);
  const oldRows = await db.$client.unsafe(`select count(*) as n from audit_logs where target_id = '${longGone.id}' and action = 'task.updated'`);
  expect(Number(oldRows[0]?.n ?? 0)).toBe(0);
  const recentRows = await db.$client.unsafe(`select count(*) as n from audit_logs where target_id = '${stillRecoverable.id}' and action = 'task.updated'`);
  expect(Number(recentRows[0]?.n ?? 0)).toBe(1);
});
