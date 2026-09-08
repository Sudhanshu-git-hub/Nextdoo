import { withWorkspaceTransaction } from './transactions';
import { enforceProjectLimit } from './entitlements';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { createProjectSchema, createTagSchema, projectVersionSchema, updateProjectSchema, versionConflict, type UpdateProjectInput, notFound } from '@nextdoo/contracts';
import { projects, sections, tags, type Database } from '@nextdoo/db';
import { getDb } from '../db';
import { newId } from '../ids';
import { publishEvent, recordSyncChange, writeAudit } from './events';

export async function listProjects(workspaceId: string) {
  const db = getDb();
  return db
    .select()
    .from(projects)
    .where(and(eq(projects.workspaceId, workspaceId), isNull(projects.deletedAt)))
    .orderBy(asc(projects.position), asc(projects.createdAt));
}

export async function createProject(
  actor: ProjectActor,
  input: { name: string; color?: string; description?: string | null },
) {
  input = createProjectSchema.parse({ ...input, workspaceId: actor.workspaceId });
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

    await recordProjectChange(tx, actor, created, 'created', ['name', 'description', 'color']);
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

export interface ProjectActor { userId: string; workspaceId: string; requestId?: string }
type ProjectRow = typeof projects.$inferSelect;

export async function loadProject(workspaceId: string, id: string): Promise<ProjectRow> {
  const [row] = await getDb().select().from(projects).where(and(eq(projects.id, id), eq(projects.workspaceId, workspaceId), isNull(projects.deletedAt))).limit(1);
  if (!row) throw notFound('project', id);
  return row;
}

export async function updateProject(actor: ProjectActor, id: string, input: UpdateProjectInput): Promise<ProjectRow> {
  input = updateProjectSchema.parse(input);
  return withWorkspaceTransaction(actor.workspaceId, async (db) => {
    const current = await loadProject(actor.workspaceId, id);
    if (current.version !== input.version) throw versionConflict('project', id);
    const { version, ...fields } = input;
    const [row] = await db.update(projects).set({ ...fields, version: version + 1, updatedAt: new Date() })
      .where(and(eq(projects.id, id), eq(projects.workspaceId, actor.workspaceId), eq(projects.version, version))).returning();
    if (!row) throw versionConflict('project', id);
    await recordProjectChange(db, actor, row, 'updated', Object.keys(fields));
    return row;
  });
}

/** Archive the project only: never cascade into user tasks, reminders or history. */
export async function setProjectArchived(actor: ProjectActor, id: string, version: number, archived: boolean): Promise<ProjectRow> {
  projectVersionSchema.parse({ version });
  return withWorkspaceTransaction(actor.workspaceId, async (db) => {
    const current = await loadProject(actor.workspaceId, id);
    if (current.version !== version) throw versionConflict('project', id);
    const status = archived ? 'ARCHIVED' : 'ACTIVE';
    if (current.status === status) return current;
    if (!archived) await enforceProjectLimit(actor.userId, actor.workspaceId);
    const now = new Date();
    const [row] = await db.update(projects).set({ status, archivedAt: archived ? now : null, version: version + 1, updatedAt: now })
      .where(and(eq(projects.id, id), eq(projects.workspaceId, actor.workspaceId), eq(projects.version, version))).returning();
    if (!row) throw versionConflict('project', id);
    await recordProjectChange(db, actor, row, archived ? 'archived' : 'restored', ['status', 'archivedAt']);
    return row;
  });
}

async function recordProjectChange(db: Database, actor: ProjectActor, row: ProjectRow, action: 'created' | 'updated' | 'archived' | 'restored', fields: string[]) {
  await recordSyncChange(db, { workspaceId: actor.workspaceId, entityType: 'project', entityId: row.id,
    operation: action === 'created' ? 'create' : 'update', version: row.version,
    payload: { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), archivedAt: row.archivedAt?.toISOString() ?? null, deletedAt: null },
  });
  await publishEvent(db, { workspaceId: actor.workspaceId, actorId: actor.userId, entityType: 'project', entityId: row.id,
    eventType: `project.${action}`, correlationId: actor.requestId, payload: { fields, version: row.version },
  });
  await writeAudit(db, { workspaceId: actor.workspaceId, actorId: actor.userId, action: `project.${action}`,
    targetType: 'project', targetId: row.id, requestId: actor.requestId, metadata: { fields, version: row.version },
  });
}
