import { randomUUID } from 'node:crypto';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { Database } from './client';
import { trackingJobs } from './schema';
import { CALCULATION_VERSION, evaluateTrackingInTransaction } from './tracking-engine';

const BATCH = 25;
/** Full precision, explicit UTC: JavaScript millisecond truncation must not gate PG claims. */
const clock = sql`clock_timestamp()`;
const scope = (workspaceId?: string) => workspaceId ? sql`j.workspace_id=${workspaceId}` : sql`true`;
/** Candidate enumeration also has a database-side deadline. */
function scan<T extends Record<string,unknown>>(db:Database,query:SQL) {
 return db.transaction(async(tx)=>{await tx.execute(sql`set local statement_timeout='8s'`);return tx.execute<T>(query);});
}
async function lockWorkspace(db: Database, workspaceId: string) {
 await db.execute(sql`set local statement_timeout='8s'`);
 await db.execute(sql`set local lock_timeout='500ms'`);
 await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'workspace:' + workspaceId}, 0))`);
 const owner = await db.execute(sql`select u.id from users u join workspaces w on w.owner_id=u.id
  where w.id=${workspaceId} and w.deleted_at is null and u.deleted_at is null and u.deletion_requested_at is null and u.status='ACTIVE' for share of u`);
 return owner.length > 0;
}

/** Per-consumer delivery. Unrelated consumers retain their own pending outbox evidence. */
export async function relayTrackingOutbox(db: Database, workspaceId?: string) {
 const rows = await scan<{ id: string; workspace_id: string }>(db,sql`select id,workspace_id from (select o.id,o.workspace_id,o.occurred_at,
  row_number() over(partition by o.workspace_id order by o.occurred_at,o.id) as turn from outbox o
  join workspaces w on w.id=o.workspace_id join users u on u.id=w.owner_id
  where w.deleted_at is null and u.deleted_at is null and u.deletion_requested_at is null and u.status='ACTIVE' and o.workspace_id is not null and o.schema_version=1 and
   ((o.entity_type='task' and (o.event_type in ('task.created','task.updated','task.completed','task.reopened','task.rescheduled','task.archived','task.deleted','task.restored','recurrence.occurrence_generated')))
    or (o.entity_type='timer_session' and o.event_type in ('timer.started','timer.stopped')))
   and (${workspaceId ? sql`o.workspace_id=${workspaceId}` : sql`true`})
   and not exists(select 1 from tracking_outbox_receipts r where r.outbox_id=o.id)
  ) candidates order by turn,occurred_at,id limit 100`);
 let received = 0, deferred = 0;const started=performance.now();
 for (const row of rows) {
  if(performance.now()-started>20000)break;
  try {
   received += await db.transaction(async (tx) => {
    if (!await lockWorkspace(tx as unknown as Database, row.workspace_id)) return 0;
    const claimed = await tx.execute(sql`select id from outbox o where o.id=${row.id}
      and o.workspace_id=${row.workspace_id} and o.schema_version=1
      and not exists(select 1 from tracking_outbox_receipts r where r.outbox_id=o.id) for update skip locked`);
    if (!claimed.length) return 0;
    await tx.execute(sql`update tracking_jobs j set queued_revision=j.revision,queued_calculation_version=${CALCULATION_VERSION},
      queued_cohort_revision=coalesce(r.tracking_revision,0),queued_at=${clock}
      from outbox o left join timer_sessions timer on o.entity_type='timer_session' and timer.id=o.entity_id and timer.workspace_id=o.workspace_id,
       tasks t left join recurrence_rules r on r.id=t.recurrence_rule_id and r.workspace_id=t.workspace_id
      where o.id=${row.id} and o.workspace_id=${row.workspace_id} and j.workspace_id=o.workspace_id and t.id=j.task_id and t.workspace_id=j.workspace_id
      and j.task_id=case when o.entity_type='task' then o.entity_id else timer.task_id end
      and j.queued_revision<j.revision`);
    await tx.execute(sql`insert into tracking_outbox_receipts(outbox_id,workspace_id) values(${row.id},${row.workspace_id}) on conflict do nothing`);
    return 1;
   });
  } catch { deferred++; }
 }
 return { received, deferred };
}

/** Bounded reconciliation covers clocks, recurrence fan-out, legacy bootstrap and
 * engine upgrades, including producers outside the web process. No retry reset
 * unless new inputs/engine/cohort or a newly crossed deadline request new work.
 */
export async function reconcileTracking(db: Database, workspaceId?: string) {
 const rows = await scan<{ task_id: string; workspace_id: string }>(db,sql`
  select task_id,workspace_id from (select j.task_id,j.workspace_id,coalesce(j.queued_at,j.requested_at) as requested,
   row_number() over(partition by j.workspace_id,date_trunc('day',coalesce(t.due_at,j.requested_at) at time zone 'UTC') order by coalesce(j.queued_at,j.requested_at),j.task_id) as turn
  from tracking_jobs j join tasks t on t.id=j.task_id and t.workspace_id=j.workspace_id
  left join recurrence_rules r on r.id=t.recurrence_rule_id and r.workspace_id=t.workspace_id
  join workspaces w on w.id=j.workspace_id join users u on u.id=w.owner_id
  where ${scope(workspaceId)} and t.deleted_at is null and t.status<>'DELETED' and w.deleted_at is null and u.status='ACTIVE' and u.deleted_at is null and u.deletion_requested_at is null
   and ((j.revision>j.queued_revision and (j.requested_at >= now()-interval '90 days' or t.due_at >= now()-interval '90 days'))
    or j.next_evaluation_at <= ${clock} or j.queued_cohort_revision<>coalesce(r.tracking_revision,0)
    or (j.queued_calculation_version<>${CALCULATION_VERSION} and (j.requested_at >= now()-interval '90 days' or t.due_at >= now()-interval '90 days')))
  ) candidates order by turn,requested,task_id limit ${BATCH}`);
 let queued = 0, deferred = 0;const started=performance.now();
 for (const row of rows) {
  if(performance.now()-started>20000)break;
  try {
   queued += await db.transaction(async (tx) => {
    if (!await lockWorkspace(tx as unknown as Database, row.workspace_id)) return 0;
    const changed = await tx.execute(sql`update tracking_jobs j set revision=j.revision+1,queued_revision=j.revision+1,
     queued_calculation_version=${CALCULATION_VERSION},queued_cohort_revision=coalesce(r.tracking_revision,0),next_evaluation_at=null,
     queued_at=${clock}, claim_token=null,lease_expires_at=null,attempts=0,last_error=null,last_error_at=null,next_attempt_at=${clock}
     from tasks t left join recurrence_rules r on r.id=t.recurrence_rule_id and r.workspace_id=t.workspace_id
     where j.task_id=${row.task_id} and j.workspace_id=${row.workspace_id} and t.id=j.task_id and t.workspace_id=j.workspace_id and t.deleted_at is null
      and (j.queued_revision<j.revision or j.next_evaluation_at<=${clock} or j.queued_cohort_revision<>coalesce(r.tracking_revision,0) or j.queued_calculation_version<>${CALCULATION_VERSION}) returning j.task_id`);
    return changed.length;
   });
  } catch { deferred++; }
 }
 return { queued, deferred };
}

/** Recover abandoned claims in bounded transactions. The attempt was committed
 * before evaluation, so even repeated hard crashes stop after six attempts.
 */
export async function recoverTrackingClaims(db: Database, workspaceId?: string) {
 const expired = await scan<{ task_id:string; workspace_id:string }>(db,sql`select task_id,workspace_id from (
  select j.task_id,j.workspace_id,j.lease_expires_at,row_number() over(partition by j.workspace_id order by j.lease_expires_at,j.task_id) as turn
  from tracking_jobs j join workspaces w on w.id=j.workspace_id join users u on u.id=w.owner_id
  where w.deleted_at is null and u.deleted_at is null and u.deletion_requested_at is null and u.status='ACTIVE' and ${scope(workspaceId)} and j.claim_token is not null and j.lease_expires_at<=${clock}
  ) candidates order by turn,lease_expires_at,task_id limit ${BATCH}`);
 const failures:TrackingFailure[]=[];let deferred=0;
 for (const row of expired) {
  try {
   const failure = await db.transaction(async(tx)=>{
    if (!await lockWorkspace(tx as unknown as Database,row.workspace_id)) return;
    const [job] = await tx.update(trackingJobs).set({ claimToken:null,leaseExpiresAt:null,lastError:'WORKER_INTERRUPTED',lastErrorAt:clock,
     nextAttemptAt:sql`${trackingJobs.leaseExpiresAt} + (least(900,60*power(2,greatest(0,${trackingJobs.attempts}-1))) * interval '1 second')`,
    }).where(and(eq(trackingJobs.taskId,row.task_id),eq(trackingJobs.workspaceId,row.workspace_id),sql`${trackingJobs.claimToken} is not null`,sql`${trackingJobs.leaseExpiresAt}<=${clock}`)).returning();
    return job?{workspaceId:job.workspaceId,taskId:job.taskId,revision:job.revision,attempts:job.attempts,error:'WORKER_INTERRUPTED'}:undefined;
   });
   if(failure)failures.push(failure);
  } catch { deferred++; }
 }
 return {failures,deferred};
}
type TrackingFailure={workspaceId:string;taskId:string;revision:number;attempts:number;error:string};

/** Fenced calculation phase, separate from the durable claim transaction. */
export async function finishTrackingClaim(db:Database,claimed:Pick<typeof trackingJobs.$inferSelect,'taskId'|'workspaceId'|'revision'|'claimToken'>) {
 const token=claimed.claimToken;if(!token)return;
 return db.transaction(async(tx)=>{
    if(!await lockWorkspace(tx as unknown as Database,claimed.workspaceId))return;
    const task=await tx.execute(sql`select id from tasks where id=${claimed.taskId} and workspace_id=${claimed.workspaceId} and deleted_at is null and status<>'DELETED' for update`);
    if(!task.length)return;
    const [job]=await tx.select().from(trackingJobs).where(and(eq(trackingJobs.taskId,claimed.taskId),eq(trackingJobs.workspaceId,claimed.workspaceId),
     eq(trackingJobs.revision,claimed.revision),eq(trackingJobs.claimToken,token),sql`${trackingJobs.leaseExpiresAt}>${clock}`)).for('update');
    if(!job)return;
    try{
     const [time]=await tx.execute<{now:string}>(sql`select to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as now`);
     await tx.transaction(savepoint=>evaluateTrackingInTransaction(savepoint as unknown as Database,job.workspaceId,job.taskId,{acknowledge:true,recalculated:true,now:new Date(time!.now)}));
     return {kind:'processed' as const};
    }catch{
     await tx.update(trackingJobs).set({claimToken:null,leaseExpiresAt:null,lastError:'CALCULATION_FAILED',lastErrorAt:clock,
      nextAttemptAt:sql`${clock}+(${Math.min(900,60*2**(job.attempts-1))} * interval '1 second')`,
     }).where(and(eq(trackingJobs.taskId,job.taskId),eq(trackingJobs.workspaceId,job.workspaceId)));
     return {kind:'failed' as const,failure:{workspaceId:job.workspaceId,taskId:job.taskId,revision:job.revision,attempts:job.attempts,error:'CALCULATION_FAILED'}};
    }
   });
}

/** Leased claims persist attempts across process death. Workspace/task locks and
 * claim-token fencing prevent a delayed worker from overwriting newer work.
 */
export async function runTrackingEvaluation(db: Database, workspaceId?: string) {
 const recovered=await recoverTrackingClaims(db,workspaceId);
 const candidates = await scan<{ task_id: string; workspace_id: string }>(db,sql`select task_id,workspace_id from (select j.task_id,j.workspace_id,j.next_attempt_at,j.queued_at,
  row_number() over(partition by j.workspace_id order by j.next_attempt_at,j.queued_at,j.task_id) as turn from tracking_jobs j
  join tasks t on t.id=j.task_id and t.workspace_id=j.workspace_id join workspaces w on w.id=j.workspace_id join users u on u.id=w.owner_id
  where ${scope(workspaceId)} and j.queued_revision>j.acknowledged_revision and j.attempts<6 and j.next_attempt_at<=${clock} and j.claim_token is null
   and t.deleted_at is null and t.status<>'DELETED' and w.deleted_at is null and u.status='ACTIVE' and u.deleted_at is null and u.deletion_requested_at is null
  ) candidates order by turn,next_attempt_at,queued_at,task_id limit ${BATCH}`);
 const result = { processed:0,failed:recovered.failures.filter(f=>f.attempts===6).length,retrying:recovered.failures.filter(f=>f.attempts<6).length,deferred:recovered.deferred,failures:recovered.failures };
 const started=performance.now();
 for(const candidate of candidates){
  if(performance.now()-started>20000)break;
  try{
   // Commit the attempt first. A failed/disconnected claim ACK is safely reclaimed.
   const claimed=await db.transaction(async(tx)=>{
    if(!await lockWorkspace(tx as unknown as Database,candidate.workspace_id))return;
    const task=await tx.execute(sql`select id from tasks where id=${candidate.task_id} and workspace_id=${candidate.workspace_id} and deleted_at is null and status<>'DELETED' for update`);
    if(!task.length)return;
    const [job]=await tx.update(trackingJobs).set({claimToken:randomUUID(),leaseExpiresAt:sql`${clock}+interval '2 minutes'`,
     nextAttemptAt:sql`${clock}+interval '2 minutes'`,attempts:sql`${trackingJobs.attempts}+1`,
    }).where(and(eq(trackingJobs.taskId,candidate.task_id),eq(trackingJobs.workspaceId,candidate.workspace_id),sql`${trackingJobs.queuedRevision}>${trackingJobs.acknowledgedRevision}`,
     sql`${trackingJobs.attempts}<6`,sql`${trackingJobs.nextAttemptAt}<=${clock}`,sql`${trackingJobs.claimToken} is null`)).returning();
    return job;
   });
   if(!claimed)continue;
   const outcome=await finishTrackingClaim(db,claimed);
   if(outcome?.kind==='processed')result.processed++;
   if(outcome?.kind==='failed'){if(outcome.failure.attempts===6)result.failed++;else result.retrying++;result.failures.push(outcome.failure);}
  }catch{result.deferred++;}
 }
 return result;
}

/** A deterministic shared cycle also used by integration/acceptance tests. */
export async function runTrackingCycle(db: Database, workspaceId?: string) {
 const relay = await relayTrackingOutbox(db,workspaceId);
 const reconciliation = await reconcileTracking(db,workspaceId);
 const evaluation = await runTrackingEvaluation(db,workspaceId);
 return { relay,reconciliation,evaluation };
}
