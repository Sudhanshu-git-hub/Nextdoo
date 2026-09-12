import { and, asc, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { AppError, isoDateTime, uuid } from '@nextdoo/contracts';
import { tasks, trackingResults, trackingJobs, recurrenceRules, CALCULATION_VERSION } from '@nextdoo/db';
import { withTransaction } from '../db';
import { loadTask, type TaskActor } from './tasks';
import { getResultForTask, listTrackingEvents } from './tracking';
import { readTrackingFreshness, scoresEnabled } from './tracking-freshness';
import { listTaskCorrections } from './tracking-corrections';
function encode(scope:string,key:unknown) { return Buffer.from(JSON.stringify({ scope,key })).toString('base64url'); }
function decode(scope:string,cursor?:string):unknown {
 if (!cursor) return undefined;
 try { if (cursor.length>1500) throw new Error(); const token=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8')); if(token.scope!==scope) throw new Error(); return token.key; }
 catch { throw new AppError('VALIDATION_FAILED','Invalid tracking cursor. Refresh the list.'); }
}
export function listTrackingStatus(actor:TaskActor,cursor?:string,filter:'all'|'attention'|'failed'='all') {
 return withTransaction(async(db)=>{
  const scope=`tracking-status:${actor.workspaceId}:${filter}`,key=decode(scope,cursor);
  const after=key===undefined?undefined:uuid.parse(key);
  const attention=sql`(${trackingJobs.taskId} is null or ${trackingJobs.lastError} is not null or ${trackingJobs.evaluatedRevision}<>${trackingJobs.revision}
   or ${trackingJobs.calculationVersion}<>${CALCULATION_VERSION} or ${trackingJobs.evaluatedCohortRevision}<>coalesce(${recurrenceRules.trackingRevision},0)
   or ${trackingJobs.nextEvaluationAt}<=clock_timestamp() or ${trackingJobs.leaseExpiresAt}<=clock_timestamp())`;
  const failed=sql`${trackingJobs.attempts}>=6 and (${trackingJobs.claimToken} is null or ${trackingJobs.leaseExpiresAt}<=clock_timestamp())`;
  const rows=await db.select({ id:tasks.id,title:tasks.title }).from(tasks)
   .leftJoin(trackingJobs,and(eq(trackingJobs.taskId,tasks.id),eq(trackingJobs.workspaceId,tasks.workspaceId)))
   .leftJoin(recurrenceRules,and(eq(recurrenceRules.id,tasks.recurrenceRuleId),eq(recurrenceRules.workspaceId,tasks.workspaceId)))
   .where(and(eq(tasks.workspaceId,actor.workspaceId),isNull(tasks.deletedAt),sql`${tasks.status}<>'DELETED'`,filter==='attention'?attention:filter==='failed'?failed:undefined,after?gt(tasks.id,after):undefined)).orderBy(asc(tasks.id)).limit(26);
  const page=rows.slice(0,25),states=await readTrackingFreshness(actor.workspaceId,page.map(t=>t.id));
  return { data:page.map(t=>({...t,freshness:states.get(t.id)!})),pagination:{ has_more:rows.length>25,next_cursor:rows.length>25?encode(scope,page.at(-1)!.id):null } };
 },{ isolationLevel:'repeatable read',accessMode:'read only' });
}
export function getTrackingDetail(actor:TaskActor,taskId:string,eventCursor?:string,historyCursor?:string) {
 return withTransaction(async(db)=>{
  const task=await loadTask(actor.workspaceId,taskId);
  const freshness=(await readTrackingFreshness(actor.workspaceId,[taskId])).get(taskId)!;
  const enabled=await scoresEnabled(actor.userId);
  const empty={ has_more:false,next_cursor:null };
  if (!enabled) return { task:{ id:task.id,title:task.title },freshness,scoresEnabled:false,result:null,events:[],history:[],corrections:[],eventPagination:empty,historyPagination:empty };
  const eventScope=`tracking-events:${actor.workspaceId}:${taskId}`,eventKey=decode(eventScope,eventCursor);
  if (eventKey!==undefined && (typeof eventKey!=='number' || !Number.isSafeInteger(eventKey) || eventKey<0)) throw new AppError('VALIDATION_FAILED','Invalid event cursor.');
  const events=await listTrackingEvents(actor.workspaceId,taskId,eventKey as number|undefined,51);
  const historyScope=`tracking-history:${actor.workspaceId}:${taskId}`,historyKey=decode(historyScope,historyCursor);
  let after;
  if (historyKey!==undefined) {
   if (!Array.isArray(historyKey) || historyKey.length!==2 || typeof historyKey[0]!=='string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(historyKey[0]) || !isoDateTime.safeParse(historyKey[0]).success || historyKey[0].startsWith('0000-')) throw new AppError('VALIDATION_FAILED','Invalid result cursor.');
   after=sql`(${trackingResults.createdAt},${trackingResults.id})<(${historyKey[0]}::timestamptz,${uuid.parse(historyKey[1])}::uuid)`;
  }
  const history=await db.select({ row:trackingResults,key:sql<string>`to_char(${trackingResults.createdAt} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` }).from(trackingResults)
   .where(and(eq(trackingResults.workspaceId,actor.workspaceId),eq(trackingResults.taskId,taskId),after)).orderBy(desc(trackingResults.createdAt),desc(trackingResults.id)).limit(26);
  return { task:{ id:task.id,title:task.title },freshness,scoresEnabled:true,result:await getResultForTask(actor.workspaceId,taskId),
   corrections:await listTaskCorrections(actor.workspaceId,taskId),
   events:events.slice(0,50),eventPagination:{ has_more:events.length>50,next_cursor:events.length>50?encode(eventScope,events[49]!.sequence):null },
   history:history.slice(0,25).map(({row})=>row),historyPagination:{ has_more:history.length>25,next_cursor:history.length>25?encode(historyScope,[history[24]!.key,history[24]!.row.id]):null } };
 },{ isolationLevel:'repeatable read',accessMode:'read only' });
}
