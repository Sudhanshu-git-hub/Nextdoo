import { and,eq,gte,isNull,lte,ne,sql,inArray } from 'drizzle-orm';
import { AppError,insightsQuerySchema,type InsightsWindow } from '@nextdoo/contracts';
import { goals,personalTrackers,personalTrackerEntries,type Database } from '@nextdoo/db';
import { insightsWindow,previousInsightsWindow,personalTrackerReport,personalTrackerStreaks,trackerDate } from '@nextdoo/core';
import { withTransaction } from '../db';
import { assertWorkspaceAccess } from '../auth';
import { loadWorkspaceSettings } from './workspaces';
import { getWellbeingPreferences } from './preferences';
import { progressFor,type GoalActor } from './goals';
import { focusTimeRows } from './focus-time';
import { analyticsTaskExcluded } from './analytics-scope';
import { calendarCenterProjection,listCalendarSources } from './calendar-center';

const n=(value:unknown)=>Number(value??0);
const rate=(a:number,b:number)=>b?Math.round(a/b*1000)/1000:null;
const round=(value:number)=>Math.round(value*100)/100;
type Prefs=Awaited<ReturnType<typeof getWellbeingPreferences>>;

async function taskMetrics(db:Database,workspaceId:string,w:InsightsWindow,now:Date){
  const scope=sql`t.workspace_id=${workspaceId} and t.deleted_at is null and t.status<>'DELETED' and not ${analyticsTaskExcluded(workspaceId,sql`t.id`)}`;
  const due=sql`t.due_at between ${w.start}::timestamptz and ${w.end}::timestamptz`;
  const [row]=await db.execute(sql`select
    count(*) filter(where t.created_at between ${w.start}::timestamptz and ${w.end}::timestamptz)::int created,
    count(*) filter(where t.completed_at between ${w.start}::timestamptz and ${w.end}::timestamptz)::int completed,
    count(*) filter(where ${due})::int planned,
    count(*) filter(where ${due} and t.status='COMPLETED' and t.completed_at is not null)::int done,
    count(*) filter(where ${due} and t.status='ACTIVE')::int incomplete,
    count(*) filter(where ${due} and t.status='ACTIVE' and t.due_at<${now.toISOString()}::timestamptz)::int overdue,
    count(*) filter(where t.status='ACTIVE' and t.due_at<${now.toISOString()}::timestamptz)::int "currentOverdue"
    from tasks t where ${scope}`);
  const dimensions=await db.execute<{kind:string;key:string;count:number;title:string}>(sql`
    with cohort as(select t.* from tasks t where ${scope} and ${due})
    select 'priority' kind,priority::text key,count(*)::int count,priority::text title from cohort group by priority
    union all select 'status',status::text,count(*)::int,status::text from cohort group by status
    union all select 'project',coalesce(c.project_id::text,'inbox'),count(*)::int,coalesce(p.name,'Inbox') from cohort c left join projects p on p.id=c.project_id and p.workspace_id=${workspaceId} group by c.project_id,p.name`);
  const trend=await db.execute<{day:string;created:number;completed:number;planned:number;done:number;focusMinutes:number}>(sql`
    with days as(select generate_series(${w.from}::date,${w.to}::date,interval '1 day')::date AS day),
    activity as(
      select (t.created_at at time zone ${w.timeZone})::date AS day,'created' kind from tasks t where ${scope} and t.created_at between ${w.start}::timestamptz and ${w.end}::timestamptz
      union all select (t.completed_at at time zone ${w.timeZone})::date,'completed' from tasks t where ${scope} and t.completed_at between ${w.start}::timestamptz and ${w.end}::timestamptz
      union all select (t.due_at at time zone ${w.timeZone})::date,'planned' from tasks t where ${scope} and ${due}
      union all select (t.due_at at time zone ${w.timeZone})::date,'done' from tasks t where ${scope} and ${due} and t.status='COMPLETED' and t.completed_at is not null
    ), counts as(select day,count(*) filter(where kind='created')::int created,count(*) filter(where kind='completed')::int completed,count(*) filter(where kind='planned')::int planned,count(*) filter(where kind='done')::int done from activity group by day),
    focus as(select (f.started_at at time zone ${w.timeZone})::date AS day,sum(f.seconds)::float8/60 minutes
      from (${focusTimeRows(workspaceId,w.start,w.end,now)}) f group by day)
    select d.day::text AS day,coalesce(c.created,0)::int created,coalesce(c.completed,0)::int completed,coalesce(c.planned,0)::int planned,coalesce(c.done,0)::int done,coalesce(f.minutes,0)::float8 "focusMinutes"
    from days d left join counts c using(day) left join focus f using(day) order by d.day`);
  return {created:n(row!.created),completed:n(row!.completed),planned:n(row!.planned),completedPlanned:n(row!.done),incomplete:n(row!.incomplete),overdue:n(row!.overdue),currentOverdue:n(row!.currentOverdue),completionRate:rate(n(row!.done),n(row!.planned)),focusMinutes:round(trend.reduce((sum,d)=>sum+n(d.focusMinutes),0)),byPriority:dimensions.filter(d=>d.kind==='priority'),byStatus:dimensions.filter(d=>d.kind==='status'),byProject:dimensions.filter(d=>d.kind==='project').sort((a,b)=>b.count-a.count).slice(0,20),projectGroups:dimensions.filter(d=>d.kind==='project').length,trend};
}

async function goalMetrics(db:Database,workspaceId:string,w:InsightsWindow,now:Date){
  const [linked]=await db.execute(sql`with links as(
    select l.task_id from goal_tasks l join goals g on g.id=l.goal_id where l.workspace_id=${workspaceId} and g.status<>'ARCHIVED'
    union select l.task_id from milestone_tasks l join milestones m on m.id=l.milestone_id join goals g on g.id=m.goal_id where l.workspace_id=${workspaceId} and m.status<>'ARCHIVED' and g.status<>'ARCHIVED'
  ) select count(*)::int total,count(*) filter(where t.completed_at is not null)::int completed from links l join tasks t on t.id=l.task_id where t.workspace_id=${workspaceId} and t.status<>'DELETED'`);
  const [totals]=await db.execute(sql`select count(*) filter(where status='ACTIVE')::int active,count(*) filter(where status='ACTIVE' and due_at<${now.toISOString()}::timestamptz)::int overdue,count(*) filter(where completed_at between ${w.start}::timestamptz and ${w.end}::timestamptz)::int completed from goals where workspace_id=${workspaceId} and status<>'ARCHIVED'`);
  const [milestones]=await db.execute(sql`select count(*) filter(where m.status='ACTIVE')::int remaining,count(*) filter(where m.status='ACTIVE' and m.due_at<${now.toISOString()}::timestamptz)::int overdue,count(*) filter(where m.completed_at between ${w.start}::timestamptz and ${w.end}::timestamptz)::int completed from milestones m join goals g on g.id=m.goal_id and g.workspace_id=m.workspace_id where m.workspace_id=${workspaceId} and m.status<>'ARCHIVED' and g.status<>'ARCHIVED'`);
  const rows=await db.select({id:goals.id,title:goals.title,status:goals.status}).from(goals).where(and(eq(goals.workspaceId,workspaceId),ne(goals.status,'ARCHIVED'))).orderBy(goals.id).limit(51);
  const progress=await progressFor(db,workspaceId,rows.slice(0,50).map(g=>g.id));
  const trend=await db.execute<{day:string;completed:number}>(sql`select (completed_at at time zone ${w.timeZone})::date::text AS day,count(*)::int completed from goals where workspace_id=${workspaceId} and status='COMPLETED' and completed_at between ${w.start}::timestamptz and ${w.end}::timestamptz group by day order by day`);
  return {active:n(totals!.active),overdue:n(totals!.overdue),completed:n(totals!.completed),linkedTasks:n(linked!.total),completedLinkedTasks:n(linked!.completed),completedMilestones:n(milestones!.completed),remainingMilestones:n(milestones!.remaining),overdueMilestones:n(milestones!.overdue),items:rows.slice(0,50).map(g=>({...g,progress:progress.get(g.id)!})),hasMore:rows.length>50,trend};
}

async function activityMetrics(db:Database,workspaceId:string,w:InsightsWindow,now:Date){
  const recent=await db.execute<{id:string;kind:string;title:string;at:Date}>(sql`
    select * from (
      select id,'task' kind,title,completed_at AS at from tasks t where workspace_id=${workspaceId} and status<>'DELETED' and completed_at between ${w.start}::timestamptz and ${w.end}::timestamptz and not ${analyticsTaskExcluded(workspaceId,sql`t.id`)}
      union all select id,'goal',title,completed_at from goals where workspace_id=${workspaceId} and status='COMPLETED' and completed_at between ${w.start}::timestamptz and ${w.end}::timestamptz
      union all select r.id,'record',r.title,r.created_at from knowledge_records r left join knowledge_databases d on d.id=r.database_id where r.workspace_id=${workspaceId} and r.deleted_at is null and not coalesce(d.archived,false) and r.created_at between ${w.start}::timestamptz and ${w.end}::timestamptz
      union all select n.id,'note',n.title,n.created_at from knowledge_notes n left join knowledge_records r on r.id=n.record_id left join knowledge_databases d on d.id=coalesce(n.database_id,r.database_id) where n.workspace_id=${workspaceId} and n.deleted_at is null and r.deleted_at is null and not coalesce(d.archived,false) and n.created_at between ${w.start}::timestamptz and ${w.end}::timestamptz
    ) a order by at desc,id limit 20`);
  const upcoming=await db.execute<{id:string;kind:string;title:string;at:Date}>(sql`
    select * from (
      select id,'task' kind,title,due_at AS at from tasks t where workspace_id=${workspaceId} and status='ACTIVE' and not ${analyticsTaskExcluded(workspaceId,sql`t.id`)}
      union all select id,'goal',title,due_at from goals where workspace_id=${workspaceId} and status='ACTIVE'
      union all select m.goal_id,'milestone',m.title,m.due_at from milestones m join goals g on g.id=m.goal_id where m.workspace_id=${workspaceId} and m.status='ACTIVE' and g.status='ACTIVE'
    ) a where at>=${now.toISOString()}::timestamptz order by at,id limit 20`);
  const serialise=(rows:typeof recent)=>rows.map(r=>({...r,at:new Date(r.at).toISOString()}));
  return {recent:serialise(recent),upcoming:serialise(upcoming)};
}

async function trackerMetrics(db:Database,workspaceId:string,w:InsightsWindow,now:Date,prefs:Prefs){
  const trackers=await db.select({id:personalTrackers.id,name:personalTrackers.name,startDate:personalTrackers.startDate,timeZone:personalTrackers.timeZone}).from(personalTrackers).where(and(eq(personalTrackers.workspaceId,workspaceId),ne(personalTrackers.state,'ARCHIVED'))).orderBy(personalTrackers.id).limit(201);
  if(trackers.length>200)throw new AppError('VALIDATION_FAILED','Insights currently supports up to 200 non-archived trackers. Individual Tracker reports remain available.');
  const rows=trackers.length?await db.select({trackerId:personalTrackerEntries.trackerId,day:personalTrackerEntries.day,stars:personalTrackerEntries.stars,statusName:personalTrackerEntries.statusName,sourceCount:sql<number>`(select count(distinct s.task_identity)::int from personal_tracker_sources s where s.entry_id=personal_tracker_entries.id)`}).from(personalTrackerEntries).where(and(eq(personalTrackerEntries.workspaceId,workspaceId),inArray(personalTrackerEntries.trackerId,trackers.map(t=>t.id)),isNull(personalTrackerEntries.deletedAt),gte(personalTrackerEntries.day,w.from),lte(personalTrackerEntries.day,w.to))).limit(50001):[];
  if(rows.length>50000)throw new AppError('VALIDATION_FAILED','This report contains more than 50,000 tracker days. Choose a shorter range.');
  const items=trackers.map(t=>{const today=trackerDate(now,t.timeZone),to=w.to<today?w.to:today,report=personalTrackerReport(t.startDate,w.from,to,rows.filter(r=>r.trackerId===t.id));return {id:t.id,name:t.name,timeZone:t.timeZone,...report,...(!prefs.disableStreaks?{streaks:personalTrackerStreaks(report.from,report.to,report.trend)}:{})};});
  const calendarDays=items.reduce((s,t)=>s+t.calendarDays,0),trackedDays=items.reduce((s,t)=>s+t.trackedDays,0),totalStars=items.reduce((s,t)=>s+t.totalStars,0);
  const distribution:Record<string,number>=Object.create(null),daily=new Map<string,{day:string;trackedDays:number;totalStars:number}>();
  for(const t of items){for(const [status,count] of Object.entries(t.statusDistribution))distribution[status]=(distribution[status]??0)+count;for(const d of t.trend){const v=daily.get(d.day)??{day:d.day,trackedDays:0,totalStars:0};v.trackedDays++;v.totalStars+=d.stars??0;daily.set(d.day,v);}}
  const trend=[...daily.values()].sort((a,b)=>a.day.localeCompare(b.day));
  const group=(kind:'week'|'month')=>{const result=new Map<string,{period:string;trackedDays:number;totalStars:number}>();for(const t of items)for(const p of kind==='week'?t.weekly:t.monthly){const row=result.get(p.period)??{period:p.period,trackedDays:0,totalStars:0};row.trackedDays+=p.trackedDays;row.totalStars+=p.totalStars;result.set(p.period,row);}return [...result.values()].sort((a,b)=>a.period.localeCompare(b.period));};
  return {count:items.length,calendarDays,trackedDays,unscoredDays:items.reduce((s,t)=>s+t.unscoredDays,0),totalStars,averageStars:calendarDays?totalStars/calendarDays:null,relativeStars:trackedDays?totalStars/trackedDays:null,statusDistribution:distribution,items:items.map(({trend:_trend,weekly:_weekly,monthly:_monthly,bestDay:_best,worstDay:_worst,...t})=>t),trend,weekly:group('week'),monthly:group('month')};
}

async function calendarMetrics(db:Database,actor:GoalActor,w:InsightsWindow,taskDeadlines:number){
  const projection=await calendarCenterProjection(actor,{start:w.start,end:w.end});
  const [total]=await db.execute(sql`select count(*)::int events,count(*) filter(where "isAllDay")::int "allDayEvents",coalesce(sum(extract(epoch from (least("endsAt",${w.end}::timestamptz+interval '1 millisecond')-greatest("startsAt",${w.start}::timestamptz)))/60) filter(where not "isAllDay"),0)::float8 "scheduledMinutes" from (${projection}) e`);
  const days=await db.execute<{day:string;events:number;allDayEvents:number;scheduledMinutes:number}>(sql`
    with events as(${projection}),days as(select generate_series(${w.from}::date,${w.to}::date,interval '1 day')::date AS day)
    select d.day::text AS day,count(e.id)::int events,count(e.id) filter(where e."isAllDay")::int "allDayEvents",coalesce(sum(extract(epoch from (least(e."endsAt",(d.day+1)::timestamp at time zone ${w.timeZone})-greatest(e."startsAt",d.day::timestamp at time zone ${w.timeZone})))/60) filter(where not e."isAllDay"),0)::float8 "scheduledMinutes"
    from days d left join events e on ((e."isAllDay" and e."startDay"::date<=d.day and e."endDay"::date>d.day) or (not e."isAllDay" and e."startsAt"<(d.day+1)::timestamp at time zone ${w.timeZone} and e."endsAt">d.day::timestamp at time zone ${w.timeZone})) group by d.day order by d.day`);
  const sources=await listCalendarSources(actor),tasksVisible=sources.find(s=>s.id==='internal:task')?.visible!==false;
  return {events:n(total!.events),allDayEvents:n(total!.allDayEvents),scheduledMinutes:round(n(total!.scheduledMinutes)),taskDeadlines:tasksVisible?taskDeadlines:0,tasksVisible,days};
}

async function knowledgeMetrics(db:Database,workspaceId:string,w:InsightsWindow){
  const [row]=await db.execute(sql`select
    (select count(*)::int from knowledge_databases where workspace_id=${workspaceId} and not archived) databases,
    (select count(*)::int from knowledge_records r left join knowledge_databases d on d.id=r.database_id where r.workspace_id=${workspaceId} and r.deleted_at is null and not coalesce(d.archived,false) and r.created_at between ${w.start}::timestamptz and ${w.end}::timestamptz) records,
    (select count(*)::int from knowledge_notes n left join knowledge_records r on r.id=n.record_id left join knowledge_databases d on d.id=coalesce(n.database_id,r.database_id) where n.workspace_id=${workspaceId} and n.deleted_at is null and r.deleted_at is null and not coalesce(d.archived,false) and n.created_at between ${w.start}::timestamptz and ${w.end}::timestamptz) notes`);
  return {databases:n(row!.databases),recordsCreated:n(row!.records),notesCreated:n(row!.notes)};
}

async function periodMetrics(db:Database,actor:GoalActor,w:InsightsWindow,now:Date,prefs:Prefs){
  const tasks=await taskMetrics(db,actor.workspaceId,w,now);
  return {tasks,goals:await goalMetrics(db,actor.workspaceId,w,now),trackers:await trackerMetrics(db,actor.workspaceId,w,now,prefs),calendar:await calendarMetrics(db,actor,w,tasks.planned),knowledge:await knowledgeMetrics(db,actor.workspaceId,w)};
}

/** Strip numeric stars before the shared DTO reaches either pages or downloads. */
function respectPreferences<T>(value:T,prefs:Prefs):T {
  // Only known metric objects are redacted; status names are user-defined.
  const copy=JSON.parse(JSON.stringify(value));
  if(prefs.disableScores){
    for(const row of [copy.trackers,...copy.trackers.items,...copy.trackers.trend,...copy.trackers.weekly,...copy.trackers.monthly]){
      delete row.totalStars;delete row.averageStars;delete row.relativeStars;
    }
    if(copy.comparison)delete copy.comparison.trackerStars;
  }
  return copy;
}
export async function getInsights(actor:GoalActor,raw:unknown,now=new Date()){
  const query=insightsQuerySchema.parse(raw);
  return withTransaction(async db=>{
    await assertWorkspaceAccess(actor.userId,actor.workspaceId);
    const workspace=await loadWorkspaceSettings(actor.workspaceId,actor.workspaceId),prefs=await getWellbeingPreferences(actor.userId),window=insightsWindow(query,workspace.timeZone,workspace.weekStart,now);
    const current=await periodMetrics(db,actor,window,now,prefs);
    let comparison:null|{window:InsightsWindow;tasksCompleted:number;completionRate:number|null;focusMinutes:number;trackerStars:number|null;trackedDays:number|null}=null;
    let comparisonReason=prefs.disableComparativeMetrics?'Period comparisons are hidden in Wellbeing settings.':!window.complete?'Comparisons require a completed date range.':query.compare!=='true'?'Choose Compare to the previous equal-length period.':null;
    if(!comparisonReason){const previousWindow=previousInsightsWindow(window,workspace.weekStart,now),previous=await periodMetrics(db,actor,previousWindow,now,prefs);
      const trackerComparable=current.trackers.items.every(t=>{const prior=previous.trackers.items.find(p=>p.id===t.id);return prior?.calendarDays===t.calendarDays&&t.to===window.to;});
      comparison={window:previousWindow,tasksCompleted:current.tasks.completed-previous.tasks.completed,completionRate:current.tasks.completionRate!==null&&previous.tasks.completionRate!==null?current.tasks.completionRate-previous.tasks.completionRate:null,focusMinutes:round(current.tasks.focusMinutes-previous.tasks.focusMinutes),trackerStars:!prefs.disableScores&&trackerComparable?current.trackers.totalStars-previous.trackers.totalStars:null,trackedDays:trackerComparable?current.trackers.trackedDays-previous.trackers.trackedDays:null};
      if(!trackerComparable)comparisonReason='Tracker star comparison unavailable: eligible tracker dates differ. Other comparisons remain available.';
    }
    return respectPreferences({generatedAt:now.toISOString(),window,weekStart:workspace.weekStart,preferences:{scoresEnabled:!prefs.disableScores,streaksEnabled:!prefs.disableStreaks,comparisonsEnabled:!prefs.disableComparativeMetrics},...current,activity:await activityMetrics(db,actor.workspaceId,window,now),comparison,comparisonReason},prefs);
  },{isolationLevel:'repeatable read',accessMode:'read only'});
}
export type InsightsReport=Awaited<ReturnType<typeof getInsights>>;
