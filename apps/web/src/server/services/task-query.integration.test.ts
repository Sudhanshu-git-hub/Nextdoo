import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { tasks, taskTags } from '@nextdoo/db';
import { taskQuerySchema } from '@nextdoo/contracts';
import { requireTestDatabase } from '../../../../../tests/database';
import { getDb } from '../db';
import { registerUser } from './accounts';
import { createProject, createTag } from './projects';
import { queryTasks } from './tasks';
await requireTestDatabase();
async function fixture() {
 const u = await registerUser({ email: `query-${randomUUID()}@test.local`, passwordHash: 'test', name: null, timeZone: 'UTC' });
 const actor = { workspaceId: u.workspaceId, userId: u.id };
 const a = await createProject(actor, { name: 'alpha' }), z = await createProject(actor, { name: 'Zeta' });
 const ids = Array.from({ length: 6 }, () => randomUUID());
 const dates = ['2026-09-08T12:00:00.000002Z', '2026-09-08T12:00:00.000001Z', null, '2026-09-08T12:00:00.000001Z', '2026-09-09T00:00:00Z', null];
 const priorities = ['LOW', 'HIGH', 'NONE', 'HIGH', 'MEDIUM', 'NONE'] as const;
 const estimates = [20, 0, null, 20, 5, null];
 const projects = [z.id, a.id, null, a.id, z.id, null];
 await getDb().insert(tasks).values(ids.map((id, i) => ({ id, workspaceId: actor.workspaceId, title: `Query ${i}`, priority: priorities[i]!, estimateMinutes: estimates[i], projectId: projects[i],
  dueAt: dates[i] ? sql`${dates[i]}::timestamptz` : null,
  createdAt: sql`${`2026-01-01T00:00:00.00000${i + 1}Z`}::timestamptz`, position: `9007199254740993.000000000${i + 1}`,
 })));
 return { actor, ids, project: a, keys: { createdAt: [1, 2, 3, 4, 5, 6], dueAt: [2, 1, null, 1, 3, null], priority: [1, 3, 0, 3, 2, 0], estimateMinutes: estimates, project: [2, 1, null, 1, 2, null], position: [1, 2, 3, 4, 5, 6] } };
}
for (const sortBy of ['createdAt', 'dueAt', 'priority', 'estimateMinutes', 'project', 'position'] as const) {
 for (const sortOrder of ['asc', 'desc'] as const) it(`${sortBy} ${sortOrder} pages exactly through ties and nulls without losing precision`, async () => {
  const { actor, ids, keys } = await fixture();
  const expected = ids.map((id, i) => ({ id, key: keys[sortBy][i] })).sort((a, b) => {
   if (a.key === null && b.key !== null) return 1; if (b.key === null && a.key !== null) return -1;
   const order = (a.key ?? 0) - (b.key ?? 0) || a.id.localeCompare(b.id);
   return sortOrder === 'asc' ? order : -order;
  }).map((r) => r.id);
  const found: string[] = []; let cursor: string | undefined;
  for (let i = 0; i < 4; i++) {
   const page = await queryTasks(actor.workspaceId, taskQuerySchema.parse({ workspaceId: actor.workspaceId, sortBy, sortOrder, limit: 2, cursor }));
   found.push(...page.data.map((t) => t.id));
   if (!page.hasMore) break; cursor = page.nextCursor!;
  }
  expect(found).toEqual(expected); expect(new Set(found).size).toBe(6);
 });
}
it('combines status, project, tag, priority, text and due bounds before pagination', async () => {
 const { actor, ids, project } = await fixture();
 const tag = await createTag(actor.workspaceId, 'selected');
 await getDb().insert(taskTags).values([{ taskId: ids[1]!, tagId: tag.id }, { taskId: ids[0]!, tagId: tag.id }]);
 const page = await queryTasks(actor.workspaceId, taskQuerySchema.parse({ workspaceId: actor.workspaceId, status: 'ACTIVE', projectId: project.id, tagId: tag.id, priority: 'HIGH', q: 'Query', dueAfter: '2026-09-08T00:00:00Z', dueBefore: '2026-09-08T23:59:59Z', limit: 1 }));
 expect(page.data.map((t) => t.id)).toEqual([ids[1]]); expect(page.hasMore).toBe(false);
 const high = await queryTasks(actor.workspaceId, taskQuerySchema.parse({ workspaceId: actor.workspaceId, priority: 'HIGH' }));
 expect(new Set(high.data.map((t) => t.id))).toEqual(new Set([ids[1], ids[3]]));
 const unscheduled = await queryTasks(actor.workspaceId, taskQuerySchema.parse({ workspaceId: actor.workspaceId, hasDueDate: 'false' }));
 expect(new Set(unscheduled.data.map((t) => t.id))).toEqual(new Set([ids[2], ids[5]]));
});
it('new cursors are tied to workspace, filters and ordering, but allow changing page size', async () => {
 const { actor } = await fixture(), other = await fixture();
 const input = { workspaceId: actor.workspaceId, sortBy: 'dueAt', sortOrder: 'asc', limit: 2 };
 const first = await queryTasks(actor.workspaceId, taskQuerySchema.parse(input));
 for (const extra of [{ sortOrder: 'desc' }, { priority: 'HIGH' }, { q: 'Query' }, { sortBy: 'estimateMinutes' }]) {
  await expect(queryTasks(actor.workspaceId, taskQuerySchema.parse({ ...input, ...extra, cursor: first.nextCursor }))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
 }
 await expect(queryTasks(other.actor.workspaceId, taskQuerySchema.parse({ ...input, workspaceId: other.actor.workspaceId, cursor: first.nextCursor }))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
 expect((await queryTasks(actor.workspaceId, taskQuerySchema.parse({ ...input, cursor: first.nextCursor, limit: 1 }))).data).toHaveLength(1);
});
it('keeps legacy newest-first cursors and rejects invalid sort/range requests', async () => {
 const { actor, ids } = await fixture();
 const legacy = Buffer.from(JSON.stringify({ c: '2026-01-01T00:00:00.000005Z', i: ids[4] })).toString('base64url');
 expect((await queryTasks(actor.workspaceId, taskQuerySchema.parse({ workspaceId: actor.workspaceId, cursor: legacy }))).data.map((t) => t.id)).toEqual([ids[3], ids[2], ids[1], ids[0]]);
 for (const extra of [{ sortBy: 'sql' }, { sortOrder: 'sideways' }, { priority: 'URGENT' }, { dueAfter: '2026-09-09T00:00:00Z', dueBefore: '2026-09-08T00:00:00Z' }, { hasDueDate: 'false', dueBefore: '2026-09-08T00:00:00Z' }]) expect(taskQuerySchema.safeParse({ workspaceId: actor.workspaceId, ...extra }).success).toBe(false);
});
it('foreign projects/tags cannot broaden a query and deleted tasks stay out of normal sorts', async () => {
 const a = await fixture(), b = await fixture();
 const tag = await createTag(b.actor.workspaceId, 'foreign');
 for (const filter of [{ projectId: b.project.id }, { tagId: tag.id }]) expect((await queryTasks(a.actor.workspaceId, taskQuerySchema.parse({ workspaceId: a.actor.workspaceId, ...filter, sortBy: 'project' }))).data).toHaveLength(0);
 await getDb().update(tasks).set({ status: 'DELETED', deletedAt: new Date() }).where(eq(tasks.id, a.ids[1]!));
 const page = await queryTasks(a.actor.workspaceId, taskQuerySchema.parse({ workspaceId: a.actor.workspaceId, sortBy: 'dueAt' }));
 expect(page.data).toHaveLength(5); expect(page.data.some((t) => t.id === a.ids[1])).toBe(false);
});
it('due bounds preserve microseconds and reject reversed sub-millisecond ranges', async () => {
 const { actor, ids } = await fixture();
 const date = '2026-09-08T12:00:00.000001Z';
 const page = await queryTasks(actor.workspaceId, taskQuerySchema.parse({ workspaceId: actor.workspaceId, dueAfter: date, dueBefore: date }));
 expect(new Set(page.data.map((t) => t.id))).toEqual(new Set([ids[1], ids[3]]));
 expect(taskQuerySchema.safeParse({ workspaceId: actor.workspaceId, dueAfter: '2026-09-08T12:00:00.000002Z', dueBefore: date }).success).toBe(false);
});
it('rejects malformed and mistyped cursor payloads before SQL for every sort', async () => {
 const { actor } = await fixture();
 const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
 for (const sortBy of ['createdAt', 'dueAt', 'priority', 'estimateMinutes', 'project', 'position'] as const) {
  const input = { workspaceId: actor.workspaceId, sortBy, limit: 1 };
  const first = await queryTasks(actor.workspaceId, taskQuerySchema.parse(input));
  const token = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString());
  for (const extra of [{ k: {} }, { i: 'not-a-uuid' }, { v: 2 }, { k: sortBy === 'project' ? 'a\0b' : 'bad' }, { k: sortBy === 'project' ? 'a'.repeat(801) : '99999999999999999999999999999999999999' }]) {
   await expect(queryTasks(actor.workspaceId, taskQuerySchema.parse({ ...input, cursor: encode({ ...token, ...extra }) }))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  }
  if (['createdAt', 'priority', 'position'].includes(sortBy)) await expect(queryTasks(actor.workspaceId, taskQuerySchema.parse({ ...input, cursor: encode({ ...token, k: null }) }))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
 }
 for (const cursor of ['bad', encode(null), encode([]), encode({ c: 'invalid', i: randomUUID() })]) await expect(queryTasks(actor.workspaceId, taskQuerySchema.parse({ workspaceId: actor.workspaceId, cursor }))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
 const legacy = encode({ c: '2026-01-01T00:00:00Z', i: randomUUID() });
 await expect(queryTasks(actor.workspaceId, taskQuerySchema.parse({ workspaceId: actor.workspaceId, sortBy: 'dueAt', cursor: legacy }))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
});
it('maximum Unicode project names round-trip and a concurrent newer insert does not shift continuation', async () => {
 const { actor, ids } = await fixture();
 const project = await createProject(actor, { name: '界'.repeat(200) });
 await getDb().update(tasks).set({ projectId: project.id }).where(eq(tasks.workspaceId, actor.workspaceId));
 const input = { workspaceId: actor.workspaceId, sortBy: 'project', limit: 2 };
 const first = await queryTasks(actor.workspaceId, taskQuerySchema.parse(input));
 expect(first.nextCursor!.length).toBeGreaterThan(500); expect(first.nextCursor!.length).toBeLessThanOrEqual(2048);
 const second = await queryTasks(actor.workspaceId, taskQuerySchema.parse({ ...input, cursor: first.nextCursor }));
 expect(new Set([...first.data, ...second.data].map((t) => t.id)).size).toBe(4);
 const before = await queryTasks(actor.workspaceId, taskQuerySchema.parse({ workspaceId: actor.workspaceId, limit: 2 }));
 await getDb().insert(tasks).values({ id: randomUUID(), workspaceId: actor.workspaceId, title: 'Concurrent newer task' });
 const after = await queryTasks(actor.workspaceId, taskQuerySchema.parse({ workspaceId: actor.workspaceId, cursor: before.nextCursor }));
 expect([...before.data, ...after.data].map((t) => t.id)).toEqual([...ids].reverse());
});
it('created-date ties use UUID order and sort-only requests use documented defaults', async () => {
 const { actor, ids } = await fixture();
 await getDb().update(tasks).set({ createdAt: sql`'2026-01-01T00:00:00.000001Z'::timestamptz` }).where(eq(tasks.workspaceId, actor.workspaceId));
 for (const sortOrder of ['asc', 'desc'] as const) {
  const first = await queryTasks(actor.workspaceId, taskQuerySchema.parse({ workspaceId: actor.workspaceId, sortOrder, limit: 3 }));
  const second = await queryTasks(actor.workspaceId, taskQuerySchema.parse({ workspaceId: actor.workspaceId, sortOrder, cursor: first.nextCursor }));
  const sorted = [...ids].sort(); expect([...first.data, ...second.data].map((t) => t.id)).toEqual(sortOrder === 'asc' ? sorted : sorted.reverse());
 }
 for (const sortBy of ['createdAt', 'dueAt', 'priority', 'estimateMinutes', 'project', 'position'] as const) {
  const input = { workspaceId: actor.workspaceId, sortBy };
  const implicit = await queryTasks(actor.workspaceId, taskQuerySchema.parse(input));
  const explicit = await queryTasks(actor.workspaceId, taskQuerySchema.parse({ ...input, sortOrder: ['createdAt', 'priority'].includes(sortBy) ? 'desc' : 'asc' }));
  expect(implicit.data.map((t) => t.id)).toEqual(explicit.data.map((t) => t.id));
 }
 expect(taskQuerySchema.safeParse({ workspaceId: actor.workspaceId, dueAfter: '2026-09-09T05:30:00.000002+05:30', dueBefore: '2026-09-09T00:00:00.000001Z' }).success).toBe(false);
});
