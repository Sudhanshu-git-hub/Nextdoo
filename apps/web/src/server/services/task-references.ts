import { and, eq, inArray, isNull } from 'drizzle-orm';
import { notFound, uuid } from '@nextdoo/contracts';
import { projects, sections, tags, tasks, type Database } from '@nextdoo/db';

/** Existence is not authorization: every referenced object must share the tenant. */
export async function assertTaskReferences(
  db: Pick<Database, 'select'>,
  workspaceId: string,
  input: { projectId?: unknown; sectionId?: unknown; parentTaskId?: unknown; tagIds?: unknown },
  currentProjectId: string | null = null,
): Promise<void> {
  const projectId = input.projectId === undefined ? currentProjectId : input.projectId;
  if (projectId != null) {
    const id = uuid.parse(projectId);
    const [project] = await db.select({ id: projects.id }).from(projects).where(and(
      eq(projects.id, id), eq(projects.workspaceId, workspaceId), eq(projects.status, 'ACTIVE'), isNull(projects.deletedAt),
    ));
    if (!project) throw notFound('project', id);
  }
  if (input.sectionId != null) {
    const id = uuid.parse(input.sectionId);
    const [section] = await db.select().from(sections).where(and(
      eq(sections.id, id), eq(sections.workspaceId, workspaceId), isNull(sections.deletedAt),
    ));
    if (!section || section.projectId !== projectId) throw notFound('section', id);
  }
  if (input.parentTaskId != null) {
    const id = uuid.parse(input.parentTaskId);
    const [parent] = await db.select({ id: tasks.id }).from(tasks).where(and(
      eq(tasks.id, id), eq(tasks.workspaceId, workspaceId), isNull(tasks.deletedAt),
    ));
    if (!parent) throw notFound('task', id);
  }
  if (input.tagIds !== undefined) {
    const ids = [...new Set(uuid.array().max(50).parse(input.tagIds))];
    if (!ids.length) return;
    const owned = await db.select({ id: tags.id }).from(tags).where(and(
      inArray(tags.id, ids), eq(tags.workspaceId, workspaceId),
    ));
    if (owned.length !== ids.length) throw notFound('tag', 'reference');
  }
}
