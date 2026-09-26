import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { taskQuerySchema } from '@nextdoo/contracts';
import { assertWorkspaceAccess } from '../auth';
import { getDb } from '../db';
import { queryTasks } from './tasks';
import { listGoals } from './goals';
import { connectedToday } from './connected';
import { getActiveTimer } from './timers';
import { getInsights } from './insights';
import { loadWorkspaceSettings } from './workspaces';
import { dailyFilters, dailyWindow } from '@/lib/daily-tasks';
import type { HomeCardData } from '@/lib/home-widgets';
type Actor = { userId: string; workspaceId: string };
export async function homeSummary(actor: Actor, now = new Date()) {
  await assertWorkspaceAccess(actor.userId, actor.workspaceId);
  const workspace = await loadWorkspaceSettings(actor.workspaceId, actor.workspaceId);
  const { start, end } = dailyWindow(now, workspace.timeZone), upcoming = dailyWindow(now, workspace.timeZone, 1, 7);
  const [counts] = await getDb().execute<{ completed: number; upcoming: number; overdue: number }>(sql`select
    count(*) filter(where status='COMPLETED' and completed_at between ${start.toISOString()}::timestamptz and ${end.toISOString().replace('.999Z','.999999Z')}::timestamptz)::int completed,
    count(*) filter(where status='ACTIVE' and due_at between ${upcoming.start.toISOString()}::timestamptz and ${upcoming.end.toISOString().replace('.999Z','.999999Z')}::timestamptz)::int upcoming,
    count(*) filter(where status='ACTIVE' and due_at<${start.toISOString()}::timestamptz)::int overdue
    from tasks where workspace_id=${actor.workspaceId} and deleted_at is null`);
  const [focus] = await getDb().execute<{ minutes: number }>(sql`select coalesce(sum(accumulated_seconds+manual_adjustment_seconds),0)::float8/60 minutes from timer_sessions where workspace_id=${actor.workspaceId} and started_at between ${start.toISOString()}::timestamptz and ${end.toISOString().replace('.999Z','.999999Z')}::timestamptz and status in ('STOPPED','OVERLAPPED')`);
  return { ...counts!, focusMinutes: Math.round(focus!.minutes), timeZone: workspace.timeZone, asOf: now.toISOString() };
}
export async function homeCard(actor: Actor, value: unknown, now = new Date()): Promise<HomeCardData> {
  await assertWorkspaceAccess(actor.userId, actor.workspaceId);
  const card = z.enum(['today','upcoming','overdue','priorities','goals','focus','calendar','tracker','knowledge','insights']).parse(value);
  const workspace = await loadWorkspaceSettings(actor.workspaceId, actor.workspaceId);
  if (['today','upcoming','overdue','priorities'].includes(card)) {
    const filters: Record<string, unknown> = { workspaceId: actor.workspaceId, status: 'ACTIVE', limit: 5, sortBy: 'dueAt', sortOrder: 'asc' };
    if (card === 'upcoming' || card === 'overdue') Object.assign(filters, Object.fromEntries(dailyFilters(card, now, workspace.timeZone)));
    if (card === 'today') { const day = dailyWindow(now, workspace.timeZone); filters.dueAfter = day.start.toISOString(); filters.dueBefore = day.end.toISOString().replace('.999Z','.999999Z'); }
    if (card === 'priorities') filters.priority = 'HIGH';
    const tasks = await queryTasks(actor.workspaceId, taskQuerySchema.parse(filters));
    return { more: tasks.hasMore, items: tasks.data.map(t => ({ id:t.id, title:t.title, href:'/tasks/'+t.id, detail:t.dueAt ? new Date(t.dueAt).toLocaleString('en', { timeZone:workspace.timeZone, month:'short',day:'numeric',hour:'2-digit',minute:'2-digit' }) : 'Unscheduled' })) };
  }
  if (card === 'goals') { const goals = await listGoals(actor.workspaceId, { limit:5 }); return { more:!!goals.nextCursor, items:goals.data.map(({goal,progress}) => ({ id:goal.id, title:goal.title, href:'/goals/'+goal.id, detail:progress.percent === null ? 'Not measured' : `${progress.percent}% · ${progress.completed}/${progress.total} units` })) }; }
  if (card === 'focus') { const timer = await getActiveTimer(actor.userId); return { more:false, items:timer ? [{id:timer.id,title:timer.status === 'RUNNING' ? 'Session running' : 'Session paused',href:'/focus',detail:`${Math.floor(timer.elapsedSeconds/60)}m recorded at refresh`}] : [] }; }
  if (card === 'calendar' || card === 'tracker') { const today = await connectedToday(actor.workspaceId, actor.userId, now), section = card === 'tracker' ? today.trackers : today.calendar; return { more:section.hasMore, items:section.data.map(i=>({id:i.id,title:i.title,href:i.href ?? '/home',detail:i.detail})) }; }
  if (card === 'knowledge') {
    const rows = await getDb().execute<HomeCardData['items'][number]>(sql`select id,title,href,detail from (
      select n.id,n.title,'/knowledge/notes/'||n.id::text href,'Note' detail,n.updated_at from knowledge_notes n
      left join knowledge_records r on r.id=n.record_id left join knowledge_databases d on d.id=coalesce(n.database_id,r.database_id)
      where n.workspace_id=${actor.workspaceId} and n.deleted_at is null and r.deleted_at is null and not coalesce(d.archived,false)
      union all select r.id,r.title,'/knowledge/records/'||r.id::text,'Record',r.updated_at from knowledge_records r join knowledge_databases d on d.id=r.database_id
      where r.workspace_id=${actor.workspaceId} and r.deleted_at is null and not d.archived
    ) recent order by updated_at desc,id limit 6`);
    return {more:rows.length>5,items:rows.slice(0,5)};
  }
  const report = await getInsights(actor, {period:'day'}, now);
  return { more:false, items:[{id:'tasks',title:`${report.tasks.completed} tasks completed`,href:'/insights?period=day',detail:`${report.tasks.focusMinutes} recorded focus minutes · ${report.window.from}`}] };
}
