import { sql,type SQLWrapper } from 'drizzle-orm';
/** Shared latest-correction semantics for task analytics, focus and Insights. */
export function analyticsTaskExcluded(workspaceId:string,taskId:SQLWrapper){
  return sql`exists (select 1 from tracking_corrections tc
    where tc.task_id=${taskId} and tc.workspace_id=${workspaceId} and tc.kind='EXCLUDED_FROM_ANALYTICS' and tc.payload->>'state'='SET'
    and not exists(select 1 from tracking_corrections tc2 where tc2.task_id=tc.task_id and tc2.workspace_id=tc.workspace_id and tc2.kind=tc.kind and (tc2.created_at,tc2.id)>(tc.created_at,tc.id)))`;
}
