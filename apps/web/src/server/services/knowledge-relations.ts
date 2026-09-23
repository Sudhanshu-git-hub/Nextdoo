import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { knowledgeRelationInput, knowledgeFileInput, knowledgeTargetKind, uuid, notFound } from '@nextdoo/contracts';
import { knowledgeRelations as relations, knowledgeFiles as files, knowledgeRecords as records, knowledgeNotes as notes, attachments, type Database } from '@nextdoo/db';
import { getDb } from '../db';
import { newId } from '../ids';
import { withWorkspaceTransaction } from './transactions';
import { authorizeAttachmentOwner } from './attachments';
import { loadKnowledgeDatabase, loadKnowledgeRecord, loadKnowledgeNote, knowledgeProperties, checkKnowledgeVersion, knowledgeChange, invalidKnowledge, serialiseKnowledge, type KnowledgeActor } from './knowledge';

export type KnowledgeKind = z.infer<typeof knowledgeTargetKind>;
const targets = {
  record: { table: 'knowledge_records', title: 'title', active: 'deleted_at is null', column: 'targetRecordId', path: '/knowledge/records/' },
  database: { table: 'knowledge_databases', title: 'name', active: 'not archived', column: 'targetDatabaseId', path: '/knowledge/databases/' },
  note: { table: 'knowledge_notes', title: 'title', active: 'deleted_at is null', column: 'targetNoteId', path: '/knowledge/notes/' },
  task: { table: 'tasks', title: 'title', active: "status<>'DELETED'", column: 'taskId', path: null },
  goal: { table: 'goals', title: 'title', active: "status<>'ARCHIVED'", column: 'goalId', path: '/goals/' },
  milestone: { table: 'milestones', title: 'title', active: "status<>'ARCHIVED'", column: 'milestoneId', path: '/goals/' },
  tracker: { table: 'personal_trackers', title: 'name', active: "state<>'ARCHIVED'", column: 'trackerId', path: '/trackers/' },
  calendar: { table: 'calendar_events', title: 'title', active: 'true', column: 'calendarEventId', path: '/calendar' },
} as const;
const like = (term: string) => '%' + term.replace(/[\\%_]/g, '\\$&') + '%';
export async function knowledgeTarget(workspaceId: string, kind: KnowledgeKind, id: string, active = true) {
  knowledgeTargetKind.parse(kind); uuid.parse(id); const target = targets[kind];
  const rows = await getDb().execute<{ id: string; title: string; goal_id?: string; database_id?: string; unavailable: boolean }>(sql`select id,${sql.raw(target.title)} title,not (${sql.raw(target.active)}) unavailable ${kind === 'milestone' ? sql`,goal_id` : kind === 'record' ? sql`,database_id` : sql``} from ${sql.raw(target.table)} where id=${id} and workspace_id=${workspaceId} ${active ? sql`and (${sql.raw(target.active)})` : sql``}`);
  const row = rows[0]; if (!row) throw notFound('linked item', id);
  return { id, kind, label: row.unavailable ? 'Unavailable ' + kind : row.title ?? 'Calendar event', databaseId: row.database_id ?? null, unavailable: row.unavailable,
    href: row.unavailable || !target.path ? null : kind === 'milestone' ? '/goals/' + row.goal_id + '#milestone-' + id : kind === 'calendar' ? '/calendar' : target.path + id };
}
export async function searchKnowledgeTargets(workspaceId: string, data: unknown) {
  const input = z.object({ kind: knowledgeTargetKind, q: z.string().max(200).default(''), databaseId: uuid.optional(), offset: z.coerce.number().int().min(0).max(1000000).default(0) }).strict().parse(data);
  if (input.databaseId) await loadKnowledgeDatabase(workspaceId,input.databaseId);
  const target = targets[input.kind];
  const rows = await getDb().execute<{ id: string; title: string }>(sql`select id,${sql.raw(target.title)} title from ${sql.raw(target.table)} where workspace_id=${workspaceId} and (${sql.raw(target.active)}) and coalesce(${sql.raw(target.title)},'') ilike ${like(input.q)} ${input.databaseId && input.kind === 'record' ? sql`and database_id=${input.databaseId}` : sql``} order by ${sql.raw(target.title)},id limit 41 offset ${input.offset}`);
  return { data: rows.slice(0,40).map((r) => ({ id:r.id, label:r.title ?? 'Calendar event',kind:input.kind })), nextOffset: rows.length>40 ? input.offset+40 : null };
}
async function sourceForWrite(actor: KnowledgeActor, kind: 'record' | 'note', id: string, version: number) {
  const source = kind === 'record' ? await loadKnowledgeRecord(actor.workspaceId,id) : await loadKnowledgeNote(actor.workspaceId,id);
  checkKnowledgeVersion(source,version);
  if (source.databaseId) await loadKnowledgeDatabase(actor.workspaceId,source.databaseId,true);
  if ('recordId' in source && source.recordId) { const record=await loadKnowledgeRecord(actor.workspaceId,source.recordId); await loadKnowledgeDatabase(actor.workspaceId,record.databaseId,true); }
  return source;
}
async function touchSource(db: Database, actor: KnowledgeActor, kind: 'record' | 'note', source: { id: string; version: number }, change: Record<string, unknown>) {
  const table=kind==='record' ? records:notes;
  const [row]=await db.update(table).set({version:source.version+1,updatedAt:new Date()}).where(eq(table.id,source.id)).returning();
  await knowledgeChange(db,actor,'knowledge_'+kind,{...row!,referenceChange:change},'updated'); return serialiseKnowledge(row!);
}
export async function linkKnowledgeRelation(actor: KnowledgeActor, sourceKind: 'record' | 'note', sourceId: string, data: unknown) {
  const input=knowledgeRelationInput.parse(data);
  return withWorkspaceTransaction(actor.workspaceId,async (db)=>{
    const source=await sourceForWrite(actor,sourceKind,sourceId,input.version);
    if (sourceKind==='note' && input.propertyId) invalidKnowledge('Notes use general relations rather than database properties.');
    if (input.linked) {
      const target=await knowledgeTarget(actor.workspaceId,input.kind,input.targetId);
      if (sourceKind===input.kind && sourceId===input.targetId) invalidKnowledge('Choose a different item to link.');
      if (input.propertyId) {
        const property=(await knowledgeProperties(actor.workspaceId,source.databaseId!)).find(p=>p.id===input.propertyId);
        if (!property || property.type!=='RELATION' || property.config.relationKind!==input.kind || (property.config.relationDatabaseId && target.databaseId!==property.config.relationDatabaseId)) invalidKnowledge('Choose an item matching this relation property.');
      }
    }
    const scope=and(eq(relations.workspaceId,actor.workspaceId),sourceKind==='record'?eq(relations.recordId,sourceId):eq(relations.noteId,sourceId),input.propertyId?eq(relations.propertyId,input.propertyId):isNull(relations.propertyId),eq(relations.kind,input.kind),eq(relations.targetId,input.targetId));
    const existing=await db.select({id:relations.id}).from(relations).where(scope);
    if (Boolean(existing.length)===input.linked) return serialiseKnowledge(source);
    if (input.linked) {
      const [count] = await db.select({ count: sql<number>`count(*)::int` }).from(relations).where(sourceKind==='record'?eq(relations.recordId,sourceId):eq(relations.noteId,sourceId));
      if (count!.count >= 200) invalidKnowledge('An item supports up to 200 relations. Remove a link before adding another.');
    }
    if (input.linked) await db.insert(relations).values({id:newId(),workspaceId:actor.workspaceId,recordId:sourceKind==='record'?sourceId:null,noteId:sourceKind==='note'?sourceId:null,databaseId:sourceKind==='record'?source.databaseId:null,propertyId:input.propertyId,kind:input.kind,targetId:input.targetId,[targets[input.kind].column]:input.targetId});
    else await db.delete(relations).where(scope);
    return touchSource(db,actor,sourceKind,source,input);
  });
}
export async function knowledgeRelationDetails(workspaceId: string, kind: 'record' | 'note', id: string) {
  const rows=await getDb().select().from(relations).where(and(eq(relations.workspaceId,workspaceId),kind==='record'?eq(relations.recordId,id):eq(relations.noteId,id))).orderBy(relations.id).limit(201);
  return { data: await Promise.all(rows.slice(0,200).map(async r=>({...r,target:await knowledgeTarget(workspaceId,r.kind,r.targetId,false)}))), truncated:rows.length>200 };
}
export async function knowledgeBacklinks(workspaceId: string, kind: KnowledgeKind, id: string, offset=0) {
  await knowledgeTarget(workspaceId,kind,id,false); z.number().int().min(0).max(1000000).parse(offset);
  const rows=await getDb().execute<{ id:string; record_id:string|null; note_id:string|null; title:string }>(sql`select l.id,l.record_id,l.note_id,coalesce(r.title,n.title) title from knowledge_relations l left join knowledge_records r on r.id=l.record_id left join knowledge_notes n on n.id=l.note_id where l.workspace_id=${workspaceId} and l.kind=${kind} and l.target_id=${id} and (r.deleted_at is null and n.deleted_at is null) order by l.id limit 41 offset ${offset}`);
  return { data:rows.slice(0,40).map(r=>({id:r.id,title:r.title,href:r.record_id?'/knowledge/records/'+r.record_id:'/knowledge/notes/'+r.note_id})),nextOffset:rows.length>40?offset+40:null };
}
export async function linkKnowledgeFile(actor: KnowledgeActor, recordId: string, data: unknown) {
  const input=knowledgeFileInput.parse(data);
  return withWorkspaceTransaction(actor.workspaceId,async db=>{
    const record=await sourceForWrite(actor,'record',recordId,input.version);
    const property=(await knowledgeProperties(actor.workspaceId,record.databaseId!)).find(p=>p.id===input.propertyId);
    if (!property || property.type!=='FILE') invalidKnowledge('Choose a file property from this database.');
    if (input.linked) {
      const [file]=await db.select().from(attachments).where(and(eq(attachments.id,input.attachmentId),eq(attachments.workspaceId,actor.workspaceId),eq(attachments.uploaderId,actor.userId),isNull(attachments.deletedAt)));
      if (!file || file.scanStatus!=='CLEAN') invalidKnowledge('Choose an owned file that has passed its security scan.');
      await authorizeAttachmentOwner(actor, file.taskId ? {taskId:file.taskId} : file.recordId ? {recordId:file.recordId} : file.noteId ? {noteId:file.noteId} : {goalId:file.goalId!});
    }
    const scope=and(eq(files.recordId,recordId),eq(files.propertyId,input.propertyId),eq(files.attachmentId,input.attachmentId));
    if (input.linked) {
      const existing=await db.select().from(files).where(scope).limit(1);
      if (existing.length) return serialiseKnowledge(record);
      const [count]=await db.select({count:sql<number>`count(*)::int`}).from(files).where(eq(files.recordId,recordId));
      if(count!.count>=200) invalidKnowledge('A record supports up to 200 file references.');
    }
    const changed=input.linked ? await db.insert(files).values({recordId,propertyId:input.propertyId,attachmentId:input.attachmentId,workspaceId:actor.workspaceId,databaseId:record.databaseId!}).onConflictDoNothing().returning():await db.delete(files).where(scope).returning();
    return changed.length ? touchSource(db,actor,'record',record,input):serialiseKnowledge(record);
  });
}
