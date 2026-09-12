import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { conflictSnapshots, tasks, sections } from '@nextdoo/db';
import { requireTestDatabase } from '../../../../../tests/database';
import { getDb } from '../db';
import { registerUser } from './accounts';
import { createTask, loadTask, updateTask } from './tasks';
import { createProject, createTag } from './projects';
import { pushMutations, resolveConflict } from './sync';

await requireTestDatabase();
type Actor = { userId: string; workspaceId: string };
let alice: Actor, bob: Actor;
beforeAll(async () => {
  const account = async (): Promise<Actor> => {
    const u = await registerUser({ email: `isolation-${randomUUID()}@test.local`, name: null, passwordHash: 'test-not-login', timeZone: 'UTC' });
    return { userId: u.id, workspaceId: u.workspaceId };
  };
  alice = await account(); bob = await account();
});
const create = (a: Actor, extra = {}) => createTask(a, { workspaceId: a.workspaceId, title: `private-${randomUUID()}`, priority: 'NONE', tagIds: [], ...extra });
const mutation = (id: string, operation: 'create' | 'update' | 'delete', payload = {}, baseVersion: number | null = null) => ({
  mutationId: randomUUID(), entityType: 'task' as const, entityId: id, operation, baseVersion, payload, createdAt: new Date().toISOString(),
});
const push = (a: Actor, m: ReturnType<typeof mutation>) => pushMutations(a, { deviceId: 'isolation-test', mutations: [m] });

function expectPrivate(result: unknown, title: string) {
  expect(JSON.stringify(result)).not.toContain(title);
}

describe('release-blocking tenant isolation', () => {
  it('rejects a foreign task-ID create collision without disclosing its entity', async () => {
    const victim = await create(alice);
    const result = await push(bob, mutation(victim.id, 'create', { title: 'attacker' }));
    expectPrivate(result, victim.title);
    expect(result.results[0]?.status).toBe('rejected');
    expect((await loadTask(alice.workspaceId, victim.id)).title).toBe(victim.title);
  });
  it('never replays another workspace mutation response', async () => {
    const victim = await create(alice);
    const m = mutation(victim.id, 'update', { description: 'private description' }, victim.version);
    await push(alice, m);
    const result = await push(bob, m);
    expectPrivate(result, victim.title);
    expect(JSON.stringify(result)).not.toContain('private description');
    expect(result.results[0]?.status).toBe('rejected');
  });
  for (const operation of ['update', 'delete'] as const) {
    it(`does not ${operation} foreign tasks`, async () => {
      const victim = await create(alice);
      const result = await push(bob, mutation(victim.id, operation, { title: 'attack' }, 1));
      expectPrivate(result, victim.title);
      const after = await loadTask(alice.workspaceId, victim.id);
      expect(after.status).toBe('ACTIVE'); expect(after.title).toBe(victim.title); expect(after.version).toBe(1);
    });
  }
  for (const field of ['projectId', 'sectionId', 'tagIds'] as const) {
    it(`rejects foreign ${field} on online and sync create/update`, async () => {
      const project = await createProject(alice, { name: 'Private project' });
      const [section] = await getDb().select().from(sections).where(eq(sections.projectId, project.id));
      const tag = await createTag(alice.workspaceId, `private-${randomUUID()}`);
      const extra = field === 'projectId' ? { projectId: project.id }
        : field === 'sectionId' ? { sectionId: section!.id } : { tagIds: [tag.id] };
      await expect(create(bob, extra)).rejects.toThrow();
      const own = await create(bob);
      await expect(updateTask(bob, own.id, { version: own.version, ...extra })).rejects.toThrow();
      const synced = await push(bob, mutation(randomUUID(), 'create', { title: 'attack', ...extra }));
      expect(synced.results[0]?.status).toBe('rejected');
      const edit = await push(bob, mutation(own.id, 'update', extra, own.version));
      expect(edit.results[0]?.status).toBe('rejected');
      expect((await loadTask(bob.workspaceId, own.id)).version).toBe(1);
    });
  }
  it('conflict resolution rechecks entity tenant, even for an inconsistent snapshot', async () => {
    const victim = await create(alice), id = randomUUID();
    await getDb().insert(conflictSnapshots).values({ id, workspaceId: bob.workspaceId, entityType: 'task', entityId: victim.id,
      localPayload: { title: 'attack' }, serverPayload: {}, expiresAt: new Date(Date.now() + 86400000) });
    await resolveConflict(bob, id, 'local').catch(() => {});
    expect((await loadTask(alice.workspaceId, victim.id)).title).toBe(victim.title);
  });
  it('normal object boundaries remain scoped, not just the replay path', async () => {
    const victim = await create(alice);
    await expect(loadTask(bob.workspaceId, victim.id)).rejects.toThrow();
    await expect(updateTask(bob, victim.id, { version: 1, title: 'attack' })).rejects.toThrow();
    expect((await getDb().select().from(tasks).where(eq(tasks.id, victim.id)))[0]?.workspaceId).toBe(alice.workspaceId);
  });
});
