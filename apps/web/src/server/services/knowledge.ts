import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, knowledgeDatabaseInput, knowledgeDatabaseUpdate, knowledgePropertyInput, knowledgeRecordInput, knowledgeRecordUpdate, knowledgeNoteInput, knowledgeNoteUpdate, knowledgeVersion, validKnowledgeValue, uuid, notFound, versionConflict, type KnowledgeValue } from '@nextdoo/contracts';
import { knowledgeTemplates } from '@nextdoo/core';
import { knowledgeDatabases as databases, knowledgeProperties as properties, knowledgeRecords as records, knowledgeValues as values, knowledgeNotes as notes, knowledgeNoteTags as noteTags, knowledgeRelations as relations, knowledgeFiles as files, tags, auditLogs, outbox, syncChanges, type Database } from '@nextdoo/db';
import { getDb } from '../db';
import { newId } from '../ids';
import { withWorkspaceTransaction } from './transactions';
import type { GoalActor } from './goals';

export type KnowledgeActor = GoalActor;
export const serialiseKnowledge = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export function invalidKnowledge(message: string): never { throw new AppError('VALIDATION_FAILED', message); }
export function checkKnowledgeVersion(current: { id: string; version: number }, version: number) { knowledgeVersion.parse({ version }); if (current.version !== version) throw versionConflict('knowledge item', current.id); }
export async function knowledgeChange(db: Database, actor: KnowledgeActor, entity: string, row: { id: string; version: number } & Record<string, unknown>, action: 'created' | 'updated' | 'deleted') {
  await db.insert(syncChanges).values({ workspaceId: actor.workspaceId, entityType: entity, entityId: row.id, operation: action === 'created' ? 'create' : action === 'deleted' ? 'delete' : 'update', version: row.version, payload: action === 'deleted' ? { id: row.id } : serialiseKnowledge(row) });
  await db.insert(outbox).values({ id: newId(), workspaceId: actor.workspaceId, actorId: actor.userId, entityType: entity, entityId: row.id, eventType: `${entity}.${action}`, schemaVersion: 1, payload: { version: row.version } });
  await db.insert(auditLogs).values({ id: newId(), workspaceId: actor.workspaceId, actorId: actor.userId, action: `${entity}.${action}`, targetType: entity, targetId: row.id, requestId: actor.requestId, metadata: { version: row.version } });
}
export async function loadKnowledgeDatabase(workspaceId: string, id: string, mutable = false) {
  uuid.parse(id); const [row] = await getDb().select().from(databases).where(and(eq(databases.id, id), eq(databases.workspaceId, workspaceId)));
  if (!row) throw notFound('database', id); if (mutable && row.archived) invalidKnowledge('Restore this database before editing it.'); return row;
}
export async function loadKnowledgeRecord(workspaceId: string, id: string, includeDeleted = false) {
  uuid.parse(id); const [row] = await getDb().select().from(records).where(and(eq(records.id, id), eq(records.workspaceId, workspaceId), includeDeleted ? undefined : isNull(records.deletedAt)));
  if (!row) throw notFound('record', id); return row;
}
export async function loadKnowledgeNote(workspaceId: string, id: string, includeDeleted = false) {
  uuid.parse(id); const [row] = await getDb().select().from(notes).where(and(eq(notes.id, id), eq(notes.workspaceId, workspaceId), includeDeleted ? undefined : isNull(notes.deletedAt)));
  if (!row) throw notFound('note', id); return row;
}
export async function knowledgeProperties(workspaceId: string, databaseId: string) {
  return getDb().select().from(properties).where(and(eq(properties.workspaceId, workspaceId), eq(properties.databaseId, databaseId))).orderBy(asc(properties.position), asc(properties.id));
}
export async function createKnowledgeDatabase(actor: KnowledgeActor, data: unknown) {
  const input = knowledgeDatabaseInput.parse(data);
  return withWorkspaceTransaction(actor.workspaceId, async (db) => {
    const template = input.templateId ? knowledgeTemplates().find((t) => t.id === input.templateId) : null;
    if (input.templateId && !template) invalidKnowledge('Unknown database template.');
    if (input.templateId && input.properties) invalidKnowledge('Choose a template or explicit properties.');
    const definitions = input.properties ?? template?.properties ?? [knowledgePropertyInput.parse({ name: 'Title', type: 'TITLE' })];
    if (definitions.filter((p) => p.type === 'TITLE').length !== 1) invalidKnowledge('A database needs exactly one Title property.');
    for (const p of definitions) if (p.config.relationDatabaseId) await loadKnowledgeDatabase(actor.workspaceId, p.config.relationDatabaseId);
    const [row] = await db.insert(databases).values({ id: newId(), workspaceId: actor.workspaceId, name: input.name, description: input.description, icon: input.icon, color: input.color }).returning();
    const created = await db.insert(properties).values(definitions.map((p, position) => ({ ...p, id: newId(), workspaceId: actor.workspaceId, databaseId: row!.id, position, relatedDatabaseId: p.config.relationDatabaseId }))).returning();
    await knowledgeChange(db, actor, 'knowledge_database', { ...row!, properties: created }, 'created'); return serialiseKnowledge({ ...row!, properties: created });
  });
}
export async function updateKnowledgeDatabase(actor: KnowledgeActor, id: string, data: unknown) {
  const input = knowledgeDatabaseUpdate.parse(data);
  return withWorkspaceTransaction(actor.workspaceId, async (db) => {
    const current = await loadKnowledgeDatabase(actor.workspaceId, id); checkKnowledgeVersion(current, input.version);
    const [row] = await db.update(databases).set({ ...input, version: current.version + 1, updatedAt: new Date() }).where(eq(databases.id, id)).returning();
    await knowledgeChange(db, actor, 'knowledge_database', row!, 'updated'); return serialiseKnowledge(row!);
  });
}
export const knowledgePropertyCommand = z.object({ version: z.number().int().positive(), property: knowledgePropertyInput }).strict();
export async function saveKnowledgeProperty(actor: KnowledgeActor, databaseId: string, propertyId: string | null, data: unknown) {
  const input = knowledgePropertyCommand.parse(data);
  return withWorkspaceTransaction(actor.workspaceId, async (db) => {
    const database = await loadKnowledgeDatabase(actor.workspaceId, databaseId, true); checkKnowledgeVersion(database, input.version);
    const existing = await knowledgeProperties(actor.workspaceId, databaseId), current = existing.find((p) => p.id === propertyId);
    if (propertyId && !current) throw notFound('property', propertyId);
    if (!current && existing.length >= 40) invalidKnowledge('A database supports up to 40 properties.');
    if (!current && input.property.type === 'TITLE') invalidKnowledge('This database already has its title property.');
    if (current && current.type !== input.property.type) invalidKnowledge('Property types are stable. Add a new property to use a different type.');
    if (input.property.config.relationDatabaseId) await loadKnowledgeDatabase(actor.workspaceId, input.property.config.relationDatabaseId);
    if (current) {
      // Validate every stored value, including deleted records, before changing choices.
      if (['SELECT', 'MULTI_SELECT'].includes(current.type)) {
        const stored = await db.select().from(values).where(eq(values.propertyId, current.id));
        if (stored.some((v) => !validKnowledgeValue(input.property, knowledgeStoredValue(v)))) invalidKnowledge('Existing records use a choice you removed. Correct those records first.');
      }
      if (current.type === 'RELATION' && JSON.stringify(current.config) !== JSON.stringify(input.property.config)) {
        const used = await db.select({ id: relations.id }).from(relations).where(eq(relations.propertyId, current.id)).limit(1);
        if (used.length) invalidKnowledge('Remove existing links before changing the relation target configuration.');
      }
      await db.update(properties).set({ ...input.property, relatedDatabaseId: input.property.config.relationDatabaseId, version: current.version + 1, updatedAt: new Date() }).where(eq(properties.id, current.id));
    } else await db.insert(properties).values({ ...input.property, id: newId(), workspaceId: actor.workspaceId, databaseId, relatedDatabaseId: input.property.config.relationDatabaseId, position: Math.max(-1, ...existing.map((p) => p.position)) + 1 });
    return touchKnowledgeDatabase(db, actor, database);
  });
}
export async function deleteKnowledgeProperty(actor: KnowledgeActor, databaseId: string, propertyId: string, version: number) {
  uuid.parse(propertyId);
  return withWorkspaceTransaction(actor.workspaceId, async (db) => {
    const database = await loadKnowledgeDatabase(actor.workspaceId, databaseId, true); checkKnowledgeVersion(database, version);
    const property = (await knowledgeProperties(actor.workspaceId, databaseId)).find((p) => p.id === propertyId);
    if (!property) throw notFound('property', propertyId); if (property.type === 'TITLE') invalidKnowledge('The title property cannot be removed.');
    const used = await db.execute(sql`select 1 from knowledge_values where property_id=${propertyId} union all select 1 from knowledge_relations where property_id=${propertyId} union all select 1 from knowledge_files where property_id=${propertyId} limit 1`);
    if (used.length) invalidKnowledge('This property still contains values or links, including deleted records. Clear them before removing it.');
    await db.delete(properties).where(eq(properties.id, propertyId)); return touchKnowledgeDatabase(db, actor, database);
  });
}
export async function reorderKnowledgeProperties(actor: KnowledgeActor, databaseId: string, version: number, ids: string[]) {
  z.array(uuid).min(1).max(40).parse(ids);
  return withWorkspaceTransaction(actor.workspaceId, async (db) => {
    const database = await loadKnowledgeDatabase(actor.workspaceId, databaseId, true); checkKnowledgeVersion(database, version);
    const existing = await knowledgeProperties(actor.workspaceId, databaseId);
    if (ids.length !== existing.length || new Set(ids).size !== ids.length || ids.some((id) => !existing.some((p) => p.id === id))) invalidKnowledge('Include every property exactly once.');
    for (let position = 0; position < ids.length; position++) await db.update(properties).set({ position, updatedAt: new Date() }).where(eq(properties.id, ids[position]!));
    return touchKnowledgeDatabase(db, actor, database);
  });
}
async function touchKnowledgeDatabase(db: Database, actor: KnowledgeActor, current: typeof databases.$inferSelect) {
  const [row] = await db.update(databases).set({ version: current.version + 1, updatedAt: new Date() }).where(eq(databases.id, current.id)).returning();
  const definitions = await knowledgeProperties(actor.workspaceId, current.id);
  await knowledgeChange(db, actor, 'knowledge_database', { ...row!, properties: definitions }, 'updated'); return serialiseKnowledge({ ...row!, properties: definitions });
}
export function knowledgeStoredValue(row: typeof values.$inferSelect): KnowledgeValue { return row.textValue ?? row.numberValue ?? row.booleanValue ?? row.dateValue ?? row.optionsValue; }
async function replaceKnowledgeValues(db: Database, actor: KnowledgeActor, row: typeof records.$inferSelect, input: Record<string, KnowledgeValue>) {
  const definitions = await knowledgeProperties(actor.workspaceId, row.databaseId);
  const writes: Array<typeof values.$inferInsert> = [];
  for (const [propertyId, value] of Object.entries(input)) {
    const property = definitions.find((p) => p.id === propertyId);
    if (!property || ['TITLE', 'FILE', 'RELATION'].includes(property.type) || !validKnowledgeValue(property, value)) invalidKnowledge(`Invalid value for ${property?.name ?? 'unknown property'}.`);
    if (value === null || value === '' || (Array.isArray(value) && !value.length)) continue;
    writes.push({ recordId: row.id, workspaceId: actor.workspaceId, databaseId: row.databaseId, propertyId, type: property.type,
      textValue: typeof value === 'string' && property.type !== 'DATE' ? value : null, dateValue: property.type === 'DATE' ? String(value) : null,
      numberValue: typeof value === 'number' ? value : null, booleanValue: typeof value === 'boolean' ? value : null, optionsValue: Array.isArray(value) ? value : null });
  }
  await db.delete(values).where(eq(values.recordId, row.id)); if (writes.length) await db.insert(values).values(writes);
}
export async function createKnowledgeRecord(actor: KnowledgeActor, databaseId: string, data: unknown) {
  const input = knowledgeRecordInput.parse(data);
  return withWorkspaceTransaction(actor.workspaceId, async (db) => {
    await loadKnowledgeDatabase(actor.workspaceId, databaseId, true);
    const [row] = await db.insert(records).values({ id: newId(), workspaceId: actor.workspaceId, databaseId, title: input.title, content: input.content }).returning();
    await replaceKnowledgeValues(db, actor, row!, input.values);
    await knowledgeChange(db, actor, 'knowledge_record', { ...row!, values: input.values }, 'created'); return serialiseKnowledge(row!);
  });
}
export async function updateKnowledgeRecord(actor: KnowledgeActor, id: string, data: unknown) {
  const input = knowledgeRecordUpdate.parse(data);
  return withWorkspaceTransaction(actor.workspaceId, async (db) => {
    const current = await loadKnowledgeRecord(actor.workspaceId, id); checkKnowledgeVersion(current, input.version); await loadKnowledgeDatabase(actor.workspaceId, current.databaseId, true);
    await replaceKnowledgeValues(db, actor, current, input.values);
    const [row] = await db.update(records).set({ title: input.title, content: input.content, version: current.version + 1, updatedAt: new Date() }).where(eq(records.id, id)).returning();
    await knowledgeChange(db, actor, 'knowledge_record', { ...row!, values: input.values }, 'updated'); return serialiseKnowledge(row!);
  });
}
export async function setKnowledgeRecordDeleted(actor: KnowledgeActor, id: string, version: number, deleted: boolean) {
  return withWorkspaceTransaction(actor.workspaceId, async (db) => {
    const current = await loadKnowledgeRecord(actor.workspaceId, id, true); checkKnowledgeVersion(current, version); await loadKnowledgeDatabase(actor.workspaceId, current.databaseId, true);
    if (Boolean(current.deletedAt) === deleted) return serialiseKnowledge(current);
    const [row] = await db.update(records).set({ deletedAt: deleted ? new Date() : null, version: current.version + 1, updatedAt: new Date() }).where(eq(records.id, id)).returning();
    await knowledgeChange(db, actor, 'knowledge_record', row!, deleted ? 'deleted' : 'updated'); return serialiseKnowledge(row!);
  });
}
export async function duplicateKnowledgeRecord(actor: KnowledgeActor, id: string, version: number) {
  return withWorkspaceTransaction(actor.workspaceId, async (db) => {
    const current = await loadKnowledgeRecord(actor.workspaceId, id); checkKnowledgeVersion(current, version); await loadKnowledgeDatabase(actor.workspaceId, current.databaseId, true);
    const [row] = await db.insert(records).values({ id: newId(), workspaceId: actor.workspaceId, databaseId: current.databaseId, title: (current.title + ' (copy)').slice(0, 500), content: current.content }).returning();
    const [stored, links, resources] = await Promise.all([db.select().from(values).where(eq(values.recordId,id)), db.select().from(relations).where(eq(relations.recordId,id)), db.select().from(files).where(eq(files.recordId,id))]);
    if (stored.length) await db.insert(values).values(stored.map((v) => ({ ...v, recordId: row!.id })));
    if (links.length) await db.insert(relations).values(links.map((v) => ({ ...v, id: newId(), recordId: row!.id, createdAt: new Date() })));
    if (resources.length) await db.insert(files).values(resources.map((v) => ({ ...v, recordId: row!.id })));
    await knowledgeChange(db, actor, 'knowledge_record', { ...row!, copiedFrom: current.id }, 'created'); return serialiseKnowledge(row!);
  });
}
async function noteParent(actor: KnowledgeActor, note: { databaseId: string | null; recordId: string | null }) {
  if (note.databaseId) await loadKnowledgeDatabase(actor.workspaceId, note.databaseId, true);
  if (note.recordId) { const record = await loadKnowledgeRecord(actor.workspaceId, note.recordId); await loadKnowledgeDatabase(actor.workspaceId, record.databaseId, true); }
}
async function replaceNoteTags(db: Database, actor: KnowledgeActor, noteId: string, ids: string[]) {
  const unique = [...new Set(ids)]; const owned = unique.length ? await db.select({ id: tags.id }).from(tags).where(and(eq(tags.workspaceId, actor.workspaceId), inArray(tags.id, unique))) : [];
  if (owned.length !== unique.length) invalidKnowledge('Choose tags from your workspace.');
  await db.delete(noteTags).where(eq(noteTags.noteId, noteId)); if (unique.length) await db.insert(noteTags).values(unique.map((tagId) => ({ workspaceId: actor.workspaceId, noteId, tagId })));
}
export async function createKnowledgeNote(actor: KnowledgeActor, data: unknown) {
  const input = knowledgeNoteInput.parse(data);
  return withWorkspaceTransaction(actor.workspaceId, async (db) => {
    await noteParent(actor, input); const { tagIds, ...fields } = input;
    const [row] = await db.insert(notes).values({ ...fields, id: newId(), workspaceId: actor.workspaceId }).returning();
    await replaceNoteTags(db, actor, row!.id, tagIds); await knowledgeChange(db, actor, 'knowledge_note', { ...row!, tagIds }, 'created'); return serialiseKnowledge(row!);
  });
}
export async function updateKnowledgeNote(actor: KnowledgeActor, id: string, data: unknown) {
  const input = knowledgeNoteUpdate.parse(data);
  return withWorkspaceTransaction(actor.workspaceId, async (db) => {
    const current = await loadKnowledgeNote(actor.workspaceId, id); checkKnowledgeVersion(current, input.version); await noteParent(actor, current);
    await replaceNoteTags(db, actor, id, input.tagIds);
    const [row] = await db.update(notes).set({ title: input.title, content: input.content, version: current.version + 1, updatedAt: new Date() }).where(eq(notes.id,id)).returning();
    await knowledgeChange(db, actor, 'knowledge_note', { ...row!, tagIds: input.tagIds }, 'updated'); return serialiseKnowledge(row!);
  });
}
export async function setKnowledgeNoteDeleted(actor: KnowledgeActor, id: string, version: number, deleted: boolean) {
  return withWorkspaceTransaction(actor.workspaceId, async (db) => {
    const current = await loadKnowledgeNote(actor.workspaceId,id,true); checkKnowledgeVersion(current,version); if (!deleted) await noteParent(actor,current);
    if (Boolean(current.deletedAt) === deleted) return serialiseKnowledge(current);
    const [row] = await db.update(notes).set({ deletedAt: deleted ? new Date() : null, version: current.version+1, updatedAt: new Date() }).where(eq(notes.id,id)).returning();
    await knowledgeChange(db,actor,'knowledge_note',row!,deleted ? 'deleted':'updated'); return serialiseKnowledge(row!);
  });
}
