import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditLogs, projects, userPreferences, workspaceMembers } from '@nextdoo/db';
import { taskQuerySchema, limitsFor } from '@nextdoo/contracts';
import { requireTestDatabase } from '../../../../../tests/database';
import { getDb } from '../db';
import { assertWorkspaceAccess } from '../auth';
import { registerUser } from './accounts';
import { buildExport } from './data-rights';
import { createTask, queryTasks } from './tasks';
import { createProject, createTag } from './projects';
await requireTestDatabase();
const account = async () => { const u = await registerUser({ email: `boundary-${randomUUID()}@test.local`, passwordHash: 'test', name: null, timeZone: 'UTC' }); return { userId: u.id, workspaceId: u.workspaceId }; };
const task = (a: Awaited<ReturnType<typeof account>>, extra = {}) => createTask(a, { workspaceId: a.workspaceId, title: `private-${randomUUID()}`, priority: 'NONE', tagIds: [], ...extra });
it('a non-owner membership does not grant personal-workspace API access', async () => {
  const a = await account(), b = await account();
  await getDb().insert(workspaceMembers).values({ workspaceId: a.workspaceId, userId: b.userId, role: 'GUEST' });
  await expect(assertWorkspaceAccess(b.userId, a.workspaceId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
});
it('personal export cannot include data from a workspace the account does not own', async () => {
  const a = await account(), b = await account(), secret = await task(a);
  await getDb().insert(workspaceMembers).values({ workspaceId: a.workspaceId, userId: b.userId, role: 'GUEST' });
  expect(JSON.stringify(await buildExport(b.userId))).not.toContain(secret.title);
});
it('export includes account-level audit evidence and stored preferences without credentials', async () => {
  const a = await account(), auditId = randomUUID();
  await getDb().insert(auditLogs).values({ id: auditId, actorId: a.userId, action: 'account.security_test', targetType: 'user', targetId: a.userId });
  await getDb().insert(userPreferences).values({ userId: a.userId, key: 'disableScores', value: true });
  const bundle = await buildExport(a.userId);
  expect(JSON.stringify(bundle.auditLogs)).toContain(auditId);
  expect(JSON.stringify(bundle)).toContain('disableScores');
  expect(JSON.stringify(bundle)).not.toContain('passwordHash');
});
it('concurrent project creation cannot bypass Free limits', async () => {
  const a = await account();
  const cap = limitsFor('FREE').projects!;
  await getDb().insert(projects).values(Array.from({ length: cap - 1 }, () => ({ id: randomUUID(), workspaceId: a.workspaceId, name: 'Fixture' })));
  await Promise.allSettled(Array.from({ length: 4 }, () => createProject(a, { name: 'Overflow' })));
  expect(await getDb().select().from(projects).where(eq(projects.workspaceId, a.workspaceId))).toHaveLength(cap);
});
it('tag filter returns only matching tasks and false does not include archived tasks', async () => {
  const a = await account(), tag = await createTag(a.workspaceId, `tag-${randomUUID()}`);
  const tagged = await task(a, { tagIds: [tag.id] }); await task(a);
  const result = await queryTasks(a.workspaceId, taskQuerySchema.parse({ workspaceId: a.workspaceId, tagId: tag.id }));
  expect(result.data.map((r) => r.id)).toEqual([tagged.id]);
  expect(taskQuerySchema.parse({ workspaceId: a.workspaceId, includeArchived: 'false' }).includeArchived).toBe(false);
});
