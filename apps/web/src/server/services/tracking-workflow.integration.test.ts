import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { trackingEvents } from '@nextdoo/db';
import { requireTestDatabase } from '../../../../../tests/database';
import { getDb } from '../db';
import { registerUser } from './accounts';
import { createTask } from './tasks';
import { buildScoringInput } from './tracking';
await requireTestDatabase();
async function fixture() {
 const u = await registerUser({ email: `tracking-${randomUUID()}@test.local`, passwordHash: 'test', name: null, timeZone: 'UTC' });
 const actor = { userId: u.id, workspaceId: u.workspaceId };
 return { actor, task: await createTask(actor, { workspaceId: actor.workspaceId, title: 'Durable tracking', priority: 'NONE', tagIds: [] }) };
}
it('does not treat another workspace event as this task’s scoring input', async () => {
 const own = await fixture(), foreign = await fixture();
 await getDb().insert(trackingEvents).values({ id: randomUUID(), workspaceId: foreign.actor.workspaceId, taskId: own.task.id, type: 'TASK_SKIPPED', occurredAt: new Date(), idempotencyKey: randomUUID() });
 expect((await buildScoringInput(own.actor.workspaceId, own.task.id))?.skipped).toBe(false);
 expect(await getDb().select().from(trackingEvents).where(eq(trackingEvents.workspaceId, foreign.actor.workspaceId))).toHaveLength(2);
});

it('durably evaluates creation once through the real relay and concurrent consumers', async () => {
 const { actor,task } = await fixture();
 const { runTrackingCycle,trackingJobs,trackingResults,trackingOutboxReceipts,outbox } = await import('@nextdoo/db');
 const { readTrackingFreshness } = await import('./tracking-freshness');
 expect((await readTrackingFreshness(actor.workspaceId,[task.id])).get(task.id)?.status).toBe('PENDING');
 const cycles = await Promise.all([runTrackingCycle(getDb(),actor.workspaceId),runTrackingCycle(getDb(),actor.workspaceId)]);
 expect(cycles.reduce((n,c)=>n+c.evaluation.processed,0)).toBe(1);
 expect(await getDb().select().from(trackingResults).where(eq(trackingResults.taskId,task.id))).toHaveLength(1);
 expect((await getDb().select().from(trackingJobs).where(eq(trackingJobs.taskId,task.id)))[0]).toMatchObject({ attempts:0 });
 expect((await readTrackingFreshness(actor.workspaceId,[task.id])).get(task.id)?.status).toBe('FRESH');
 expect(await getDb().select().from(trackingOutboxReceipts).where(eq(trackingOutboxReceipts.workspaceId,actor.workspaceId))).toHaveLength(1);
 expect((await getDb().select().from(outbox).where(eq(outbox.workspaceId,actor.workspaceId)))[0]?.publishedAt).toBeNull();
 await runTrackingCycle(getDb(),actor.workspaceId);
 expect(await getDb().select().from(trackingResults).where(eq(trackingResults.taskId,task.id))).toHaveLength(1);
});
it('hashes all source events in ingestion order, not client time or a 200-event prefix', async () => {
 const { actor,task } = await fixture(); const { runTrackingCycle,trackingResults } = await import('@nextdoo/db');
 const { listTrackingEvents } = await import('./tracking');
 await runTrackingCycle(getDb(),actor.workspaceId);
 const [before] = await getDb().select().from(trackingResults).where(eq(trackingResults.taskId,task.id));
 await getDb().insert(trackingEvents).values(Array.from({ length:205 },(_,i)=>({ id:randomUUID(),workspaceId:actor.workspaceId,taskId:task.id,type:'TASK_STARTED' as const,occurredAt:new Date(0),payload:{ index:i },idempotencyKey:randomUUID() })));
 await runTrackingCycle(getDb(),actor.workspaceId);
 const all = await getDb().select().from(trackingResults).where(eq(trackingResults.taskId,task.id));
 expect(all).toHaveLength(2); expect(all.find(r=>!r.supersededAt)?.inputHash).not.toBe(before?.inputHash);
 expect(all.find(r=>!r.supersededAt)?.inputSnapshot).toMatchObject({ sourceEventCount:206 });
 const first=await listTrackingEvents(actor.workspaceId,task.id),next=await listTrackingEvents(actor.workspaceId,task.id,first.at(-1)!.sequence);
 expect(first[0]?.type).toBe('TASK_CREATED'); expect(first).toHaveLength(200); expect(next).toHaveLength(6);
 expect(new Set([...first,...next].map(e=>e.id)).size).toBe(206);
});
it('crossing a due instant becomes visibly stale and is evaluated without another mutation', async () => {
 const { actor,task }=await fixture(); const { tasks,evaluateTrackingInTransaction,runTrackingCycle }=await import('@nextdoo/db');
 const { readTrackingFreshness }=await import('./tracking-freshness'); const { withWorkspaceTransaction }=await import('./transactions');
 const due=new Date(Date.now()-2000);
 await getDb().update(tasks).set({ dueAt:due }).where(eq(tasks.id,task.id));
 await withWorkspaceTransaction(actor.workspaceId,db=>evaluateTrackingInTransaction(db,actor.workspaceId,task.id,{ now:new Date(due.getTime()-1000) }));
 expect((await readTrackingFreshness(actor.workspaceId,[task.id])).get(task.id)?.status).toBe('PENDING');
 await runTrackingCycle(getDb(),actor.workspaceId);
 expect((await readTrackingFreshness(actor.workspaceId,[task.id])).get(task.id)?.status).toBe('FRESH');
 const { getResultForTask }=await import('./tracking'); expect((await getResultForTask(actor.workspaceId,task.id))?.outcome).toBe('INCOMPLETE');
});
it('saves task work on fast-path failure, isolates poison work, exhausts five retries and recovers explicitly', async () => {
 const { actor,task }=await fixture(); const { completeTask,updateTask }=await import('./tasks');
 const { sql }=await import('drizzle-orm'); const { runTrackingCycle,runTrackingEvaluation,trackingJobs,trackingResults,trackingCorrections }=await import('@nextdoo/db');
 const { readTrackingFreshness,requestTrackingRecalculation }=await import('./tracking-freshness');
 const done=await completeTask(actor,task.id,task.version);
 const [original]=await getDb().select().from(trackingResults).where(eq(trackingResults.taskId,task.id));
 const constraint=`tracking_poison_${randomUUID().replaceAll('-','')}`;
 await getDb().execute(sql.raw(`alter table tracking_results add constraint ${constraint} check(task_id <> '${task.id}') not valid`));
 try {
  await updateTask(actor,task.id,{ version:done.version,estimateMinutes:45 });
  const healthy=await createTask(actor,{ workspaceId:actor.workspaceId,title:'Healthy neighbor',priority:'NONE',tagIds:[] });
  const first=await runTrackingCycle(getDb(),actor.workspaceId);
  expect(first.evaluation).toMatchObject({ processed:1,retrying:1,failed:0 });
  expect((await readTrackingFreshness(actor.workspaceId,[healthy.id])).get(healthy.id)?.status).toBe('FRESH');
  expect((await readTrackingFreshness(actor.workspaceId,[task.id])).get(task.id)).toMatchObject({ status:'RETRYING',attempts:1 });
  expect((await getDb().select().from(trackingResults).where(eq(trackingResults.id,original!.id)))[0]?.supersededAt).toBeNull();
  for (let i=0;i<5;i++) {
   await getDb().update(trackingJobs).set({ nextAttemptAt:sql`clock_timestamp()-interval '1 second'` }).where(eq(trackingJobs.taskId,task.id));
   await runTrackingEvaluation(getDb(),actor.workspaceId);
  }
  expect((await readTrackingFreshness(actor.workspaceId,[task.id])).get(task.id)).toMatchObject({ status:'FAILED',attempts:6 });
  expect((await runTrackingCycle(getDb(),actor.workspaceId)).evaluation.processed).toBe(0);
 } finally { await getDb().execute(sql.raw(`alter table tracking_results drop constraint ${constraint}`)); }
 const state=(await readTrackingFreshness(actor.workspaceId,[task.id])).get(task.id)!;
 await requestTrackingRecalculation(actor,task.id,state.revision,'Retry after calculation recovery');
 await expect(requestTrackingRecalculation(actor,task.id,state.revision,'Stale retry')).rejects.toMatchObject({ code:'RESOURCE_VERSION_CONFLICT' });
 await runTrackingCycle(getDb(),actor.workspaceId);
 expect((await readTrackingFreshness(actor.workspaceId,[task.id])).get(task.id)?.status).toBe('FRESH');
 const history=await getDb().select().from(trackingResults).where(eq(trackingResults.taskId,task.id));
 expect(history).toHaveLength(2); expect(history.find(r=>!r.supersededAt)?.recalculated).toBe(true);
 expect(await getDb().select().from(trackingCorrections).where(eq(trackingCorrections.taskId,task.id))).toHaveLength(1);
});
it('rolls back mutation and its events when durable invalidation cannot commit', async () => {
 const { actor,task }=await fixture(); const { completeTask,loadTask }=await import('./tasks');
 const { sql }=await import('drizzle-orm'); const { trackingJobs,outbox }=await import('@nextdoo/db');
 const [before]=await getDb().select().from(trackingJobs).where(eq(trackingJobs.taskId,task.id));
 const constraint=`tracking_atomic_${randomUUID().replaceAll('-','')}`;
 await getDb().execute(sql.raw(`alter table tracking_jobs add constraint ${constraint} check(task_id <> '${task.id}') not valid`));
 try { await expect(completeTask(actor,task.id,task.version)).rejects.toBeTruthy(); }
 finally { await getDb().execute(sql.raw(`alter table tracking_jobs drop constraint ${constraint}`)); }
 expect((await loadTask(actor.workspaceId,task.id)).status).toBe('ACTIVE');
 expect((await getDb().select().from(trackingJobs).where(eq(trackingJobs.taskId,task.id)))[0]).toEqual(before);
 expect(await getDb().select().from(trackingEvents).where(eq(trackingEvents.taskId,task.id))).toHaveLength(1);
 expect(await getDb().select().from(outbox).where(eq(outbox.workspaceId,actor.workspaceId))).toHaveLength(1);
});
it('coalesces reversed outbox delivery against the latest committed state without rewriting history', async () => {
 const { actor,task }=await fixture(); const { completeTask,reopenTask }=await import('./tasks');
 const { runTrackingCycle,trackingResults,outbox }=await import('@nextdoo/db'); const { sql }=await import('drizzle-orm');
 const done=await completeTask(actor,task.id,task.version); const reopened=await reopenTask(actor,task.id,done.version); await completeTask(actor,task.id,reopened.version);
 const before=await getDb().select().from(trackingResults).where(eq(trackingResults.taskId,task.id));
 await getDb().update(outbox).set({ occurredAt:sql`'2000-01-01'::timestamptz` }).where(sql`${outbox.workspaceId}=${actor.workspaceId} and ${outbox.eventType}='task.completed'`);
 await Promise.all([runTrackingCycle(getDb(),actor.workspaceId),runTrackingCycle(getDb(),actor.workspaceId)]);
 expect(await getDb().select().from(trackingResults).where(eq(trackingResults.taskId,task.id))).toEqual(before);
 expect(before.filter(r=>!r.supersededAt)).toHaveLength(1); expect(before.find(r=>!r.supersededAt)?.score).toBe('100.0');
});
it('refreshes every affected recurrence member, including occurrences generated outside web services', async () => {
 const { actor,task }=await fixture(); const { attachRecurrence }=await import('./recurrence');
 const { generateRecurrenceBatch,runTrackingCycle,tasks,trackingResults }=await import('@nextdoo/db'); const { completeTask }=await import('./tasks');
 const { readTrackingFreshness }=await import('./tracking-freshness');
 await getDb().update(tasks).set({ dueAt:new Date() }).where(eq(tasks.id,task.id));
 const rule=await attachRecurrence(actor,task.id,{ version:task.version,rule:{ freq:'DAILY',interval:1,timeZone:'UTC',count:3 } });
 await generateRecurrenceBatch(getDb(),rule.id); await runTrackingCycle(getDb(),actor.workspaceId);
 const members=await getDb().select().from(tasks).where(eq(tasks.recurrenceRuleId,rule.id));
 expect(members.length).toBeGreaterThan(1);
 const member=members.find(t=>t.id!==task.id)!; const other=members.find(t=>t.id!==member.id)!;
 await completeTask(actor,member.id,member.version);
 expect((await readTrackingFreshness(actor.workspaceId,[other.id])).get(other.id)?.status).toBe('PENDING');
 await runTrackingCycle(getDb(),actor.workspaceId);
 expect((await readTrackingFreshness(actor.workspaceId,members.map(t=>t.id))).get(other.id)?.status).toBe('FRESH');
 expect((await getDb().select().from(trackingResults).where(eq(trackingResults.taskId,other.id))).find(r=>!r.supersededAt)?.inputSnapshot).toMatchObject({ completedOccurrences:1 });
});
it('does not process deleted tasks, inactive owners, or foreign task ids in an outbox envelope', async () => {
 const own=await fixture(),other=await fixture(); const { runTrackingCycle,outbox,users,trackingResults }=await import('@nextdoo/db');
 const { deleteTask }=await import('./tasks'); const { getTrackingDetail }=await import('./tracking-history');
 await getDb().insert(outbox).values({ id:randomUUID(),workspaceId:own.actor.workspaceId,eventType:'task.completed',entityType:'task',entityId:other.task.id });
 await runTrackingCycle(getDb(),own.actor.workspaceId);
 expect(await getDb().select().from(trackingResults).where(eq(trackingResults.taskId,other.task.id))).toHaveLength(0);
 await getDb().update(users).set({ deletionRequestedAt:new Date() }).where(eq(users.id,other.actor.userId));
 expect((await runTrackingCycle(getDb(),other.actor.workspaceId)).evaluation.processed).toBe(0);
 await expect(getTrackingDetail(own.actor,other.task.id)).rejects.toMatchObject({ code:'NOT_FOUND' });
 await deleteTask(own.actor,own.task.id,own.task.version);
 expect((await runTrackingCycle(getDb(),own.actor.workspaceId)).evaluation.processed).toBe(0);
 await expect(getTrackingDetail(own.actor,own.task.id)).rejects.toMatchObject({ code:'NOT_FOUND' });
});
it('exposes paginated immutable evidence and omits scores/explanations when disabled', async () => {
 const { actor,task }=await fixture(); const { getTrackingDetail }=await import('./tracking-history');
 const { userPreferences,runTrackingCycle }=await import('@nextdoo/db');
 await getDb().insert(trackingEvents).values(Array.from({length:51},()=>({ id:randomUUID(),workspaceId:actor.workspaceId,taskId:task.id,type:'TASK_STARTED' as const,occurredAt:new Date(),idempotencyKey:randomUUID() })));
 await runTrackingCycle(getDb(),actor.workspaceId);
 const first=await getTrackingDetail(actor,task.id); expect(first.events).toHaveLength(50);expect(first.eventPagination.has_more).toBe(true);
 const second=await getTrackingDetail(actor,task.id,first.eventPagination.next_cursor!); expect(second.events).toHaveLength(2);
 const other=await fixture(); await expect(getTrackingDetail(other.actor,other.task.id,first.eventPagination.next_cursor!)).rejects.toMatchObject({ code:'VALIDATION_FAILED' });
 await getDb().insert(userPreferences).values({ userId:actor.userId,key:'disableScores',value:true });
 expect(await getTrackingDetail(actor,task.id)).toMatchObject({ scoresEnabled:false,result:null,events:[],history:[] });
});
it('retains distinct accepted task transitions with tied timestamps, including completing again at the same instant',async()=>{
 const {vi}=await import('vitest');const {completeTask,reopenTask,updateTask}=await import('./tasks');
 vi.useFakeTimers({toFake:['Date']});
 try{
  vi.setSystemTime(new Date('2026-09-09T10:00:00Z'));
  const {actor,task}=await fixture();
  const estimated=await updateTask(actor,task.id,{version:task.version,estimateMinutes:10});
  const changed=await updateTask(actor,task.id,{version:estimated.version,estimateMinutes:20});
  const done=await completeTask(actor,task.id,changed.version);const open=await reopenTask(actor,task.id,done.version);
  const again=await completeTask(actor,task.id,open.version);await reopenTask(actor,task.id,again.version);
  const events=await getDb().select().from(trackingEvents).where(eq(trackingEvents.taskId,task.id));
  expect(events).toHaveLength(7);expect(events.filter(e=>e.type==='TASK_COMPLETED')).toHaveLength(2);expect(events.filter(e=>e.type==='ESTIMATE_CHANGED')).toHaveLength(2);expect(events.filter(e=>e.type==='TASK_REOPENED')).toHaveLength(2);
 }finally{vi.useRealTimers();}
});
it('persisted sixth-attempt crash becomes failed after lease expiry, not during a live attempt',async()=>{
 const {actor,task}=await fixture();const {sql}=await import('drizzle-orm');
 const {trackingJobs,relayTrackingOutbox,recoverTrackingClaims,runTrackingCycle}=await import('@nextdoo/db');const {readTrackingFreshness}=await import('./tracking-freshness');
 await relayTrackingOutbox(getDb(),actor.workspaceId);
 await getDb().update(trackingJobs).set({attempts:6,claimToken:randomUUID(),leaseExpiresAt:sql`clock_timestamp()+interval '2 minutes'`}).where(eq(trackingJobs.taskId,task.id));
 expect((await readTrackingFreshness(actor.workspaceId,[task.id])).get(task.id)).toMatchObject({status:'PENDING',processing:true,attempts:6});
 await getDb().update(trackingJobs).set({leaseExpiresAt:sql`clock_timestamp()-interval '2 minutes'`}).where(eq(trackingJobs.taskId,task.id));
 expect((await readTrackingFreshness(actor.workspaceId,[task.id])).get(task.id)).toMatchObject({status:'FAILED',processing:false,errorCode:'WORKER_INTERRUPTED'});
 expect((await recoverTrackingClaims(getDb(),actor.workspaceId)).failures).toHaveLength(1);
 expect((await runTrackingCycle(getDb(),actor.workspaceId)).evaluation.processed).toBe(0);
 expect((await getDb().select().from(trackingJobs).where(eq(trackingJobs.taskId,task.id)))[0]).toMatchObject({attempts:6,claimToken:null,lastError:'WORKER_INTERRUPTED'});
});
it('fences a superseded claim token and a claim invalidated by a newer task version',async()=>{
 const {actor,task}=await fixture();const {sql}=await import('drizzle-orm');const {trackingJobs,trackingResults,relayTrackingOutbox,tasks}=await import('@nextdoo/db');
 const {finishTrackingClaim}=await import('../../../../../packages/db/src/tracking-work');
 await relayTrackingOutbox(getDb(),actor.workspaceId);
 const token=randomUUID();const [old]=await getDb().update(trackingJobs).set({attempts:1,claimToken:token,leaseExpiresAt:sql`clock_timestamp()+interval '2 minutes'`}).where(eq(trackingJobs.taskId,task.id)).returning();
 const replacement=randomUUID();await getDb().update(trackingJobs).set({claimToken:replacement,attempts:2}).where(eq(trackingJobs.taskId,task.id));
 expect(await finishTrackingClaim(getDb(),old!)).toBeUndefined();
 expect(await getDb().select().from(trackingResults).where(eq(trackingResults.taskId,task.id))).toHaveLength(0);
 const [current]=await getDb().select().from(trackingJobs).where(eq(trackingJobs.taskId,task.id));
 await getDb().update(tasks).set({estimateMinutes:30}).where(eq(tasks.id,task.id));
 expect(await finishTrackingClaim(getDb(),current!)).toBeUndefined();
 expect((await getDb().select().from(trackingJobs).where(eq(trackingJobs.taskId,task.id)))[0]).toMatchObject({claimToken:null,attempts:0});
 expect(await getDb().select().from(trackingResults).where(eq(trackingResults.taskId,task.id))).toHaveLength(0);
});
it('bounds engine-upgrade backfill to recent activity/due dates and permits explicit older-task recovery',async()=>{
 const {actor,task}=await fixture();const recent=await createTask(actor,{workspaceId:actor.workspaceId,title:'Recent legacy result',priority:'NONE',tagIds:[]});
 const {sql}=await import('drizzle-orm');const {trackingJobs,trackingResults,reconcileTracking,runTrackingEvaluation}=await import('@nextdoo/db');const {requestTrackingRecalculation}=await import('./tracking-freshness');
 for(const id of [task.id,recent.id]){
  await getDb().insert(trackingResults).values({id:randomUUID(),workspaceId:actor.workspaceId,taskId:id,score:null,outcome:'UNMEASURED',components:[],explanation:'Preserved legacy calculation',measuredWeight:'0',calculationVersion:1,inputHash:'a'.repeat(64)});
  await getDb().update(trackingJobs).set({calculationVersion:1,queuedCalculationVersion:1,queuedRevision:sql`${trackingJobs.revision}`,acknowledgedRevision:sql`${trackingJobs.revision}`,evaluatedRevision:sql`${trackingJobs.revision}`,
   requestedAt:id===task.id?sql`clock_timestamp()-interval '91 days'`:sql`clock_timestamp()`,
  }).where(eq(trackingJobs.taskId,id));
 }
 expect((await reconcileTracking(getDb(),actor.workspaceId)).queued).toBe(1);
 expect((await runTrackingEvaluation(getDb(),actor.workspaceId)).processed).toBe(1);
 expect(await getDb().select().from(trackingResults).where(eq(trackingResults.taskId,recent.id))).toHaveLength(2);
 expect(await getDb().select().from(trackingResults).where(eq(trackingResults.taskId,task.id))).toHaveLength(1);
 const [old]=await getDb().select().from(trackingJobs).where(eq(trackingJobs.taskId,task.id));
 await requestTrackingRecalculation(actor,task.id,old!.revision,'Explicitly review this older task');
 expect((await runTrackingEvaluation(getDb(),actor.workspaceId)).processed).toBe(1);
 expect(await getDb().select().from(trackingResults).where(eq(trackingResults.taskId,task.id))).toHaveLength(2);
});
it('does not silently interpret a future tracking event schema as fresh data',async()=>{
 const {actor,task}=await fixture();const {runTrackingCycle,trackingResults}=await import('@nextdoo/db');const {readTrackingFreshness}=await import('./tracking-freshness');
 await getDb().insert(trackingEvents).values({id:randomUUID(),workspaceId:actor.workspaceId,taskId:task.id,type:'TASK_STARTED',schemaVersion:2,occurredAt:new Date(),idempotencyKey:randomUUID()});
 expect((await runTrackingCycle(getDb(),actor.workspaceId)).evaluation.retrying).toBe(1);
 expect((await readTrackingFreshness(actor.workspaceId,[task.id])).get(task.id)?.status).toBe('RETRYING');
 expect(await getDb().select().from(trackingResults).where(eq(trackingResults.taskId,task.id))).toHaveLength(0);
});
it('commits a new result, freshness checkpoint and result outbox event atomically',async()=>{
 const {actor,task}=await fixture();const {sql}=await import('drizzle-orm');const {outbox,trackingJobs,trackingResults,runTrackingCycle,runTrackingEvaluation}=await import('@nextdoo/db');
 const constraint=`tracking_publication_${randomUUID().replaceAll('-','')}`;
 await getDb().execute(sql.raw(`alter table outbox add constraint ${constraint} check(workspace_id <> '${actor.workspaceId}' OR event_type <> 'tracking.result_created') not valid`));
 try{
  expect((await runTrackingCycle(getDb(),actor.workspaceId)).evaluation.retrying).toBe(1);
  expect(await getDb().select().from(trackingResults).where(eq(trackingResults.taskId,task.id))).toHaveLength(0);
  expect((await getDb().select().from(trackingJobs).where(eq(trackingJobs.taskId,task.id)))[0]).toMatchObject({evaluatedRevision:0,acknowledgedRevision:0,attempts:1});
 }finally{await getDb().execute(sql.raw(`alter table outbox drop constraint ${constraint}`));}
 await getDb().update(trackingJobs).set({nextAttemptAt:sql`clock_timestamp()-interval '1 second'`}).where(eq(trackingJobs.taskId,task.id));
 expect((await runTrackingEvaluation(getDb(),actor.workspaceId)).processed).toBe(1);await runTrackingCycle(getDb(),actor.workspaceId);
 const results=await getDb().select().from(trackingResults).where(eq(trackingResults.taskId,task.id));expect(results).toHaveLength(1);
 expect(await getDb().select().from(outbox).where(eq(outbox.entityId,results[0]!.id))).toHaveLength(1);
});
