import { sectionPositionBetween } from '../section-position';
import { withWorkspaceTransaction } from './transactions';
import { enforceProjectLimit } from './entitlements';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { AppError, createSectionSchema, updateSectionSchema, type CreateSectionInput, type UpdateSectionInput, createProjectSchema, createTagSchema, projectVersionSchema, updateProjectSchema, versionConflict, type UpdateProjectInput, notFound } from '@nextdoo/contracts';
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

    await recordProjectChange(tx, actor, created, 'created', ['name', 'description', 'color']);
    // The default section commits and syncs with its parent project.
    await createSection(actor, { projectId: created.id, name: 'To do', position: 0 });
    return created;
  });
}

export async function listSections(workspaceId: string, projectId: string) {
  await loadProject(workspaceId, projectId);
  const db = getDb();
  return db
    .select()
    .from(sections)
    .where(and(eq(sections.workspaceId, workspaceId), eq(sections.projectId, projectId), isNull(sections.deletedAt)))
    .orderBy(asc(sections.position), asc(sections.id));
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


export async function createSection(actor: ProjectActor, input: CreateSectionInput) {
  input = createSectionSchema.parse(input);
  return withWorkspaceTransaction(actor.workspaceId, async (db) => {
    const project = await loadProject(actor.workspaceId, input.projectId);
    if (project.status !== 'ACTIVE') throw new AppError('VALIDATION_FAILED', 'Restore the project before changing its sections.');
    const siblings = await listSections(actor.workspaceId, project.id);
    const position = input.position === undefined ? sectionPositionBetween(siblings.at(-1)?.position ?? null, null) : input.position.toFixed(10);
    const [row] = await db.insert(sections).values({ id: newId(), workspaceId: actor.workspaceId, projectId: project.id, name: input.name, position }).returning();
    if (!row) throw notFound('section', 'new');
    await recordSectionChange(db, actor, row, 'created', ['name', 'position']);
    return row;
  });
}

export async function updateSection(actor: ProjectActor, id: string, input: UpdateSectionInput) {
  input = updateSectionSchema.parse(input);
  return withWorkspaceTransaction(actor.workspaceId, async (db) => {
    const [current] = await db.select().from(sections).where(and(eq(sections.id, id), eq(sections.workspaceId, actor.workspaceId), isNull(sections.deletedAt))).limit(1);
    if (!current) throw notFound('section', id);
    if (current.version !== input.version) throw versionConflict('section', id);
    const project = await loadProject(actor.workspaceId, current.projectId);
    if (project.status !== 'ACTIVE') throw new AppError('VALIDATION_FAILED', 'Restore the project before changing its sections.');
    const patch: Partial<typeof sections.$inferInsert> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.position !== undefined) patch.position = input.position.toFixed(10);
    if (input.beforeId !== undefined) {
      if (input.beforeId === id) throw new AppError('VALIDATION_FAILED', 'A section cannot be moved before itself.');
      const others = (await listSections(actor.workspaceId, project.id)).filter((s) => s.id !== id);
      const target = input.beforeId === null ? others.length : others.findIndex((s) => s.id === input.beforeId);
      if (target < 0) throw notFound('section', input.beforeId!);
      patch.position = sectionPositionBetween(others[target - 1]?.position ?? null, others[target]?.position ?? null);
    }
    const [row] = await db.update(sections).set({ ...patch, version: current.version + 1, updatedAt: new Date() })
      .where(and(eq(sections.id, id), eq(sections.workspaceId, actor.workspaceId), eq(sections.version, input.version))).returning();
    if (!row) throw versionConflict('section', id);
    await recordSectionChange(db, actor, row, 'updated', Object.keys(patch));
    return row;
  });
}

async function recordSectionChange(db: Database, actor: ProjectActor, row: typeof sections.$inferSelect, action: 'created' | 'updated', fields: string[]) {
  await recordSyncChange(db, { workspaceId: actor.workspaceId, entityType: 'section', entityId: row.id, operation: action === 'created' ? 'create' : 'update',
    version: row.version, payload: { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), deletedAt: null },
  });
  await publishEvent(db, { workspaceId: actor.workspaceId, actorId: actor.userId, entityType: 'section', entityId: row.id, eventType: `section.${action}`, correlationId: actor.requestId, payload: { projectId: row.projectId, fields, version: row.version } });
  await writeAudit(db, { workspaceId: actor.workspaceId, actorId: actor.userId, action: `section.${action}`, targetType: 'section', targetId: row.id, requestId: actor.requestId, metadata: { projectId: row.projectId, fields, version: row.version } });
}
