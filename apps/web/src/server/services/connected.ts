import { sql } from 'drizzle-orm';
import { connectedSearchQuery, connectedCalendarQuery, uuid, type ConnectedItem, type ConnectedDate } from '@nextdoo/contracts';
import { localDayBounds, localDateKey, localParts, zonedTimeToUtc } from '@nextdoo/core';
import { getDb, withTransaction } from '../db';
import { loadTask } from './tasks';
import { loadWorkspaceSettings } from './workspaces';
import { listCenterEvents } from './calendar-center';

const like=(value:string)=>'%'+value.replace(/[\\%_]/g,'\\$&')+'%';
const page=<T>(rows:T[],limit:number,offset:number)=>({data:rows.slice(0,limit),nextOffset:rows.length>limit?offset+limit:null});

/** A read projection over existing owned entities, not another search index. */
export async function searchConnected(workspaceId:string,data:unknown) {
  const input=connectedSearchQuery.parse(data),term=like(input.q);
  const rows=await getDb().execute<ConnectedItem>(sql`select id,type,title,href,detail,state from (
    select id,'task' type,title,'/tasks/'||id::text href,'Task' detail,status::text state,coalesce(description,'') body from tasks where workspace_id=${workspaceId} and status in ('ACTIVE','COMPLETED')
    union all select id,'goal',title,'/goals/'||id::text,'Goal',status::text,coalesce(description,'') from goals where workspace_id=${workspaceId} and status<>'ARCHIVED'
    union all select m.id,'milestone',m.title,'/goals/'||m.goal_id::text||'#milestone-'||m.id::text,'Milestone · '||g.title,m.status::text,coalesce(m.description,'') from milestones m join goals g on g.id=m.goal_id and g.workspace_id=m.workspace_id where m.workspace_id=${workspaceId} and m.status<>'ARCHIVED' and g.status<>'ARCHIVED'
    union all select id,'tracker',name,'/trackers/'||id::text,'Tracker',state,coalesce(description,'') from personal_trackers where workspace_id=${workspaceId} and state<>'ARCHIVED'
    union all select id,'database',name,'/knowledge/databases/'||id::text,'Database','ACTIVE',coalesce(description,'') from knowledge_databases where workspace_id=${workspaceId} and not archived
    union all select r.id,'record',r.title,'/knowledge/records/'||r.id::text,'Record · '||d.name,'ACTIVE',r.content from knowledge_records r join knowledge_databases d on d.id=r.database_id and d.workspace_id=r.workspace_id where r.workspace_id=${workspaceId} and r.deleted_at is null and not d.archived
    union all select n.id,'note',n.title,'/knowledge/notes/'||n.id::text,'Note','ACTIVE',n.content from knowledge_notes n left join knowledge_records r on r.id=n.record_id left join knowledge_databases d on d.id=coalesce(n.database_id,r.database_id) where n.workspace_id=${workspaceId} and n.deleted_at is null and r.deleted_at is null and not coalesce(d.archived,false)
  ) items where (${input.type}='all' or type=${input.type}) and (title ilike ${term} or body ilike ${term}
    or (type='record' and exists(select 1 from knowledge_values v where v.record_id=items.id and v.workspace_id=${workspaceId} and v.text_value ilike ${term})))
    order by lower(title),type,id limit ${input.limit+1} offset ${input.offset}`);
  return page(rows,input.limit,input.offset);
}

/** Existing link tables remain the only source of truth. Archived links stay navigable and labeled. */
export async function connectedTaskContext(workspaceId:string,id:string,data:unknown={}) {
  uuid.parse(id);const query=connectedSearchQuery.pick({offset:true,limit:true}).parse(data);
  return withTransaction(async db=>{
    await loadTask(workspaceId,id);
    const rows=await db.execute<ConnectedItem>(sql`select distinct id,type,title,href,detail,state from (
      select g.id,'goal' type,g.title,'/goals/'||g.id::text href,'Goal' detail,g.status::text state from goal_tasks l join goals g on g.id=l.goal_id and g.workspace_id=l.workspace_id where l.workspace_id=${workspaceId} and l.task_id=${id}
      union select g.id,'goal',g.title,'/goals/'||g.id::text,'Goal',g.status::text from milestone_tasks l join milestones m on m.id=l.milestone_id and m.workspace_id=l.workspace_id join goals g on g.id=m.goal_id and g.workspace_id=m.workspace_id where l.workspace_id=${workspaceId} and l.task_id=${id}
      union all select m.id,'milestone',m.title,'/goals/'||m.goal_id::text||'#milestone-'||m.id::text,'Milestone · '||g.title,m.status::text from milestone_tasks l join milestones m on m.id=l.milestone_id and m.workspace_id=l.workspace_id join goals g on g.id=m.goal_id and g.workspace_id=m.workspace_id where l.workspace_id=${workspaceId} and l.task_id=${id}
      union all select t.id,'tracker',t.name,'/trackers/'||t.id::text,'Tracker',t.state from personal_tracker_links l join personal_trackers t on t.id=l.tracker_id and t.workspace_id=l.workspace_id where l.workspace_id=${workspaceId} and l.task_id=${id}
    ) links order by type,title,id limit ${query.limit+1} offset ${query.offset}`);
    return page(rows,query.limit,query.offset);
  },{isolationLevel:'repeatable read'});
}

/** These dates are context only: never busy intervals, scores, or invented recurrence. */
export async function connectedCalendar(workspaceId:string,data:unknown) {
  const query=connectedCalendarQuery.parse(data),workspace=await loadWorkspaceSettings(workspaceId,workspaceId);
  const from=localDateKey(new Date(query.start),workspace.timeZone),through=localDateKey(new Date(query.end),workspace.timeZone);
  const rows=await getDb().execute<ConnectedDate>(sql`select * from (
    select id::text,'goal' type,title,'/goals/'||id::text href,'Goal deadline' detail,to_char(due_at at time zone ${workspace.timeZone},'YYYY-MM-DD') as day from goals where workspace_id=${workspaceId} and status='ACTIVE' and due_at between ${query.start}::timestamptz and ${query.end}::timestamptz
    union all select m.id::text,'milestone',m.title,'/goals/'||m.goal_id::text||'#milestone-'||m.id::text,'Milestone deadline',to_char(m.due_at at time zone ${workspace.timeZone},'YYYY-MM-DD') from milestones m join goals g on g.id=m.goal_id and g.workspace_id=m.workspace_id where m.workspace_id=${workspaceId} and m.status='ACTIVE' and g.status='ACTIVE' and m.due_at between ${query.start}::timestamptz and ${query.end}::timestamptz
    union all select e.id::text,'tracker',t.name,'/trackers/'||t.id::text,'Recorded activity · '||t.time_zone||case when t.state='PAUSED' then ' · paused' else '' end,e.day::text from personal_tracker_entries e join personal_trackers t on t.id=e.tracker_id and t.workspace_id=e.workspace_id where e.workspace_id=${workspaceId} and e.deleted_at is null and t.state<>'ARCHIVED' and e.day between ${from}::date and ${through}::date
    union all select r.id::text||':'||p.id::text,'record',r.title,'/knowledge/records/'||r.id::text,d.name||' · '||p.name,v.date_value::text from knowledge_values v join knowledge_records r on r.id=v.record_id and r.workspace_id=v.workspace_id join knowledge_properties p on p.id=v.property_id and p.workspace_id=v.workspace_id join knowledge_databases d on d.id=r.database_id and d.workspace_id=r.workspace_id where v.workspace_id=${workspaceId} and v.type='DATE' and v.date_value between ${from}::date and ${through}::date and r.deleted_at is null and not d.archived and not p.hidden
  ) dates order by day,type,title,id limit ${query.limit+1} offset ${query.offset}`);
  return {...page(rows,query.limit,query.offset),timeZone:workspace.timeZone};
}

/** Compact independent sections; each reads at most seven rows and honestly signals more. */
export async function connectedToday(workspaceId:string,userId:string,now=new Date()) {
  const workspace=await loadWorkspaceSettings(workspaceId,workspaceId),bounds=localDayBounds(now,workspace.timeZone);
  const parts=localParts(now,workspace.timeZone),last=new Date(Date.UTC(parts.year,parts.month-1,parts.day+8));
  const through=new Date(zonedTimeToUtc(last.getUTCFullYear(),last.getUTCMonth()+1,last.getUTCDate(),0,0,workspace.timeZone).getTime()-1);
  return withTransaction(async db=>{
    const upcoming=await db.execute<ConnectedItem>(sql`select id,'task' type,title,'/tasks/'||id::text href,to_char(due_at at time zone ${workspace.timeZone},'Mon DD HH24:MI') detail from tasks where workspace_id=${workspaceId} and status='ACTIVE' and due_at>${bounds.end.toISOString()}::timestamptz and due_at<=${through.toISOString()}::timestamptz order by due_at,id limit 7`);
    const goals=await db.execute<ConnectedItem>(sql`select distinct g.id,'goal' type,g.title,'/goals/'||g.id::text href,'Linked to due or overdue work' detail from goals g where g.workspace_id=${workspaceId} and g.status='ACTIVE' and (exists(select 1 from goal_tasks l join tasks t on t.id=l.task_id where l.goal_id=g.id and l.workspace_id=${workspaceId} and t.workspace_id=${workspaceId} and t.status='ACTIVE' and t.due_at<=${bounds.end.toISOString()}::timestamptz) or exists(select 1 from milestones m join milestone_tasks l on l.milestone_id=m.id join tasks t on t.id=l.task_id where m.goal_id=g.id and m.status='ACTIVE' and m.workspace_id=${workspaceId} and l.workspace_id=${workspaceId} and t.workspace_id=${workspaceId} and t.status='ACTIVE' and t.due_at<=${bounds.end.toISOString()}::timestamptz)) union all select m.id,'milestone',m.title,'/goals/'||m.goal_id::text||'#milestone-'||m.id::text,'Milestone · '||g.title from milestones m join goals g on g.id=m.goal_id and g.workspace_id=m.workspace_id where m.workspace_id=${workspaceId} and m.status='ACTIVE' and g.status='ACTIVE' and exists(select 1 from milestone_tasks l join tasks t on t.id=l.task_id and t.workspace_id=l.workspace_id where l.milestone_id=m.id and l.workspace_id=${workspaceId} and t.status='ACTIVE' and t.due_at<=${bounds.end.toISOString()}::timestamptz) order by title,id limit 7`);
    const trackers=await db.execute<ConnectedItem>(sql`select t.id,'tracker' type,t.name title,'/trackers/'||t.id::text href,case when e.id is null then 'No entry today' else 'Recorded today'||case when e.stars is null then ' · unscored' else ' · '||e.stars::text||' stars' end end||' · '||t.time_zone detail from personal_trackers t left join personal_tracker_entries e on e.tracker_id=t.id and e.workspace_id=t.workspace_id and e.day=(${now.toISOString()}::timestamptz at time zone t.time_zone)::date and e.deleted_at is null where t.workspace_id=${workspaceId} and t.state='ACTIVE' and t.start_date<=(${now.toISOString()}::timestamptz at time zone t.time_zone)::date order by t.name,t.id limit 7`);
    const knowledge=await db.execute<ConnectedItem>(sql`select distinct coalesce(r.id,n.id) id,case when r.id is null then 'note' else 'record' end type,coalesce(r.title,n.title) title,case when r.id is null then '/knowledge/notes/'||n.id::text else '/knowledge/records/'||r.id::text end href,'Reference for due or overdue work' detail from knowledge_relations l join tasks t on t.id=l.task_id and t.workspace_id=l.workspace_id left join knowledge_records r on r.id=l.record_id left join knowledge_notes n on n.id=l.note_id left join knowledge_records nr on nr.id=n.record_id left join knowledge_databases d on d.id=coalesce(r.database_id,n.database_id,nr.database_id) where l.workspace_id=${workspaceId} and t.status='ACTIVE' and t.due_at<=${bounds.end.toISOString()}::timestamptz and r.deleted_at is null and n.deleted_at is null and nr.deleted_at is null and not coalesce(d.archived,false) order by title,id limit 7`);
    const calendarPage=await listCenterEvents({workspaceId,userId},{start:bounds.start.toISOString(),end:bounds.end.toISOString(),limit:7});
    const calendar:ConnectedItem[]=calendarPage.data.map(e=>({id:e.id,type:'calendar',title:e.title,href:'/calendar',detail:e.isAllDay?'All day':new Date(e.startsAt).toLocaleTimeString('en',{timeZone:workspace.timeZone,hour:'2-digit',minute:'2-digit'})}));
    const deadlines=await connectedCalendar(workspaceId,{start:bounds.start.toISOString(),end:through.toISOString(),limit:7});
    const section=(rows:ConnectedItem[])=>({data:rows.slice(0,6),hasMore:rows.length>6});
    return {day:localDateKey(now,workspace.timeZone),timeZone:workspace.timeZone,asOf:now.toISOString(),upcoming:section(upcoming),goals:section(goals),trackers:section(trackers),knowledge:section(knowledge),calendar:section(calendar),dates:section(deadlines.data.map(d=>({...d,detail:d.day+' · '+d.detail})))};
  },{isolationLevel:'repeatable read'});
}
