import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { timerSessions, trackingEvents, tasks } from '@nextdoo/db';
import type { MutationInput } from '@nextdoo/contracts';
import { requireTestDatabase } from '../../../../../tests/database';
import { registerUser } from './accounts';
import { createTask, loadTask } from './tasks';
import { pushMutations } from './sync';
import { getDb } from '../db';
import { homeCard, homeSummary } from './home';
import { getPersonalization, setPersonalization } from './personalization';
await requireTestDatabase();
async function fixture() { const user=await registerUser({email:`daily-${randomUUID()}@test.local`,name:null,passwordHash:'test',timeZone:'Asia/Kolkata'});const actor={userId:user.id,workspaceId:user.workspaceId};const task=await createTask(actor,{workspaceId:actor.workspaceId,title:'Daily task',priority:'HIGH',tagIds:[]});return{actor,task}; }
const stamp=(m:number)=>new Date(Date.UTC(2026,8,20,10,m)).toISOString();
const mutation=(entityId:string,operation:'create'|'update',baseVersion:number|null,payload:Record<string,unknown>):MutationInput=>({mutationId:randomUUID(),entityType:'timer_session',entityId,operation,baseVersion,payload,createdAt:stamp(0)});
it('offline timer commands replay once, preserve pauses, and feed the existing task duration',async()=>{
  const {actor,task}=await fixture(),id=randomUUID();
  const mutations=[mutation(id,'create',null,{taskId:task.id,startedAt:stamp(0)}),mutation(id,'update',1,{action:'pause',at:stamp(5)}),mutation(id,'update',2,{action:'resume',at:stamp(15)}),mutation(id,'update',3,{action:'stop',at:stamp(20)})];
  expect((await pushMutations(actor,{deviceId:'offline',mutations})).results.map(r=>r.status)).toEqual(['applied','applied','applied','applied']);
  expect((await pushMutations(actor,{deviceId:'offline',mutations})).results.every(r=>r.status==='duplicate')).toBe(true);
  expect((await loadTask(actor.workspaceId,task.id)).actualMinutes).toBe(10);
  expect(await getDb().select().from(timerSessions).where(eq(timerSessions.id,id))).toHaveLength(1);
  const events=await getDb().select().from(trackingEvents).where(eq(trackingEvents.taskId,task.id));
  expect(events.filter(e=>e.type==='TIME_LOGGED')).toHaveLength(1);
});
it('audited signed adjustments preserve seconds, reject negative totals and deduplicate lost acknowledgements',async()=>{
  const {actor,task}=await fixture();await getDb().update(tasks).set({actualMinutes:2,actualSecondsRemainder:30}).where(eq(tasks.id,task.id));
  const correction=mutation(randomUUID(),'update',null,{action:'adjust',taskId:task.id,minutes:-1,note:'Removed an incorrect minute'});
  const send=(m:MutationInput)=>pushMutations(actor,{deviceId:'manual',mutations:[m]});
  expect((await send(correction)).results[0]?.status).toBe('applied');expect((await send(correction)).results[0]?.status).toBe('duplicate');
  expect(await loadTask(actor.workspaceId,task.id)).toMatchObject({actualMinutes:1,actualSecondsRemainder:30});
  expect((await send(mutation(randomUUID(),'update',null,{action:'adjust',taskId:task.id,minutes:-5,note:'Too much'}))).results[0]?.status).toBe('rejected');
  expect((await send({...correction,payload:{...correction.payload,minutes:10}})).results[0]?.error?.code).toBe('IDEMPOTENCY_CONFLICT');
});
it('timer ownership, stale versions, malformed payloads and future clocks cannot bypass validation',async()=>{
  const a=await fixture(),b=await fixture(),id=randomUUID();
  const start=mutation(id,'create',null,{taskId:a.task.id,startedAt:stamp(0)});
  const send=(actor:typeof a.actor,m:MutationInput)=>pushMutations(actor,{deviceId:'test',mutations:[m]});
  expect((await send(a.actor,start)).results[0]?.status).toBe('applied');
  expect((await send(b.actor,mutation(id,'update',1,{action:'stop',at:stamp(1)}))).results[0]?.status).toBe('rejected');
  expect((await send(a.actor,mutation(id,'update',9,{action:'pause',at:stamp(1)}))).results[0]?.status).toBe('rejected');
  expect((await send(b.actor,mutation(randomUUID(),'create',null,{taskId:a.task.id,startedAt:stamp(0)}))).results[0]?.status).toBe('rejected');
  expect((await send(a.actor,mutation(randomUUID(),'create',null,{taskId:a.task.id,startedAt:'2100-01-01T00:00:00Z'}))).results[0]?.status).toBe('rejected');
});
it('Home uses owned real sources, exact counts and persisted unique card preferences',async()=>{
  const {actor,task}=await fixture(),other=await fixture();
  await getDb().execute(sql`update tasks set due_at='2026-09-25T04:00:00Z' where id=${task.id}`);
  const now=new Date('2026-09-25T06:00:00Z');
  expect((await homeCard(actor,'today',now)).items.map(t=>t.id)).toContain(task.id);
  expect((await homeCard(other.actor,'today',now)).items).toHaveLength(0);
  for(const key of ['upcoming','overdue','priorities','goals','focus','calendar','tracker','knowledge','insights']) expect(await homeCard(actor,key,now)).toHaveProperty('items');
  expect(await homeSummary(actor,now)).toMatchObject({completed:0,upcoming:0,overdue:0});
  await setPersonalization(actor,{homeCards:['notes','today'],startPage:'/home',focusMode:'pomodoro'});
  expect(await getPersonalization(actor)).toMatchObject({homeCards:['notes','today'],startPage:'/home',focusMode:'pomodoro'});
  await expect(setPersonalization(actor,{homeCards:['today','today']})).rejects.toThrow();
  await expect(homeSummary({...actor,userId:other.actor.userId},now)).rejects.toThrow();
});
