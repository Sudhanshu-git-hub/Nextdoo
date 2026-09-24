import { createHash } from 'node:crypto';
import { and,eq,isNull,sql } from 'drizzle-orm';
import { AppError,notFound,versionConflict,uuid,calendarSourceInput,calendarSourceUpdate,calendarEventInput,calendarEventUpdate,calendarImportInput,calendarCenterRange,type CalendarSource,type CenterEvent } from '@nextdoo/contracts';
import { calendarSources as sources,calendarNativeEvents as events,calendarConnections,calendarEvents,syncChanges,outbox,auditLogs,type Database } from '@nextdoo/db';
import { localDateKey,localParts } from '@nextdoo/core';
import { parseCalendarIcs,calendarIcsExport } from '@nextdoo/calendar';
import { getDb } from '../db';
import { newId } from '../ids';
import { withWorkspaceTransaction } from './transactions';
import { loadWorkspaceSettings } from './workspaces';
import type { GoalActor } from './goals';

const internal=[['task','Tasks','#315ca8'],['goal','Goal deadlines','#9b4329'],['milestone','Milestone deadlines','#946200'],['tracker','Tracker activity','#27704e'],['record','Knowledge dates','#765096']] as const;
const invalid=(message:string):never=>{throw new AppError('VALIDATION_FAILED',message);};
const owned=(actor:GoalActor)=>and(eq(sources.workspaceId,actor.workspaceId),eq(sources.userId,actor.userId));
const serialise=<T>(value:T):T=>JSON.parse(JSON.stringify(value));
function checkVersion(row:{id:string;version:number},version:number){if(row.version!==version)throw versionConflict('calendar item',row.id);}
async function change(db:Database,actor:GoalActor,entity:string,row:{id:string;version:number}&Record<string,unknown>,action:'created'|'updated'|'deleted'){
  await db.insert(syncChanges).values({workspaceId:actor.workspaceId,entityType:entity,entityId:row.id,operation:action==='created'?'create':action==='deleted'?'delete':'update',version:row.version,payload:action==='deleted'?{id:row.id}:serialise(row)});
  await db.insert(outbox).values({id:newId(),workspaceId:actor.workspaceId,actorId:actor.userId,entityType:entity,entityId:row.id,eventType:entity+'.'+action,schemaVersion:1,payload:{version:row.version}});
  await db.insert(auditLogs).values({id:newId(),workspaceId:actor.workspaceId,actorId:actor.userId,action:entity+'.'+action,targetType:entity,targetId:row.id,requestId:actor.requestId,metadata:{version:row.version}});
}

/** Virtual defaults avoid writes on GET; settings overlay existing domain/provider identities. */
export async function listCalendarSources(actor:GoalActor):Promise<CalendarSource[]> {
  const db=getDb(),workspace=await loadWorkspaceSettings(actor.workspaceId,actor.workspaceId);
  const saved=await db.select().from(sources).where(owned(actor));
  const result:CalendarSource[]=internal.map(([key,name,color])=>({id:'internal:'+key,name,color,kind:'INTERNAL',visible:true,archived:false,timeZone:workspace.timeZone,version:0,writable:false,status:'AVAILABLE',detail:key==='task'?'Edit and reschedule the original Task.':'Dates from the original '+name.toLowerCase()+'.'}));
  const connections=await db.select().from(calendarConnections).where(and(eq(calendarConnections.workspaceId,actor.workspaceId),eq(calendarConnections.userId,actor.userId)));
  for(const c of connections){
    const ids=await db.selectDistinct({id:calendarEvents.calendarId}).from(calendarEvents).where(and(eq(calendarEvents.connectionId,c.id),eq(calendarEvents.workspaceId,actor.workspaceId)));
    for(const id of new Set(['primary',...ids.map(r=>r.id??'primary')]))result.push({id:`google:${c.id}:${id}`,name:`Google · ${id==='primary'?'Primary':id}`.slice(0,120),kind:'GOOGLE',color:'#26744b',visible:true,archived:false,timeZone:workspace.timeZone,version:0,writable:false,status:c.status,connectionId:c.id,detail:`${c.externalAccountId??'Google account'} · ${id} · ${c.mode==='READ_WRITE'?'Task export enabled':'Read-only'}${c.pauseReason?' · '+c.pauseReason:''}${c.lastSyncedAt?' · synced '+c.lastSyncedAt.toISOString():' · not synced yet'}`});
  }
  for(const row of saved){
    const index=result.findIndex(s=>s.id===row.sourceKey);
    if(index>=0)result[index]={...result[index]!,name:row.name,color:row.color,visible:row.visible,version:row.version};
    else if(row.kind==='NATIVE'||row.kind==='ICS')result.push({id:row.id,name:row.name,color:row.color,visible:row.visible,archived:row.archived,timeZone:row.timeZone,version:row.version,kind:row.kind,writable:row.kind==='NATIVE'&&!row.archived,status:row.archived?'ARCHIVED':row.kind==='ICS'?'IMPORTED':'AVAILABLE',detail:row.kind==='ICS'?`Read-only snapshot · ${row.importFrom} to ${row.importThrough} (exclusive) · imported ${row.lastImportedAt?.toISOString()}`:'Native one-off events · '+row.timeZone});
  }
  return result;
}
async function sourceRow(actor:GoalActor,id:string,mutable=false){
  uuid.parse(id);const [row]=await getDb().select().from(sources).where(and(owned(actor),eq(sources.id,id)));
  if(!row)throw notFound('calendar',id);if(mutable&&(row.archived||row.kind!=='NATIVE'))invalid('Choose an active native calendar for editing events.');return row;
}
export async function createCalendarSource(actor:GoalActor,data:unknown){
  const input=calendarSourceInput.parse(data);
  return withWorkspaceTransaction(actor.workspaceId,async db=>{
    const [count]=await db.select({n:sql<number>`count(*)::int`}).from(sources).where(owned(actor));if(count!.n>=100)invalid('This workspace supports up to 100 calendar configurations.');
    const id=newId(),[row]=await db.insert(sources).values({...input,id,sourceKey:id,workspaceId:actor.workspaceId,userId:actor.userId,kind:'NATIVE'}).returning();
    await change(db,actor,'calendar_source',row!,'created');return serialise(row!);
  });
}
export async function updateCalendarSource(actor:GoalActor,id:string,data:unknown){
  const input=calendarSourceUpdate.parse(data);
  return withWorkspaceTransaction(actor.workspaceId,async db=>{
    const source=(await listCalendarSources(actor)).find(s=>s.id===id);if(!source)throw notFound('calendar',id);checkVersion(source,input.version);
    if(input.archived!==undefined&&['INTERNAL','GOOGLE'].includes(source.kind))invalid('Hide this layer, or manage its provider connection.');
    const [current]=await db.select().from(sources).where(and(owned(actor),eq(sources.sourceKey,id)));
    if(!current){const [count]=await db.select({n:sql<number>`count(*)::int`}).from(sources).where(owned(actor));if(count!.n>=100)invalid('Calendar limit reached.');}
    const values={name:input.name??source.name,color:input.color??source.color,visible:input.visible??source.visible,archived:input.archived??source.archived,version:source.version+1,updatedAt:new Date()};
    const [row]=current?await db.update(sources).set(values).where(eq(sources.id,current.id)).returning():await db.insert(sources).values({...values,id:newId(),workspaceId:actor.workspaceId,userId:actor.userId,sourceKey:id,kind:source.kind,timeZone:source.timeZone}).returning();
    await change(db,actor,'calendar_source',row!,current?'updated':'created');return (await listCalendarSources(actor)).find(s=>s.id===id)!;
  });
}
function eventValues(input:ReturnType<typeof calendarEventInput.parse>){
  const startsAt=new Date(input.startsAt),endsAt=new Date(input.endsAt);
  if(input.isAllDay){for(const d of [startsAt,endsAt]){const p=localParts(d,input.timeZone);if(p.hour||p.minute||d.getUTCSeconds()||d.getUTCMilliseconds())invalid('All-day events must start and end at midnight in the event time zone.');}}
  return {...input,startsAt,endsAt,startDay:input.isAllDay?localDateKey(startsAt,input.timeZone):null,endDay:input.isAllDay?localDateKey(endsAt,input.timeZone):null};
}
export async function loadNativeEvent(actor:GoalActor,id:string){
  uuid.parse(id);const [row]=await getDb().select({event:events}).from(events).innerJoin(sources,and(eq(sources.id,events.sourceId),eq(sources.workspaceId,events.workspaceId))).where(and(owned(actor),eq(events.id,id),isNull(events.deletedAt)));
  if(!row)throw notFound('calendar event',id);return row.event;
}
export async function saveNativeEvent(actor:GoalActor,id:string|null,data:unknown){
  const command=id?calendarEventUpdate.parse(data):{event:calendarEventInput.parse(data),version:0};
  return withWorkspaceTransaction(actor.workspaceId,async db=>{
    await sourceRow(actor,command.event.sourceId,true);
    const current=id?await loadNativeEvent(actor,id):null;
    if(current){await sourceRow(actor,current.sourceId,true);checkVersion(current,command.version);}
    else {const [count]=await db.select({n:sql<number>`count(*)::int`}).from(events).where(eq(events.workspaceId,actor.workspaceId));if(count!.n>=10000)invalid('This workspace supports up to 10,000 calendar events.');}
    const values=eventValues(command.event);
    const [row]=current?await db.update(events).set({...values,version:current.version+1,updatedAt:new Date()}).where(eq(events.id,current.id)).returning():await db.insert(events).values({...values,id:newId(),workspaceId:actor.workspaceId}).returning();
    await change(db,actor,'calendar_native_event',row!,current?'updated':'created');return serialise(row!);
  });
}
export async function deleteNativeEvent(actor:GoalActor,id:string,version:number){
  return withWorkspaceTransaction(actor.workspaceId,async db=>{const current=await loadNativeEvent(actor,id);await sourceRow(actor,current.sourceId,true);checkVersion(current,version);
    const [row]=await db.update(events).set({deletedAt:new Date(),version:current.version+1,updatedAt:new Date()}).where(eq(events.id,id)).returning();await change(db,actor,'calendar_native_event',row!,'deleted');return {ok:true};});
}

/** Shared source/visibility/date projection; aggregate consumers never expose provider payloads. */
export async function calendarCenterProjection(actor:GoalActor,data:unknown,includeHidden=false){
  const q=calendarCenterRange.parse(data),workspace=await loadWorkspaceSettings(actor.workspaceId,actor.workspaceId);
  const from=localDateKey(new Date(q.start),workspace.timeZone),through=localDateKey(new Date(q.end),workspace.timeZone);
  return sql`select * from (
    select e.id,e.source_id::text "sourceId",e.title,e.description,e.location,e.starts_at "startsAt",e.ends_at "endsAt",e.time_zone "timeZone",e.is_all_day "isAllDay",e.start_day::text "startDay",e.end_day::text "endDay",e.version,s.kind,null::uuid "taskId"
    from calendar_native_events e join calendar_sources s on s.id=e.source_id and s.workspace_id=e.workspace_id
    where s.workspace_id=${actor.workspaceId} and s.user_id=${actor.userId} and not s.archived and (${includeHidden} or s.visible) and e.deleted_at is null
    and ((not e.is_all_day and e.starts_at<=${q.end}::timestamptz and e.ends_at>${q.start}::timestamptz) or (e.is_all_day and e.start_day<=${through}::date and e.end_day>${from}::date))
    union all select e.id,'google:'||c.id::text||':'||coalesce(e.calendar_id,'primary'),coalesce(e.title,'Calendar event'),'','',e.starts_at,e.ends_at,coalesce(e.time_zone,${workspace.timeZone}),e.is_all_day,case when e.is_all_day then to_char(e.starts_at at time zone 'UTC','YYYY-MM-DD') end,case when e.is_all_day then to_char(e.ends_at at time zone 'UTC','YYYY-MM-DD') end,0,'GOOGLE',m.task_id
    from calendar_events e join calendar_connections c on c.id=e.connection_id left join calendar_mappings m on m.connection_id=e.connection_id and m.external_id=e.external_id left join calendar_sources s on s.user_id=c.user_id and s.workspace_id=e.workspace_id and s.source_key='google:'||c.id::text||':'||coalesce(e.calendar_id,'primary')
    where e.workspace_id=${actor.workspaceId} and c.workspace_id=${actor.workspaceId} and c.user_id=${actor.userId} and c.status='ACTIVE' and (${includeHidden} or coalesce(s.visible,true))
    and ((not e.is_all_day and e.starts_at<=${q.end}::timestamptz and e.ends_at>${q.start}::timestamptz) or (e.is_all_day and (e.starts_at at time zone 'UTC')::date<=${through}::date and (e.ends_at at time zone 'UTC')::date>${from}::date))
  ) items`;
}
export async function listCenterEvents(actor:GoalActor,data:unknown,includeHidden=false){
  const q=calendarCenterRange.parse(data),projection=await calendarCenterProjection(actor,q,includeHidden);
  const rows=await getDb().execute<CenterEvent&Record<string,unknown>>(sql`${projection} order by "startsAt",id limit ${q.limit+1} offset ${q.offset}`);
  return {data:serialise(rows.slice(0,q.limit)),nextOffset:rows.length>q.limit?q.offset+q.limit:null};
}

export async function importCalendar(actor:GoalActor,data:unknown){
  const input=calendarImportInput.parse(data);let parsed:ReturnType<typeof parseCalendarIcs>;
  try{parsed=parseCalendarIcs(input.content,input.timeZone,input.from,input.through);}catch(e){invalid(e instanceof Error?e.message:'Invalid ICS file.');}
  const hash=createHash('sha256').update(input.content+'\0'+input.timeZone+'\0'+input.from+'\0'+input.through).digest('hex');
  return withWorkspaceTransaction(actor.workspaceId,async db=>{
    const current=input.sourceId?await sourceRow(actor,input.sourceId):null;
    if(current){if(current.kind!=='ICS'||current.archived)invalid('Choose an active imported calendar.');checkVersion(current,input.version!);}
    else {const [duplicate]=await db.select().from(sources).where(and(owned(actor),eq(sources.kind,'ICS'),eq(sources.importHash,hash),eq(sources.archived,false)));if(duplicate)return {source:serialise(duplicate),count:parsed.length,unchanged:true};}
    if(current?.importHash===hash)return {source:serialise(current),count:parsed.length,unchanged:true};
    const [count]=await db.select({n:sql<number>`count(*)::int`}).from(sources).where(owned(actor));if(!current&&count!.n>=100)invalid('Calendar limit reached.');
    const values={name:input.name,color:input.color,timeZone:input.timeZone,importHash:hash,importFrom:input.from,importThrough:input.through,lastImportedAt:new Date()};
    const id=current?.id??newId(),[source]=current?await db.update(sources).set({...values,version:current.version+1,updatedAt:new Date()}).where(eq(sources.id,id)).returning():await db.insert(sources).values({...values,id,sourceKey:id,workspaceId:actor.workspaceId,userId:actor.userId,kind:'ICS'}).returning();
    const existing=await db.select().from(events).where(eq(events.sourceId,id));
    const [eventCount]=await db.select({n:sql<number>`count(*)::int`}).from(events).where(eq(events.workspaceId,actor.workspaceId));
    const knownUids=new Set(existing.map(e=>e.importUid));
    if(eventCount!.n+parsed.filter(e=>!knownUids.has(e.uid)).length>10000)invalid('This workspace supports up to 10,000 calendar events.');
    for(const old of existing)if(!parsed.some(e=>e.uid===old.importUid)&&!old.deletedAt){const [deleted]=await db.update(events).set({deletedAt:new Date(),version:old.version+1,updatedAt:new Date()}).where(eq(events.id,old.id)).returning();await change(db,actor,'calendar_native_event',deleted!,'deleted');}
    for(const item of parsed){const old=existing.find(e=>e.importUid===item.uid);const {uid,...event}=item;const values={...event,startsAt:new Date(event.startsAt),endsAt:new Date(event.endsAt),deletedAt:null};
      const [row]=old?await db.update(events).set({...values,version:old.version+1,updatedAt:new Date()}).where(eq(events.id,old.id)).returning():await db.insert(events).values({...values,id:newId(),workspaceId:actor.workspaceId,sourceId:id,importUid:uid}).returning();await change(db,actor,'calendar_native_event',row!,old?'updated':'created');}
    await change(db,actor,'calendar_source',source!,current?'updated':'created');return {source:serialise(source!),count:parsed.length,unchanged:false};
  });
}
export async function exportCalendar(actor:GoalActor,id:string){
  const source=await sourceRow(actor,id);if(!['NATIVE','ICS'].includes(source.kind))invalid('Download is supported for native and imported calendars.');
  const rows=await getDb().select().from(events).where(and(eq(events.sourceId,id),isNull(events.deletedAt))).limit(2001);if(rows.length>2000)invalid('This calendar exceeds the 2000-event download limit.');
  return calendarIcsExport(source.name,rows.map(e=>({...e,uid:e.importUid??e.id+'@nextdoo',startsAt:e.startsAt.toISOString(),endsAt:e.endsAt.toISOString()})));
}
