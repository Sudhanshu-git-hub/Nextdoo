import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { knowledgeQuery, validKnowledgeValue, type KnowledgePropertyInput, type KnowledgeValue } from '@nextdoo/contracts';
import { knowledgeCsv } from '@nextdoo/core';
import { knowledgeDatabases as databases, knowledgeProperties as properties, knowledgeRecords as records, knowledgeValues as values, knowledgeNotes as notes, knowledgeNoteTags as noteTags, knowledgeFiles as files, attachments, tags } from '@nextdoo/db';
import { getDb, withTransaction } from '../db';
import { loadKnowledgeDatabase, loadKnowledgeRecord, loadKnowledgeNote, knowledgeProperties, knowledgeStoredValue, invalidKnowledge, serialiseKnowledge } from './knowledge';
import { knowledgeRelationDetails, knowledgeBacklinks } from './knowledge-relations';

/** Search only clean, live resources whose owning item is still available. */
export async function knowledgeResources(workspaceId:string,userId:string,data:unknown) {
  const query=knowledgeQuery.parse(data);
  const rows=await getDb().execute<{id:string;fileName:string}>(sql`select a.id,a.file_name as "fileName" from attachments a
    left join tasks t on t.id=a.task_id left join goals g on g.id=a.goal_id
    left join knowledge_records r on r.id=a.record_id left join knowledge_notes n on n.id=a.note_id
    left join knowledge_records nr on nr.id=n.record_id
    where a.workspace_id=${workspaceId} and a.uploader_id=${userId} and a.deleted_at is null and a.scan_status='CLEAN'
    and (a.task_id is null or t.status<>'DELETED') and (a.goal_id is null or g.id is not null)
    and (a.record_id is null or r.deleted_at is null) and (a.note_id is null or (n.deleted_at is null and nr.deleted_at is null))
    and a.file_name ilike ${like(query.q)} order by a.file_name,a.id limit ${query.limit+1} offset ${query.offset}`);
  return {data:rows.slice(0,query.limit),nextOffset:rows.length>query.limit?query.offset+query.limit:null};
}

const like = (value: string) => '%' + value.replace(/[\\%_]/g,'\\$&') + '%';
export async function listKnowledgeDatabases(workspaceId: string, data: unknown) {
  const query=knowledgeQuery.parse(data);
  const where=and(eq(databases.workspaceId,workspaceId),query.includeDeleted?undefined:eq(databases.archived,false),query.favorite?eq(databases.favorite,true):undefined,sql`${databases.name} ilike ${like(query.q)}`);
  const rows=await getDb().select().from(databases).where(where).orderBy(desc(databases.updatedAt),asc(databases.id)).limit(query.limit+1).offset(query.offset);
  const [counts]=await getDb().select({count:sql<number>`count(*)::int`}).from(databases).where(where);
  return serialiseKnowledge({data:rows.slice(0,query.limit),nextOffset:rows.length>query.limit?query.offset+query.limit:null,total:counts!.count});
}
export async function listKnowledgeNotes(workspaceId: string, data: unknown, parent?: {recordId?: string;databaseId?:string}) {
  const query=knowledgeQuery.parse(data);
  if (parent?.recordId) await loadKnowledgeRecord(workspaceId,parent.recordId,true);
  if (parent?.databaseId) await loadKnowledgeDatabase(workspaceId,parent.databaseId);
  const rows=await getDb().select().from(notes).where(and(eq(notes.workspaceId,workspaceId),query.includeDeleted?undefined:isNull(notes.deletedAt),parent?.recordId?eq(notes.recordId,parent.recordId):undefined,parent?.databaseId?eq(notes.databaseId,parent.databaseId):undefined,sql`(${notes.title} ilike ${like(query.q)} or ${notes.content} ilike ${like(query.q)})`)).orderBy(desc(notes.updatedAt),asc(notes.id)).limit(query.limit+1).offset(query.offset);
  return serialiseKnowledge({data:rows.slice(0,query.limit),nextOffset:rows.length>query.limit?query.offset+query.limit:null});
}
function scalar(property: typeof properties.$inferSelect): SQL {
  if (property.type==='TITLE') return sql`${records.title}`;
  const column=property.type==='NUMBER'?'number_value':property.type==='DATE'?'date_value':property.type==='CHECKBOX'?'boolean_value':'text_value';
  return sql`(select v.${sql.raw(column)} from knowledge_values v where v.record_id=${records.id} and v.property_id=${property.id})`;
}
function filterSql(property: typeof properties.$inferSelect, filter: ReturnType<typeof knowledgeQuery.parse>['filters'][number]): SQL {
  const op=filter.operator;
  const reference=property.type==='RELATION'?'knowledge_relations':property.type==='FILE'?'knowledge_files':null;
  const exists=reference?sql`exists(select 1 from ${sql.raw(reference)} v where v.record_id=${records.id} and v.property_id=${property.id})`:property.type==='TITLE'?sql`true`:sql`exists(select 1 from knowledge_values v where v.record_id=${records.id} and v.property_id=${property.id})`;
  if (op==='exists') return exists; if (op==='missing') return sql`not (${exists})`;
  if (reference) invalidKnowledge('File and relation filters support exists or missing.');
  const value=filter.value;
  if (value===undefined || value===null) invalidKnowledge('This filter needs a value.');
  if (property.type==='MULTI_SELECT') {
    if (op==='contains' && typeof value==='string' && property.config.options.includes(value)) return sql`exists(select 1 from knowledge_values v where v.record_id=${records.id} and v.property_id=${property.id} and ${value}=any(v.options_value))`;
    if (op==='eq' && validKnowledgeValue(property,value) && Array.isArray(value)) return sql`exists(select 1 from knowledge_values v where v.record_id=${records.id} and v.property_id=${property.id} and v.options_value @> ${sql`ARRAY[${sql.join(value.map(v=>sql`${v}`),sql`, `)}]::text[]`} and cardinality(v.options_value)=${value.length})`;
    invalidKnowledge('Multi-select filters support a chosen option or exact set.');
  }
  if (op==='contains') {
    if (!['TITLE','TEXT','RICH_TEXT','URL','EMAIL','PHONE','SELECT'].includes(property.type) || typeof value!=='string') invalidKnowledge('Contains needs a text property and text value.');
    return sql`${scalar(property)} ilike ${like(value)}`;
  }
  if (!validKnowledgeValue(property,value)) invalidKnowledge('Filter value does not match its property type.');
  if (op!=='eq' && !['NUMBER','DATE'].includes(property.type)) invalidKnowledge('Ordered filters need a number or date property.');
  const operators={eq:'=',gt:'>',gte:'>=',lt:'<',lte:'<='} as const;
  return sql`${scalar(property)} ${sql.raw(operators[op])} ${value}`;
}
export async function knowledgeRecordPage(workspaceId: string, databaseId: string, data: unknown) {
  const query=knowledgeQuery.parse(data);
  return withTransaction(async db=>{
    const database=await loadKnowledgeDatabase(workspaceId,databaseId), definitions=await knowledgeProperties(workspaceId,databaseId);
    const filters=query.filters.map(f=>{const p=definitions.find(p=>p.id===f.propertyId);if(!p)invalidKnowledge('Unknown filter property.');return filterSql(p,f);});
    let sort: SQL=query.sort==='title'?sql`${records.title}`:query.sort==='createdAt'?sql`${records.createdAt}`:sql`${records.updatedAt}`;
    if (!['title','createdAt','updatedAt'].includes(query.sort)) { const p=definitions.find(p=>p.id===query.sort);if(!p || ['FILE','RELATION','MULTI_SELECT','RICH_TEXT'].includes(p.type))invalidKnowledge('Choose a sortable property.');sort=scalar(p); }
    const scope=and(eq(records.workspaceId,workspaceId),eq(records.databaseId,databaseId),query.includeDeleted?undefined:isNull(records.deletedAt),...filters,
      query.q?sql`(${records.title} ilike ${like(query.q)} or ${records.content} ilike ${like(query.q)} or exists(select 1 from knowledge_values v where v.record_id=${records.id} and v.text_value ilike ${like(query.q)}))`:undefined);
    const rows=await db.select().from(records).where(scope).orderBy(sql`${sort} ${sql.raw(query.direction)} nulls last`,asc(records.id)).limit(query.limit+1).offset(query.offset);
    const [counts]=await db.select({count:sql<number>`count(*)::int`}).from(records).where(scope);
    const page=rows.slice(0,query.limit), ids=page.map(r=>r.id);
    const stored=ids.length?await db.select().from(values).where(and(eq(values.workspaceId,workspaceId),inArray(values.recordId,ids))):[];
    const referenceCounts=ids.length?await db.execute<{record_id:string;property_id:string;count:number}>(sql`select record_id,property_id,count(*)::int count from (select record_id,property_id from knowledge_relations where workspace_id=${workspaceId} and record_id in (${sql.join(ids.map(id=>sql`${id}::uuid`),sql`,`)}) and property_id is not null union all select record_id,property_id from knowledge_files where workspace_id=${workspaceId} and record_id in (${sql.join(ids.map(id=>sql`${id}::uuid`),sql`,`)})) refs group by record_id,property_id`):[];
    return serialiseKnowledge({database,properties:definitions,data:page.map(r=>({...r,values:Object.fromEntries(stored.filter(v=>v.recordId===r.id).map(v=>[v.propertyId,knowledgeStoredValue(v)])),referenceCounts:Object.fromEntries(referenceCounts.filter(v=>v.record_id===r.id).map(v=>[v.property_id,v.count]))})),total:counts!.count,nextOffset:rows.length>query.limit?query.offset+query.limit:null});
  },{isolationLevel:'repeatable read'});
}
export async function knowledgeRecordDetail(workspaceId: string,id: string) {
  return withTransaction(async db=>{
    const record=await loadKnowledgeRecord(workspaceId,id,true), database=await loadKnowledgeDatabase(workspaceId,record.databaseId);
    const [definitions,stored,links,backlinks,notePage,resources]=await Promise.all([
      knowledgeProperties(workspaceId,record.databaseId),db.select().from(values).where(eq(values.recordId,id)),knowledgeRelationDetails(workspaceId,'record',id),knowledgeBacklinks(workspaceId,'record',id),listKnowledgeNotes(workspaceId,{}, {recordId:id}),
      db.select({propertyId:files.propertyId,id:attachments.id,fileName:attachments.fileName,scanStatus:attachments.scanStatus,deletedAt:attachments.deletedAt}).from(files).innerJoin(attachments,and(eq(attachments.id,files.attachmentId),eq(attachments.workspaceId,workspaceId))).where(and(eq(files.recordId,id),eq(files.workspaceId,workspaceId))),
    ]);
    return serialiseKnowledge({record,database,properties:definitions,values:Object.fromEntries(stored.map(v=>[v.propertyId,knowledgeStoredValue(v)])),relations:links,backlinks,notes:notePage,files:resources.map(f=>f.deletedAt?{...f,fileName:'Deleted file'}:f)});
  },{isolationLevel:'repeatable read'});
}
export async function knowledgeNoteDetail(workspaceId: string,id: string) {
  return withTransaction(async db=>{
    const note=await loadKnowledgeNote(workspaceId,id,true);
    const tagRows=await db.select({id:tags.id,name:tags.name}).from(noteTags).innerJoin(tags,eq(tags.id,noteTags.tagId)).where(and(eq(noteTags.noteId,id),eq(noteTags.workspaceId,workspaceId)));
    return serialiseKnowledge({note,tags:tagRows,relations:await knowledgeRelationDetails(workspaceId,'note',id),backlinks:await knowledgeBacklinks(workspaceId,'note',id)});
  },{isolationLevel:'repeatable read'});
}
/** Bounded page export; account export remains the complete structured boundary. */
export async function exportKnowledgePage(workspaceId: string,databaseId: string,data: unknown,format:'csv'|'json') {
  const page=await knowledgeRecordPage(workspaceId,databaseId,data);
  const rows=page.data.map(r=>page.properties.map(p=>p.type==='TITLE'?r.title:['FILE','RELATION'].includes(p.type)?String(r.referenceCounts[p.id]??0)+' references':r.values[p.id]));
  return { content:format==='csv'?knowledgeCsv(page.properties.map(p=>p.name),rows):JSON.stringify({schemaVersion:1,...page},null,2),nextOffset:page.nextOffset,total:page.total };
}
export type KnowledgeProperty = KnowledgePropertyInput & {id:string};
export type KnowledgeValues = Record<string,KnowledgeValue>;
