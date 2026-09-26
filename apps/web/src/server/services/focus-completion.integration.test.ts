import { randomUUID } from 'node:crypto';
import { expect,it } from 'vitest';
import { eq } from 'drizzle-orm';
import { timerSessions,trackingEvents } from '@nextdoo/db';
import { type MutationInput } from '@nextdoo/contracts';
import { requireTestDatabase } from '../../../../../tests/database';
import { registerUser } from './accounts';
import { createTask,loadTask,completeTask,deleteTask } from './tasks';
import { createTimeEntry,reviseTimeEntry,listTimeEntries,logTime,startTimer,updateTimer } from './timers';
import { pushMutations } from './sync';
import { getInsights } from './insights';
import { homeSummary } from './home';
import { getDb } from '../db';
await requireTestDatabase();
async function fixture(){const user=await registerUser({email:`focus-complete-${randomUUID()}@test.local`,name:null,passwordHash:'test',timeZone:'Asia/Kolkata'});const actor={userId:user.id,workspaceId:user.workspaceId};const task=await createTask(actor,{workspaceId:actor.workspaceId,title:'Focused task',estimateMinutes:60,priority:'HIGH',tagIds:[]});return{actor,task};}
const entry=(taskId:string)=>({taskId,startedAt:'2026-09-24T18:45:00.000Z',endedAt:'2026-09-24T19:30:00.000Z',note:'Research'});
const command=(payload:Record<string,unknown>):MutationInput=>({mutationId:randomUUID(),entityId:randomUUID(),entityType:'timer_session',operation:'update',baseVersion:null,payload,createdAt:new Date().toISOString()});
it('dated manual entries update the same task, Home and Insights data on the workspace date',async()=>{
  const {actor,task}=await fixture();await createTimeEntry(actor,entry(task.id));
  expect((await loadTask(actor.workspaceId,task.id)).actualMinutes).toBe(45);
  const now=new Date('2026-09-25T06:00:00Z');
  expect((await getInsights(actor,{period:'day'},now)).tasks.focusMinutes).toBe(45);
  expect((await homeSummary(actor,now)).focusMinutes).toBe(45);
  expect((await getInsights(actor,{period:'day'},new Date('2026-09-24T06:00:00Z'))).tasks.focusMinutes).toBe(0);
});
it('editing/removing a completed task entry keeps history, rejects stale edits and preserves unrelated entries',async()=>{
  const {actor,task}=await fixture(),first=await createTimeEntry(actor,entry(task.id));
  await createTimeEntry(actor,{...entry(task.id),endedAt:'2026-09-24T19:00:00.000Z'});
  const current=await loadTask(actor.workspaceId,task.id);await completeTask(actor,task.id,current.version);
  await reviseTimeEntry(actor,{entryId:first.entry.id,version:1,startedAt:entry(task.id).startedAt,endedAt:'2026-09-24T19:15:00.000Z',note:'Correct research duration'});
  expect((await loadTask(actor.workspaceId,task.id)).actualMinutes).toBe(45);
  await expect(reviseTimeEntry(actor,{entryId:first.entry.id,version:1,note:'stale'},true)).rejects.toThrow();
  await reviseTimeEntry(actor,{entryId:first.entry.id,version:2,note:'Duplicate record'},true);
  expect((await loadTask(actor.workspaceId,task.id)).actualMinutes).toBe(15);
  expect((await listTimeEntries(actor,task.id)).entries.find(e=>e.id===first.entry.id)).toMatchObject({removed:true,version:3});
  expect((await getDb().select().from(trackingEvents).where(eq(trackingEvents.taskId,task.id))).filter(e=>e.type==='TIME_LOGGED')).toHaveLength(4);
});
it('validates timestamps, ownership and non-negative duration without changing recorded work',async()=>{
  const {actor,task}=await fixture(),other=await fixture();
  for(const change of [{endedAt:entry(task.id).startedAt},{endedAt:'2026-09-24T18:00:00Z'},{startedAt:'invalid'},{endedAt:'2100-01-01T00:00:00Z'}])await expect(createTimeEntry(actor,{...entry(task.id),...change})).rejects.toThrow();
  const saved=await createTimeEntry(actor,entry(task.id));
  await expect(reviseTimeEntry(other.actor,{entryId:saved.entry.id,version:1,note:'wrong owner'},true)).rejects.toThrow();
  expect((await loadTask(actor.workspaceId,task.id)).actualMinutes).toBe(45);
  await deleteTask(actor,task.id);await expect(reviseTimeEntry(actor,{entryId:saved.entry.id,version:1,note:'Deleted task'},true)).rejects.toThrow();
});
it('manual entries and completion replay once, with an atomic stop before task completion',async()=>{
  const {actor,task}=await fixture();const manual=command({action:'entry-create',...entry(task.id)});
  const send=(m:MutationInput)=>pushMutations(actor,{deviceId:'offline',mutations:[m]});
  expect((await send(manual)).results[0]?.status).toBe('applied');expect((await send(manual)).results[0]?.status).toBe('duplicate');
  const timerId=randomUUID(),start={...command({taskId:task.id,startedAt:'2026-09-25T10:00:00Z'}),operation:'create' as const,entityId:timerId};
  expect((await send(start)).results[0]?.status).toBe('applied');
  const latest=await loadTask(actor.workspaceId,task.id),done=command({action:'complete',taskId:task.id,taskVersion:latest.version,timerId,timerVersion:1,at:'2026-09-25T10:05:00Z'});
  expect((await send(done)).results[0]?.status).toBe('applied');expect((await send(done)).results[0]?.status).toBe('duplicate');
  expect(await loadTask(actor.workspaceId,task.id)).toMatchObject({status:'COMPLETED',actualMinutes:50});
  expect((await getDb().select().from(timerSessions).where(eq(timerSessions.id,timerId)))[0]?.status).toBe('STOPPED');
});
it('signed legacy corrections now flow into session-based summaries too',async()=>{
  const {actor,task}=await fixture();await logTime(actor,task.id,5,'Missed work');await logTime(actor,task.id,-2,'Correction');
  expect((await getInsights(actor,{period:'day'})).tasks.focusMinutes).toBe(3);
  expect((await homeSummary(actor)).focusMinutes).toBe(3);
});

it('canonical acknowledgements respect accepted client clock skew for Pomodoro deadlines',async()=>{
  const {actor,task}=await fixture(),start=new Date(Date.now()+5*60000),end=new Date(start.getTime()+60000);
  const timer=await startTimer(actor,task.id,'ahead-clock',start.toISOString());
  expect(timer.observedAt).toBe(start.toISOString());expect(timer.elapsedSeconds).toBe(0);
  const stopped=await updateTimer(actor,timer.id,'stop',end.toISOString(),timer.version);
  expect(stopped.elapsedSeconds).toBe(60);expect(stopped.observedAt).toBe(end.toISOString());
  expect((await loadTask(actor.workspaceId,task.id)).actualMinutes).toBe(1);
});
