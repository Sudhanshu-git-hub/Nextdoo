import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { sections, syncChanges, outbox, auditLogs } from '@nextdoo/db';
import { requireTestDatabase } from '../../../../../tests/database';
import { getDb } from '../db';
import { registerUser } from './accounts';
import * as projects from './projects';
import * as events from './events';
import { createTask, updateTask } from './tasks';
await requireTestDatabase();
afterEach(() => vi.restoreAllMocks());
const api = projects;
async function fixture() {
 const u = await registerUser({ email: `board-${randomUUID()}@test.local`, passwordHash: 'test', name: null, timeZone: 'UTC' });
 const actor = { userId: u.id, workspaceId: u.workspaceId };
 return { actor, project: await projects.createProject(actor, { name: 'Work' }) };
}
it('creates and renames sections with atomic sync, outbox and content-free audit', async () => {
 const { actor, project } = await fixture();
 const section = await api.createSection(actor, { projectId: project.id, name: 'Review' });
 const renamed = await api.updateSection(actor, section.id, { version: section.version, name: 'Private review' });
 expect(renamed).toMatchObject({ name: 'Private review', version: 2 });
 expect(await getDb().select().from(syncChanges).where(eq(syncChanges.entityId, section.id))).toHaveLength(2);
 expect(await getDb().select().from(outbox).where(eq(outbox.entityId, section.id))).toHaveLength(2);
 const audit = await getDb().select().from(auditLogs).where(eq(auditLogs.targetId, section.id));
 expect(audit).toHaveLength(2); expect(JSON.stringify(audit)).not.toContain('Private review');
});
it('orders one section between neighbours without rewriting other section versions', async () => {
 const { actor, project } = await fixture();
 const first = (await projects.listSections(actor.workspaceId, project.id))[0]!;
 const middle = await api.createSection(actor, { projectId: project.id, name: 'Middle' });
 const last = await api.createSection(actor, { projectId: project.id, name: 'Last' });
 await api.updateSection(actor, last.id, { version: last.version, beforeId: middle.id });
 const result = await projects.listSections(actor.workspaceId, project.id);
 expect(result.map((s) => s.id)).toEqual([first.id, last.id, middle.id]);
 expect(result.filter((s) => s.id !== last.id).every((s) => s.version === 1)).toBe(true);
});
it('concurrent rename/reorder uses versions rather than losing an edit', async () => {
 const { actor, project } = await fixture();
 const section = (await projects.listSections(actor.workspaceId, project.id))[0]!;
 const result = await Promise.allSettled(['A', 'B'].map((name) => api.updateSection(actor, section.id, { version: section.version, name })));
 expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
 expect(result.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'RESOURCE_VERSION_CONFLICT' } });
});
it('rejects foreign project/section/anchor access and archived project section writes', async () => {
 const a = await fixture(), b = await fixture();
 const first = (await projects.listSections(a.actor.workspaceId, a.project.id))[0]!;
 const foreign = (await projects.listSections(b.actor.workspaceId, b.project.id))[0]!;
 await expect(projects.listSections(a.actor.workspaceId, b.project.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
 await expect(api.createSection(a.actor, { projectId: b.project.id, name: 'Foreign' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
 await expect(api.updateSection(a.actor, foreign.id, { version: 1, name: 'Foreign' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
 await expect(api.updateSection(a.actor, first.id, { version: 1, beforeId: foreign.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
 await projects.setProjectArchived(a.actor, a.project.id, a.project.version, true);
 await expect(api.createSection(a.actor, { projectId: a.project.id, name: 'Archived' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
 await expect(api.updateSection(a.actor, first.id, { version: 1, name: 'Archived' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
});
it('audit failure leaves neither section nor its sync/outbox records', async () => {
 const { actor, project } = await fixture();
 vi.spyOn(events, 'writeAudit').mockRejectedValueOnce(new Error('section audit failure'));
 await expect(api.createSection(actor, { projectId: project.id, name: 'Rollback' })).rejects.toThrow('section audit failure');
 expect(await projects.listSections(actor.workspaceId, project.id)).toHaveLength(1);
 expect(await getDb().select().from(outbox).where(and(eq(outbox.workspaceId, actor.workspaceId), eq(outbox.eventType, 'section.created')))).toHaveLength(1); // only the project's default section
});
it('task movement preserves lifecycle and refuses foreign/mismatched sections or stale versions', async () => {
 const { actor, project } = await fixture(), other = await projects.createProject(actor, { name: 'Other' });
 const source = (await projects.listSections(actor.workspaceId, project.id))[0]!;
 const target = (await projects.listSections(actor.workspaceId, other.id))[0]!;
 const task = await createTask(actor, { workspaceId: actor.workspaceId, title: 'Move', projectId: project.id, sectionId: source.id, tagIds: [], priority: 'NONE' });
 const foreign = await fixture();
 const foreignSection = (await projects.listSections(foreign.actor.workspaceId, foreign.project.id))[0]!;
 await expect(updateTask(actor, task.id, { version: task.version, sectionId: foreignSection.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
 await expect(updateTask(actor, task.id, { version: task.version, projectId: foreign.project.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
 await expect(updateTask(actor, task.id, { version: task.version, sectionId: target.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
 const moved = await updateTask(actor, task.id, { version: task.version, projectId: other.id, sectionId: target.id });
 expect(moved).toMatchObject({ status: 'ACTIVE', sectionId: target.id, projectId: other.id });
 await expect(updateTask(actor, task.id, { version: task.version, sectionId: null })).rejects.toMatchObject({ code: 'RESOURCE_VERSION_CONFLICT' });
});
it('section audit failure also rolls back parent creation and update versions/events', async () => {
 const { actor, project } = await fixture();
 const section = (await projects.listSections(actor.workspaceId, project.id))[0]!;
 const audit = events.writeAudit;
 vi.spyOn(events, 'writeAudit').mockImplementation(async (db, input) => {
   if (input.targetType === 'section') throw new Error('section audit failure');
   return audit(db, input);
 });
 await expect(projects.createProject(actor, { name: 'Rolled back parent' })).rejects.toThrow('section audit failure');
 expect(await projects.listProjects(actor.workspaceId)).toHaveLength(1);
 await expect(api.updateSection(actor, section.id, { version: 1, name: 'Rolled back rename' })).rejects.toThrow('section audit failure');
 expect((await projects.listSections(actor.workspaceId, project.id))[0]).toMatchObject({ name: 'To do', version: 1 });
 expect(await getDb().select().from(syncChanges).where(eq(syncChanges.workspaceId, actor.workspaceId))).toHaveLength(2);
 expect(await getDb().select().from(outbox).where(eq(outbox.workspaceId, actor.workspaceId))).toHaveLength(2);
 expect(await getDb().select().from(auditLogs).where(eq(auditLogs.workspaceId, actor.workspaceId))).toHaveLength(3); // registration + project + default section only
});
it('rejects same-workspace cross-project anchors and hides deleted sections', async () => {
 const { actor, project } = await fixture();
 const other = await projects.createProject(actor, { name: 'Other' });
 const first = (await projects.listSections(actor.workspaceId, project.id))[0]!;
 const anchor = (await projects.listSections(actor.workspaceId, other.id))[0]!;
 await expect(api.updateSection(actor, first.id, { version: 1, beforeId: anchor.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
 await getDb().update(sections).set({ deletedAt: new Date() }).where(eq(sections.id, first.id));
 expect(await projects.listSections(actor.workspaceId, project.id)).toHaveLength(0);
 await expect(api.updateSection(actor, first.id, { version: 1, name: 'Deleted' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
 const task = await createTask(actor, { workspaceId: actor.workspaceId, projectId: project.id, title: 'No deleted section', priority: 'NONE', tagIds: [] });
 await expect(updateTask(actor, task.id, { version: task.version, sectionId: first.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
});
it('density exhaustion leaves versions/events unchanged; prepend and append stay single-row', async () => {
 const { actor, project } = await fixture();
 const first = (await projects.listSections(actor.workspaceId, project.id))[0]!;
 const near = await api.createSection(actor, { projectId: project.id, name: 'Near', position: 0.0000000001 });
 const moving = await api.createSection(actor, { projectId: project.id, name: 'Moving' });
 await expect(api.updateSection(actor, moving.id, { version: 1, beforeId: near.id })).rejects.toMatchObject({ code: 'RESOURCE_VERSION_CONFLICT' });
 expect(await getDb().select().from(syncChanges).where(eq(syncChanges.entityId, moving.id))).toHaveLength(1);
 const prepended = await api.updateSection(actor, moving.id, { version: 1, beforeId: first.id });
 expect((await projects.listSections(actor.workspaceId, project.id)).map((s) => s.id)).toEqual([moving.id, first.id, near.id]);
 await api.updateSection(actor, moving.id, { version: prepended.version, beforeId: null });
 const ordered = await projects.listSections(actor.workspaceId, project.id);
 expect(ordered.map((s) => s.id)).toEqual([first.id, near.id, moving.id]);
 expect(ordered.map((s) => s.version)).toEqual([1, 1, 3]);
});
