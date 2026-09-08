import { withWorkspaceTransaction } from './transactions';
import { enforceProjectLimit } from './entitlements';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { createTagSchema, notFound } from '@nextdoo/contracts';
import { projects, sections, tags } from '@nextdoo/db';
import { getDb } from '../db';
import { newId } from '../ids';
import { recordSyncChange } from './events';

export async function listProjects(workspaceId: string) {
  const db = getDb();
  return db
    .select()
    .from(projects)
    .where(and(eq(projects.workspaceId, workspaceId), isNull(projects.deletedAt)))
    .orderBy(asc(projects.position), asc(projects.createdAt));
}

export async function createProject(
  actor: { userId: string; workspaceId: string },
  input: { name: string; color?: string; description?: string | null },
) {
  return withWorkspaceTransaction(actor.workspaceId, async (tx) => {
    await enforceProjectLimit(actor.userId, actor.workspaceId);
    const [created] = await tx
      .insert(projects)
      .values({
        id: newId(),
        workspaceId: actor.workspaceId,
        name: input.name,
        color: input.color ?? null,
        description: input.description ?? null,
        position: String(Date.now()),
      })
      .returning();
    if (!created) throw notFound('project', 'new');

    // Every project gets a default section so the board view is never empty.
    await tx.insert(sections).values({
      id: newId(),
      workspaceId: actor.workspaceId,
      projectId: created.id,
      name: 'To do',
      position: '0',
    });

    await recordSyncChange(tx, {
      workspaceId: actor.workspaceId,
      entityType: 'project',
      entityId: created.id,
      operation: 'create',
      payload: { id: created.id, name: created.name },
      version: created.version,
    });
    return created;
  });
}

export async function listSections(workspaceId: string, projectId: string) {
  const db = getDb();
  return db
    .select()
    .from(sections)
    .where(and(eq(sections.workspaceId, workspaceId), eq(sections.projectId, projectId), isNull(sections.deletedAt)))
    .orderBy(asc(sections.position));
}

export async function listTags(workspaceId: string) {
  const db = getDb();
  return db.select().from(tags).where(eq(tags.workspaceId, workspaceId)).orderBy(asc(tags.name));
}

export async function createTag(workspaceId: string, name: string, color?: string) {
  const input = createTagSchema.parse({ workspaceId, name, color });
  name = input.name.toLowerCase();
  return withWorkspaceTransaction(workspaceId, async (db) => {
    const [created] = await db.insert(tags).values({ id: newId(), workspaceId, name, color: color ?? null }).onConflictDoNothing().returning();
    if (created) {
      await recordSyncChange(db, { workspaceId, entityType: 'tag', entityId: created.id, operation: 'create', payload: { id: created.id, name, color: created.color }, version: 1 });
      return created;
    }
    const [existing] = await db.select().from(tags).where(and(eq(tags.workspaceId, workspaceId), eq(tags.name, name))).limit(1);
    if (!existing) throw notFound('tag', name);
    return existing;
  });
}
