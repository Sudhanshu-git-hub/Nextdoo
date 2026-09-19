import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { AppError, type TrackingFreshness } from '@nextdoo/contracts';
import { CALCULATION_VERSION, recurrenceRules, tasks, trackingJobs, trackingCorrections, userPreferences, workspaces } from '@nextdoo/db';
import { getDb } from '../db';
import { newId } from '../ids';
import { withWorkspaceTransaction } from './transactions';
import { loadTask, type TaskActor } from './tasks';
import { writeAudit } from './events';

export async function scoresEnabled(userId: string) {
 const [preference] = await getDb().select({ value:userPreferences.value }).from(userPreferences).where(and(eq(userPreferences.userId,userId),eq(userPreferences.key,'disableScores')));
 return preference?.value !== true;
}

export async function readTrackingFreshness(workspaceId: string, taskIds: string[]): Promise<Map<string,TrackingFreshness>> {
 if (!taskIds.length) return new Map();
 const rows = await getDb().select({ taskId:tasks.id, job:trackingJobs, cohort:recurrenceRules.trackingRevision }).from(tasks)
  .leftJoin(trackingJobs,and(eq(trackingJobs.taskId,tasks.id),eq(trackingJobs.workspaceId,tasks.workspaceId)))
  .leftJoin(recurrenceRules,and(eq(recurrenceRules.id,tasks.recurrenceRuleId),eq(recurrenceRules.workspaceId,tasks.workspaceId)))
  .where(and(eq(tasks.workspaceId,workspaceId),inArray(tasks.id,taskIds),isNull(tasks.deletedAt),sql`${tasks.status}<>'DELETED'`));
 const [clock] = await getDb().execute<{ now: string }>(sql`select to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as now`);
 const now = new Date(clock!.now);
 return new Map(rows.map(({ taskId,job,cohort }) => {
  const expiredClaim = Boolean(job?.claimToken && job.leaseExpiresAt && job.leaseExpiresAt <= now);
  const processing = Boolean(job?.claimToken && !expiredClaim);
  const fresh = job && !job.lastError && !expiredClaim && job.evaluatedRevision===job.revision && job.calculationVersion===CALCULATION_VERSION && job.evaluatedCohortRevision===(cohort??0) && (!job.nextEvaluationAt || job.nextEvaluationAt>now);
  const status = fresh ? 'FRESH' : job && job.attempts>=6 && !processing ? 'FAILED' : job?.lastError || expiredClaim ? 'RETRYING' : 'PENDING';
  return [taskId,{ status,processing,revision:job?.revision??0,attempts:job?.attempts??0,evaluatedAt:job?.evaluatedAt?.toISOString()??null,
   nextEvaluationAt:job?.nextEvaluationAt?.toISOString()??null,nextAttemptAt:status==='RETRYING'&&!processing?job?.nextAttemptAt.toISOString()??null:null,
   errorCode:expiredClaim?'WORKER_INTERRUPTED':job?.lastError??null,reference:job && (job.lastError || expiredClaim)?`tracking-${taskId}-${job.revision}`:null }];
 }));
}

/** Durable, CAS-protected explicit recovery, with actor/reason retained. */
export function requestTrackingRecalculation(actor:TaskActor, taskId:string, revision:number, reason:string) {
 return withWorkspaceTransaction(actor.workspaceId,async(db)=>{
  const [workspace] = await db.select({ id:workspaces.id }).from(workspaces).where(and(eq(workspaces.id,actor.workspaceId),eq(workspaces.ownerId,actor.userId),isNull(workspaces.deletedAt)));
  if (!workspace) throw new AppError('NOT_FOUND','Task not found.');
  const task = await loadTask(actor.workspaceId,taskId);
  const [queued] = await db.update(trackingJobs).set({ revision:sql`${trackingJobs.revision}+1`,queuedRevision:sql`${trackingJobs.revision}+1`,
   claimToken:null,leaseExpiresAt:null,queuedAt:new Date(),nextEvaluationAt:null,nextAttemptAt:new Date(),attempts:0,lastError:null,lastErrorAt:null,
  }).where(and(eq(trackingJobs.taskId,taskId),eq(trackingJobs.workspaceId,actor.workspaceId),eq(trackingJobs.revision,revision))).returning();
  if (!queued) throw new AppError('RESOURCE_VERSION_CONFLICT','Tracking changed. Refresh its status before requesting another evaluation.');
  await db.insert(trackingCorrections).values({ id:newId(),workspaceId:actor.workspaceId,taskId,actorId:actor.userId,kind:'RECALCULATE_TASK',reason,
   payload:{ taskVersion:task.version,revision:queued.revision } });
  await writeAudit(db,{ workspaceId:actor.workspaceId,actorId:actor.userId,action:'tracking.recalculation_requested',targetType:'task',targetId:taskId,
   metadata:{ revision:queued.revision },requestId:actor.requestId });
  return { taskId,revision:queued.revision,status:'PENDING' as const };
 });
}
