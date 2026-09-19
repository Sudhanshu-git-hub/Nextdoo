import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTaskSchema, taskQuerySchema } from '@nextdoo/contracts';
import { outbox, projects, syncChanges, tags, taskTags } from '@nextdoo/db';
import { requireTestDatabase } from '../../../../../tests/database';
import { getDb } from '../db';
import { registerUser } from './accounts';
import { createProject } from './projects';
import * as service from './tasks';
await requireTestDatabase();
async function fixture() {
  const u = await registerUser({ email: `online-${randomUUID()}@test.local`, passwordHash: 'test', name: null, timeZone: 'UTC' });
  const actor = { userId: u.id, workspaceId: u.workspaceId };
  const create = (extra = {}) => service.createTask(actor, createTaskSchema.parse({ workspaceId: actor.workspaceId, title: 'Online work', ...extra }));
  return { actor, create };
}
it('capture resolves only the current workspace project and persists normalized unique tags', async () => {
  const { actor, create } = await fixture(), other = await fixture();
  await createProject(other.actor, { name: 'Work' });
  const project = await createProject(actor, { name: 'Work' });
  const task = await create({ projectName: 'work', tagNames: ['Finance', 'finance'] });
  expect(task.projectId).toBe(project.id);
  const links = await getDb().select().from(taskTags).where(eq(taskTags.taskId, task.id));
  expect(links).toHaveLength(1);
  expect(await getDb().select().from(tags).where(eq(tags.id, links[0]!.tagId))).toMatchObject([{ name: 'finance', workspaceId: actor.workspaceId }]);
});
it('unknown, ambiguous and archived project names fail without orphan tags or tasks', async () => {
  const { actor, create } = await fixture();
  await expect(create({ projectName: 'Missing', tagNames: ['orphan'] })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  await createProject(actor, { name: 'Work' }); await createProject(actor, { name: 'WORK' });
  await expect(create({ projectName: 'work', tagNames: ['orphan'] })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  const archived = await createProject(actor, { name: 'Archive' });
  await getDb().update(projects).set({ status: 'ARCHIVED' }).where(eq(projects.id, archived.id));
  await expect(create({ projectName: 'Archive', tagNames: ['orphan'] })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  expect(await getDb().select().from(tags).where(eq(tags.workspaceId, actor.workspaceId))).toHaveLength(0);
});
it('inbox filters before pagination rather than hiding all unfiled items behind project tasks', async () => {
  const { actor, create } = await fixture();
  const inbox = await create(), p = await createProject(actor, { name: 'Work' });
  await create({ projectId: p.id }); await create({ projectId: p.id });
  const page = await service.queryTasks(actor.workspaceId, taskQuerySchema.parse({ workspaceId: actor.workspaceId, unfiled: true, limit: 1 }));
  expect(page.data.map((t) => t.id)).toEqual([inbox.id]); expect(page.hasMore).toBe(false);
});
it('task detail returns tags for editing without exposing another workspace', async () => {
  const { actor, create } = await fixture(), other = await fixture();
  const task = await create({ tagNames: ['work'] });
  const details = service as unknown as { getTaskDetails: (ws: string, id: string) => Promise<{ tagIds: string[] }> };
  expect((await details.getTaskDetails(actor.workspaceId, task.id)).tagIds).toHaveLength(1);
  await expect(details.getTaskDetails(other.actor.workspaceId, task.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
});
it('combined tag limits and stale edits roll back newly requested tags', async () => {
  const { actor, create } = await fixture();
  const initial = await create({ tagNames: ['existing'] });
  const details = await service.getTaskDetails(actor.workspaceId, initial.id);
  await expect(create({ tagIds: details.tagIds, tagNames: Array.from({ length: 50 }, (_, i) => `overflow-${i}`) })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  await service.updateTask(actor, initial.id, { version: initial.version, title: 'New version' });
  await expect(service.updateTask(actor, initial.id, { version: initial.version, tagNames: ['stale-orphan'] })).rejects.toMatchObject({ code: 'RESOURCE_VERSION_CONFLICT' });
  expect(await getDb().select().from(tags).where(eq(tags.workspaceId, actor.workspaceId))).toMatchObject([{ name: 'existing' }]);
});
it('foreign tag references cannot be combined with newly created capture tags', async () => {
  const a = await fixture(), b = await fixture();
  const foreign = await b.create({ tagNames: ['foreign'] });
  const details = await service.getTaskDetails(b.actor.workspaceId, foreign.id);
  await expect(a.create({ tagIds: details.tagIds, tagNames: ['orphan'] })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(await getDb().select().from(tags).where(eq(tags.workspaceId, a.actor.workspaceId))).toHaveLength(0);
});

it('tag-only edits publish both relation changes and their outbox field name atomically', async () => {
  const { actor, create } = await fixture(), task = await create();
  await service.updateTask(actor, task.id, { version: task.version, tagNames: ['added'] });
  const detail = await service.getTaskDetails(actor.workspaceId, task.id);
  const [event] = await getDb().select().from(outbox).where(and(eq(outbox.entityId, task.id), eq(outbox.eventType, 'task.updated')));
  expect(event?.payload).toMatchObject({ fields: expect.arrayContaining(['tagIds']) });
  const [change] = await getDb().select().from(syncChanges).where(and(eq(syncChanges.entityId, task.id), eq(syncChanges.operation, 'update')));
  expect(change?.payload).toMatchObject({ tagIds: detail.tagIds });
});
