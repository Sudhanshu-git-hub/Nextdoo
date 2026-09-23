import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTrackerSchema } from '@nextdoo/contracts';
import { createTrackerDefinition } from '@nextdoo/core';
import { ingestPersonalTrackerEvents, tasks, knowledgeRelations, goalTasks, milestoneTasks, personalTrackerLinks } from '@nextdoo/db';
import { requireTestDatabase } from '../../../../../tests/database';
import { getDb } from '../db';
import { registerUser } from './accounts';
import { createTask, completeTask, deleteTask, restoreTask } from './tasks';
import * as g from './goals';
import * as t from './personal-trackers';
import * as k from './knowledge';
import { knowledgeBacklinks, linkKnowledgeRelation } from './knowledge-relations';
import { searchConnected, connectedTaskContext, connectedToday, connectedCalendar } from './connected';

await requireTestDatabase();
const range={start:'2026-09-01T00:00:00Z',end:'2026-09-30T23:59:59Z'};
async function fixture(timeZone='UTC') {
  const user=await registerUser({email:`connected-${randomUUID()}@test.local`,passwordHash:'test',name:null,timeZone});
  const actor={userId:user.id,workspaceId:user.workspaceId};
  const goal=await g.createGoal(actor,{workspaceId:actor.workspaceId,title:'Learn',priority:'NONE',dueAt:'2026-09-25T12:00:00Z'});
  const milestone=await g.createMilestone(actor,goal.id,{title:'Chapter',dueAt:'2026-09-24T12:00:00Z'});
  const task=await createTask(actor,{workspaceId:actor.workspaceId,title:'Read chapter',priority:'NONE',tagIds:[],dueAt:'2026-09-23T12:00:00Z'});
  await g.linkGoalTask(actor,goal.id,{version:1,taskId:task.id,linked:true});
  await g.linkMilestoneTask(actor,milestone.id,{version:1,taskId:task.id,linked:true});
  const definition=createTrackerDefinition('Reading','minutes');
  definition.fields[0]={...definition.fields[0]!,type:'checkbox',source:'task_completed',unit:''};
  definition.rules=[{id:'done',match:'all',statusId:'excellent',conditions:[{fieldId:'input',operator:'eq',value:true}]}];
  const tracker=await t.createTracker(actor,createTrackerSchema.parse({workspaceId:actor.workspaceId,name:'Reading',startDate:'2026-01-01',timeZone:'UTC',definition}));
  await t.linkTrackerTask(actor,tracker.id,{version:1,taskId:task.id,linked:true});
  const database=await k.createKnowledgeDatabase(actor,{name:'Books',properties:[{name:'Title',type:'TITLE'},{name:'Date',type:'DATE'}]});
  const dateId=database.properties.find(p=>p.type==='DATE')!.id;
  const record=await k.createKnowledgeRecord(actor,database.id,{title:'Chapter reference',values:{[dateId]:'2026-09-24'}});
  return {actor,goal,milestone,task,tracker,database,record,dateId};
}
it('navigates deduplicated Goal/Milestone/Task links and consumes completion only once',async()=>{
  const f=await fixture(),w=f.actor.workspaceId;
  expect((await connectedTaskContext(w,f.task.id)).data.map(i=>i.type)).toEqual(['goal','milestone','tracker']);
  await completeTask(f.actor,f.task.id,1);
  await Promise.all([ingestPersonalTrackerEvents(getDb(),w),ingestPersonalTrackerEvents(getDb(),w)]);
  expect((await g.goalDetail(w,f.goal.id)).progress).toEqual({total:1,completed:1,percent:100});
  expect((await t.trackerDetail(w,f.tracker.id,{})).entries).toHaveLength(1);
  expect(await ingestPersonalTrackerEvents(getDb(),w)).toMatchObject({processed:0});
});
it('reuses versioned Knowledge references for task, goal, milestone and tracker with safe retries',async()=>{
  const f=await fixture();let version=1;
  for(const [kind,targetId] of [['task',f.task.id],['goal',f.goal.id],['milestone',f.milestone.id],['tracker',f.tracker.id]] as const){
    const result=await linkKnowledgeRelation(f.actor,'record',f.record.id,{version,kind,targetId,linked:true});version=result.version;
    expect((await knowledgeBacklinks(f.actor.workspaceId,kind,targetId)).data.some(r=>r.href===`/knowledge/records/${f.record.id}`)).toBe(true);
    expect((await linkKnowledgeRelation(f.actor,'record',f.record.id,{version,kind,targetId,linked:true})).version).toBe(version);
  }
});
it('surfaces due work context, real dates, and references on Today',async()=>{
  const f=await fixture();await linkKnowledgeRelation(f.actor,'record',f.record.id,{version:1,kind:'task',targetId:f.task.id,linked:true});
  const view=await connectedToday(f.actor.workspaceId,f.actor.userId,new Date('2026-09-23T10:00:00Z'));
  expect(view.goals.data.some(i=>i.id===f.goal.id)).toBe(true);
  expect(view.goals.data.some(i=>i.id===f.milestone.id)).toBe(true);
  expect(view.knowledge.data.map(i=>i.id)).toContain(f.record.id);
  expect(view.trackers.data[0]!.detail).toContain('No entry today');
  expect(view.dates.data.map(i=>i.type)).toEqual(['milestone','record','goal']);
});
it('offers stable type-aware search pages and literal wildcard searches',async()=>{
  const f=await fixture(),w=f.actor.workspaceId;
  const all=await searchConnected(w,{});expect(all.data.map(i=>i.type).sort()).toEqual(['database','goal','milestone','record','task','tracker']);
  const first=await searchConnected(w,{limit:2}),second=await searchConnected(w,{limit:2,offset:first.nextOffset});
  expect(new Set([...first.data,...second.data].map(i=>i.id)).size).toBe(4);
  expect((await searchConnected(w,{type:'record',q:'reference'})).data[0]!.href).toBe(`/knowledge/records/${f.record.id}`);
  expect((await searchConnected(w,{q:'%'})).data).toEqual([]);
});
it('isolates all projections and rejects a foreign task context and relation',async()=>{
  const a=await fixture(),b=await fixture();
  expect((await searchConnected(b.actor.workspaceId,{})).data.some(i=>i.id===a.goal.id)).toBe(false);
  expect((await connectedCalendar(b.actor.workspaceId,range)).data.some(i=>i.id===a.goal.id)).toBe(false);
  await expect(connectedTaskContext(b.actor.workspaceId,a.task.id)).rejects.toMatchObject({code:'NOT_FOUND'});
  await expect(linkKnowledgeRelation(b.actor,'record',b.record.id,{version:1,kind:'task',targetId:a.task.id,linked:true})).rejects.toMatchObject({code:'NOT_FOUND'});
});
it('reflects Knowledge deletion, restoration and archived databases without dangling dates',async()=>{
  const f=await fixture(),w=f.actor.workspaceId;
  const deleted=await k.setKnowledgeRecordDeleted(f.actor,f.record.id,1,true);
  expect((await connectedCalendar(w,range)).data.map(i=>i.type)).not.toContain('record');
  await k.setKnowledgeRecordDeleted(f.actor,f.record.id,deleted.version,false);
  expect((await connectedCalendar(w,range)).data.map(i=>i.type)).toContain('record');
  await k.updateKnowledgeDatabase(f.actor,f.database.id,{version:1,archived:true});
  expect((await connectedCalendar(w,range)).data.map(i=>i.type)).not.toContain('record');
  expect((await searchConnected(w,{type:'record'})).data).toEqual([]);
});
it('hides deleted tasks then restores their existing connections',async()=>{
  const f=await fixture();await deleteTask(f.actor,f.task.id,1);
  await expect(connectedTaskContext(f.actor.workspaceId,f.task.id)).rejects.toMatchObject({code:'NOT_FOUND'});
  expect((await searchConnected(f.actor.workspaceId,{type:'task'})).data).toEqual([]);
  await restoreTask(f.actor,f.task.id);
  expect((await connectedTaskContext(f.actor.workspaceId,f.task.id)).data).toHaveLength(3);
});
it('omits archived goals and their milestones from search and Calendar, labels retained task links',async()=>{
  const f=await fixture();await g.setGoalStatus(f.actor,f.goal.id,2,'ARCHIVED');
  expect((await connectedCalendar(f.actor.workspaceId,range)).data.map(i=>i.type)).toEqual(['record']);
  expect((await searchConnected(f.actor.workspaceId,{})).data.map(i=>i.type)).not.toContain('milestone');
  expect((await connectedTaskContext(f.actor.workspaceId,f.task.id)).data.find(i=>i.type==='goal')!.state).toBe('ARCHIVED');
});
it('validates bounded queries before issuing expensive reads',async()=>{
  await expect(searchConnected(randomUUID(),{limit:101})).rejects.toThrow();
  await expect(searchConnected(randomUUID(),{workspaceId:randomUUID()})).rejects.toThrow();
  await expect(connectedCalendar(randomUUID(),{start:range.start,end:'2027-01-01T00:00:00Z'})).rejects.toThrow();
});
it('preserves recorded Tracker dates while paused, hides archived activity, and restores it',async()=>{
  const f=await fixture(),w=f.actor.workspaceId;
  await completeTask(f.actor,f.task.id,1);await ingestPersonalTrackerEvents(getDb(),w);
  const day=new Date().toISOString().slice(0,10),window={start:day+'T00:00:00Z',end:day+'T23:59:59Z'};
  const paused=await t.updateTracker(f.actor,f.tracker.id,{version:2,state:'PAUSED'});
  expect((await connectedCalendar(w,window)).data.find(i=>i.type==='tracker')!.detail).toContain('paused');
  expect((await connectedToday(w,f.actor.userId)).trackers.data).toEqual([]);
  const archived=await t.updateTracker(f.actor,f.tracker.id,{version:paused.version,state:'ARCHIVED'});
  expect((await connectedCalendar(w,window)).data.map(i=>i.type)).not.toContain('tracker');
  expect((await searchConnected(w,{type:'tracker'})).data).toEqual([]);
  await t.updateTracker(f.actor,f.tracker.id,{version:archived.version,state:'ACTIVE'});
  expect((await connectedCalendar(w,window)).data.filter(i=>i.type==='tracker')).toHaveLength(1);
});
it('uses workspace dates for deadlines, keeps date-only values unchanged, and hides hidden properties',async()=>{
  const f=await fixture('Pacific/Auckland'),w=f.actor.workspaceId;
  const page=await connectedCalendar(w,{...range,limit:1});expect(page.nextOffset).toBe(1);
  const all=await connectedCalendar(w,range);
  expect(all.data.find(i=>i.type==='goal')!.day).toBe('2026-09-26');
  expect(all.data.find(i=>i.type==='record')!.day).toBe('2026-09-24');
  await k.saveKnowledgeProperty(f.actor,f.database.id,f.dateId,{version:1,property:{name:'Date',type:'DATE',hidden:true}});
  expect((await connectedCalendar(w,range)).data.map(i=>i.type)).not.toContain('record');
});
it('keeps only the winning concurrent reference update and searches standalone note content',async()=>{
  const f=await fixture();
  const writes=await Promise.allSettled([f.task.id,f.goal.id].map((targetId,index)=>linkKnowledgeRelation(f.actor,'record',f.record.id,{version:1,kind:index?'goal':'task',targetId,linked:true})));
  expect(writes.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect(writes.find(r=>r.status==='rejected')).toMatchObject({reason:{code:'RESOURCE_VERSION_CONFLICT'}});
  const note=await k.createKnowledgeNote(f.actor,{title:'Independent note',content:'Unique full text needle'});
  expect((await searchConnected(f.actor.workspaceId,{q:'full text needle'})).data.map(i=>i.id)).toEqual([note.id]);
  const deleted=await k.setKnowledgeNoteDeleted(f.actor,note.id,1,true);
  expect((await searchConnected(f.actor.workspaceId,{type:'note'})).data).toEqual([]);
  await k.setKnowledgeNoteDeleted(f.actor,note.id,deleted.version,false);
  expect((await searchConnected(f.actor.workspaceId,{type:'note'})).data.map(i=>i.id)).toEqual([note.id]);
});
it('cascades permanent task deletion through existing relations without removing the reference record',async()=>{
  const f=await fixture();await linkKnowledgeRelation(f.actor,'record',f.record.id,{version:1,kind:'task',targetId:f.task.id,linked:true});
  await deleteTask(f.actor,f.task.id,1);
  // Exercise the same FK cascade used by retention after its eligibility checks.
  await getDb().delete(tasks).where(eq(tasks.id,f.task.id));
  expect(await getDb().select().from(knowledgeRelations).where(eq(knowledgeRelations.taskId,f.task.id))).toEqual([]);
  expect(await getDb().select().from(goalTasks).where(eq(goalTasks.taskId,f.task.id))).toEqual([]);
  expect(await getDb().select().from(milestoneTasks).where(eq(milestoneTasks.taskId,f.task.id))).toEqual([]);
  expect(await getDb().select().from(personalTrackerLinks).where(eq(personalTrackerLinks.taskId,f.task.id))).toEqual([]);
  expect((await searchConnected(f.actor.workspaceId,{type:'record'})).data.map(i=>i.id)).toEqual([f.record.id]);
  await expect(connectedTaskContext(f.actor.workspaceId,f.task.id)).rejects.toMatchObject({code:'NOT_FOUND'});
});
