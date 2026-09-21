import { and, eq, isNull, sql } from 'drizzle-orm';
import { AppError, notFound, updateWorkspaceSchema, versionConflict, workspaceSettingsSchema, type UpdateWorkspaceInput } from '@nextdoo/contracts';
import { workspaces } from '@nextdoo/db';
import { getDb } from '../db';
import { withWorkspaceTransaction } from './transactions';
import { publishEvent, recordSyncChange, writeAudit } from './events';
import type { TaskActor } from './tasks';
async function load(workspaceId: string, id: string) {
 if (workspaceId.toLowerCase() !== id.toLowerCase()) throw notFound('workspace', id);
 const [row] = await getDb().select().from(workspaces).where(and(eq(workspaces.id, id), isNull(workspaces.deletedAt)));
 if (!row) throw notFound('workspace', id); return row;
}
function serialise(row: typeof workspaces.$inferSelect) {
 return { id: row.id, name: row.name, timeZone: row.timeZone, weekStart: row.weekStart, workdayStartMinute: row.workdayStartMinute, workdayEndMinute: row.workdayEndMinute, version: row.version, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}
export async function loadWorkspaceSettings(workspaceId: string, id: string) { return serialise(await load(workspaceId, id)); }
export async function updateWorkspaceSettings(actor: TaskActor, id: string, raw: UpdateWorkspaceInput) {
 const input = updateWorkspaceSchema.parse(raw);
 return withWorkspaceTransaction(actor.workspaceId, async (db) => {
  const current = await load(actor.workspaceId, id);
  if (current.ownerId !== actor.userId) throw new AppError('FORBIDDEN', 'Only the workspace owner can change its settings.');
  if (current.version !== input.version) throw versionConflict('workspace', id);
  const { version: _version, ...patch } = input;
  const merged = workspaceSettingsSchema.parse({ name: current.name, timeZone: current.timeZone, weekStart: current.weekStart, workdayStartMinute: current.workdayStartMinute, workdayEndMinute: current.workdayEndMinute, ...patch });
  const [row] = await db.update(workspaces).set({ ...merged, version: sql`${workspaces.version} + 1`, updatedAt: new Date() }).where(and(eq(workspaces.id, current.id), eq(workspaces.version, input.version))).returning();
  if (!row) throw versionConflict('workspace', id);
  const result = serialise(row);
  await writeAudit(db, { workspaceId: current.id, actorId: actor.userId, action: 'workspace.updated', targetType: 'workspace', targetId: current.id, requestId: actor.requestId, metadata: { fields: Object.keys(patch), version: row.version } });
  await recordSyncChange(db, { workspaceId: current.id, entityType: 'workspace', entityId: current.id, operation: 'update', version: row.version, payload: result });
  await publishEvent(db, { workspaceId: current.id, actorId: actor.userId, entityType: 'workspace', entityId: current.id, eventType: 'workspace.updated', payload: { fields: Object.keys(patch), version: row.version } });
  return result;
 });
}
