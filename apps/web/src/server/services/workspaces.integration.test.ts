import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { auditLogs, outbox, syncChanges, workspaces } from '@nextdoo/db';
import { requireTestDatabase } from '../../../../../tests/database';
import { getDb } from '../db';
import { registerUser } from './accounts';
import { createTask, loadTask } from './tasks';
import { attachRecurrence, getRecurrence } from './recurrence';
import { loadWorkspaceSettings, updateWorkspaceSettings } from './workspaces';
await requireTestDatabase();
async function fixture() { const user = await registerUser({ email: `workspace-${randomUUID()}@test.local`, passwordHash: 'test', name: null, timeZone: 'UTC' }); return { userId: user.id, workspaceId: user.workspaceId }; }
it('persists overnight settings with one versioned audit/outbox/sync change', async () => {
 const actor = await fixture(); const before = await loadWorkspaceSettings(actor.workspaceId, actor.workspaceId);
 const row = await updateWorkspaceSettings(actor, actor.workspaceId, { version: before.version, name: 'Night work', timeZone: 'Asia/Kolkata', weekStart: 0, workdayStartMinute: 1320, workdayEndMinute: 360 });
 expect(row).toMatchObject({ name: 'Night work', timeZone: 'Asia/Kolkata', weekStart: 0, workdayStartMinute: 1320, workdayEndMinute: 360, version: 2 });
 expect(await loadWorkspaceSettings(actor.workspaceId, actor.workspaceId)).toEqual(row);
 expect(await getDb().select().from(outbox).where(and(eq(outbox.workspaceId, actor.workspaceId), eq(outbox.eventType, 'workspace.updated')))).toHaveLength(1);
 expect(await getDb().select().from(syncChanges).where(and(eq(syncChanges.workspaceId, actor.workspaceId), eq(syncChanges.entityType, 'workspace'), eq(syncChanges.operation, 'update')))).toHaveLength(1);
 expect(await getDb().select().from(auditLogs).where(and(eq(auditLogs.workspaceId, actor.workspaceId), eq(auditLogs.action, 'workspace.updated')))).toHaveLength(1);
});
it('rejects cross-tenant access, non-owner changes, invalid fields and merged zero-length hours without mutation', async () => {
 const actor = await fixture(), other = await fixture();
 await expect(loadWorkspaceSettings(other.workspaceId, actor.workspaceId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
 await expect(updateWorkspaceSettings(other, actor.workspaceId, { version: 1, name: 'Stolen' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
 await expect(updateWorkspaceSettings({ ...other, workspaceId: actor.workspaceId }, actor.workspaceId, { version: 1, name: 'Stolen' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
 for (const patch of [{ weekStart: 7 }, { timeZone: 'Not/AZone' }, { workdayEndMinute: 540 }, { name: ' ' }, { ownerId: other.userId }, { workdayStartMinute: -1 }]) await expect(updateWorkspaceSettings(actor, actor.workspaceId, { version: 1, ...patch })).rejects.toBeTruthy();
 expect(await loadWorkspaceSettings(actor.workspaceId, actor.workspaceId)).toMatchObject({ version: 1, timeZone: 'UTC' });
});
it('concurrent changes cannot overwrite a reviewed version', async () => {
 const actor = await fixture(); const results = await Promise.allSettled(['A', 'B'].map((name) => updateWorkspaceSettings(actor, actor.workspaceId, { version: 1, name })));
 expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1); expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'RESOURCE_VERSION_CONFLICT' } });
 expect((await loadWorkspaceSettings(actor.workspaceId, actor.workspaceId)).version).toBe(2);
});
it('new task defaults inherit the workspace zone but explicit zones and generated history are preserved', async () => {
 const actor = await fixture(); const task = await createTask(actor, { workspaceId: actor.workspaceId, title: 'Fixed instant', dueAt: new Date().toISOString(), priority: 'NONE', tagIds: [] });
 const series = await attachRecurrence(actor, task.id, { version: 1, rule: { freq: 'DAILY', interval: 1, count: 1, timeZone: 'UTC' } });
 await updateWorkspaceSettings(actor, actor.workspaceId, { version: 1, timeZone: 'Asia/Kolkata' });
 expect(await loadTask(actor.workspaceId, task.id)).toMatchObject({ dueAt: new Date(task.dueAt!), timeZone: 'UTC', version: 2 });
 expect((await getRecurrence(actor.workspaceId, series.id)).occurrences).toEqual(series.occurrences);
 const make = (timeZone?: string) => createTask(actor, { workspaceId: actor.workspaceId, title: 'New work', priority: 'NONE', tagIds: [], timeZone });
 expect((await make()).timeZone).toBe('Asia/Kolkata'); expect((await make('America/New_York')).timeZone).toBe('America/New_York');
});
it('a failed outbox write rolls back settings, version, audit and sync together', async () => {
 const actor = await fixture(), name = `workspace_test_${randomUUID().replaceAll('-', '')}`;
 await getDb().execute(sql.raw(`ALTER TABLE outbox ADD CONSTRAINT ${name} CHECK (workspace_id <> '${actor.workspaceId}'::uuid OR event_type <> 'workspace.updated') NOT VALID`));
 try { await expect(updateWorkspaceSettings(actor, actor.workspaceId, { version: 1, name: 'Must roll back' })).rejects.toBeTruthy(); } finally { await getDb().execute(sql.raw(`ALTER TABLE outbox DROP CONSTRAINT ${name}`)); }
 expect((await getDb().select().from(workspaces).where(eq(workspaces.id, actor.workspaceId)))[0]!.version).toBe(1);
 expect(await getDb().select().from(syncChanges).where(and(eq(syncChanges.workspaceId, actor.workspaceId), eq(syncChanges.entityType, 'workspace'), eq(syncChanges.operation, 'update')))).toHaveLength(0);
 expect(await getDb().select().from(auditLogs).where(and(eq(auditLogs.workspaceId, actor.workspaceId), eq(auditLogs.action, 'workspace.updated')))).toHaveLength(0);
});
