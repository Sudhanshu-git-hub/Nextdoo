import { sql } from 'drizzle-orm';
import { analyticsTaskExcluded } from './analytics-scope';
/** One reporting projection for existing sessions and legacy append-only manual logs. */
export function focusTimeRows(workspaceId:string,from:string,to:string,now=new Date()){
  return sql`select s.started_at,s.task_id,
    (s.accumulated_seconds+s.manual_adjustment_seconds+case when s.status='RUNNING' and s.last_resumed_at is not null
      then greatest(0,floor(extract(epoch from (${now.toISOString()}::timestamptz-s.last_resumed_at)))) else 0 end)::float8 seconds
    from timer_sessions s where s.workspace_id=${workspaceId} and s.started_at between ${from}::timestamptz and ${to}::timestamptz
      and not ${analyticsTaskExcluded(workspaceId,sql`s.task_id`)}
    union all select e.occurred_at,e.task_id,coalesce((e.payload->>'seconds')::float8,(e.payload->>'minutes')::float8*60,0)
    from tracking_events e where e.workspace_id=${workspaceId} and e.type='TIME_LOGGED' and e.payload->>'source'='manual'
      and e.occurred_at between ${from}::timestamptz and ${to}::timestamptz and not ${analyticsTaskExcluded(workspaceId,sql`e.task_id`)}`;
}
