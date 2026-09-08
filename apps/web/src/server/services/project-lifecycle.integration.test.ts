import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditLogs, outbox, projects, reminders, syncChanges, tasks } from '@nextdoo/db';
import { requireTestDatabase } from '../../../../../tests/database';
import { getDb } from '../db';
import { registerUser } from './accounts';
import * as service from './projects';
import * as events from './events';
import { createTask, updateTask } from './tasks';
await requireTestDatabase();
afterEach(() => vi.restoreAllMocks());
type Actor = { userId: string; workspaceId: string };
// The namespace permits a real RED run while these new service functions are absent.
const lifecycle = service as unknown as {
  loadProject: (ws: string, id: string) => Promise<typeof projects.$inferSelect>;
  updateProject: (a: Actor, id: string, input: { version: number; name?: string; description?: string | null; color?: string | null }) => Promise<typeof projects.$inferSelect>;
  setProjectArchived: (a: Actor, id: string, version: number, archived: boolean) => Promise<typeof projects.$inferSelect>;
};
async function fixture() {
  const u = await registerUser({ email: `projects-${randomUUID()}@test.local`, passwordHash: 'test', name: null, timeZone: 'UTC' });
  const actor = { userId: u.id, workspaceId: u.workspaceId };
  return { actor, project: await service.createProject(actor, { name: 'Work' }) };
}
it('project metadata edits serialize versions and publish sync, outbox and metadata-only audit', async () => {
  const { actor, project } = await fixture();
  const results = await Promise.allSettled(['Alpha', 'Beta'].map((name) => lifecycle.updateProject(actor, project.id, { version: project.version, name })));
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'RESOURCE_VERSION_CONFLICT' } });
  const current = await lifecycle.loadProject(actor.workspaceId, project.id);
  expect(current.version).toBe(project.version + 1);
  const [change] = await getDb().select().from(syncChanges).where(and(eq(syncChanges.entityId, project.id), eq(syncChanges.operation, 'update')));
  expect(change?.payload).toMatchObject({ name: current.name, status: 'ACTIVE', version: current.version });
  expect(await getDb().select().from(outbox).where(and(eq(outbox.entityId, project.id), eq(outbox.eventType, 'project.updated')))).toHaveLength(1);
  const logs = await getDb().select().from(auditLogs).where(eq(auditLogs.targetId, project.id));
  expect(JSON.stringify(logs)).not.toContain(current.name);
  expect(logs.some((l) => l.action === 'project.updated')).toBe(true);
});
it('foreign project reads, edits and archive requests never cross ownership boundaries', async () => {
  const a = await fixture(), b = await fixture();
  await expect(lifecycle.loadProject(a.actor.workspaceId, b.project.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(lifecycle.updateProject(a.actor, b.project.id, { version: b.project.version, name: 'Stolen' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(lifecycle.setProjectArchived(a.actor, b.project.id, b.project.version, true)).rejects.toMatchObject({ code: 'NOT_FOUND' });
});
it('archive preserves tasks and reminders, rejects new assignments, and allows existing task edits', async () => {
  const { actor, project } = await fixture();
  const task = await createTask(actor, { workspaceId: actor.workspaceId, title: 'Keep me', projectId: project.id, priority: 'NONE', tagIds: [] });
  await getDb().insert(reminders).values({ id: randomUUID(), workspaceId: actor.workspaceId, userId: actor.userId, taskId: task.id, channel: 'WEB', scheduledAt: new Date(Date.now() + 3600000) });
  const archived = await lifecycle.setProjectArchived(actor, project.id, project.version, true);
  expect(archived.status).toBe('ARCHIVED'); expect(archived.archivedAt).toBeInstanceOf(Date);
  expect((await getDb().select().from(tasks).where(eq(tasks.id, task.id)))[0]).toMatchObject({ status: 'ACTIVE', projectId: project.id });
  expect((await getDb().select().from(reminders).where(eq(reminders.taskId, task.id)))[0]?.status).toBe('SCHEDULED');
  await expect(createTask(actor, { workspaceId: actor.workspaceId, title: 'New', projectId: project.id, priority: 'NONE', tagIds: [] })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(await updateTask(actor, task.id, { version: task.version, description: 'Kept notes' })).toMatchObject({ description: 'Kept notes' });
  const restored = await lifecycle.setProjectArchived(actor, project.id, archived.version, false);
  expect(restored).toMatchObject({ status: 'ACTIVE', archivedAt: null, version: project.version + 2 });
});
it('concurrent restores cannot bypass the Free active-project cap', async () => {
  const { actor, project } = await fixture();
  const first = await lifecycle.setProjectArchived(actor, project.id, project.version, true);
  const other = await service.createProject(actor, { name: 'Second' });
  const second = await lifecycle.setProjectArchived(actor, other.id, other.version, true);
  await service.createProject(actor, { name: 'Active one' }); await service.createProject(actor, { name: 'Active two' });
  const results = await Promise.allSettled([first, second].map((p) => lifecycle.setProjectArchived(actor, p.id, p.version, false)));
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'ENTITLEMENT_LIMIT_REACHED' } });
  expect(await getDb().select().from(projects).where(and(eq(projects.workspaceId, actor.workspaceId), eq(projects.status, 'ACTIVE')))).toHaveLength(3);
});
it('audit failure rolls back the lifecycle state and sync/outbox records', async () => {
  const { actor, project } = await fixture();
  vi.spyOn(events, 'writeAudit').mockRejectedValueOnce(new Error('injected audit failure'));
  await expect(lifecycle.setProjectArchived(actor, project.id, project.version, true)).rejects.toThrow('injected audit failure');
  expect(await lifecycle.loadProject(actor.workspaceId, project.id)).toMatchObject({ status: 'ACTIVE', version: project.version });
  expect(await getDb().select().from(syncChanges).where(and(eq(syncChanges.entityId, project.id), eq(syncChanges.operation, 'update')))).toHaveLength(0);
  expect(await getDb().select().from(outbox).where(and(eq(outbox.entityId, project.id), eq(outbox.eventType, 'project.archived')))).toHaveLength(0);
});
