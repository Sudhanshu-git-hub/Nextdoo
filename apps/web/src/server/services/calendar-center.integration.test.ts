import { randomUUID } from 'node:crypto';
import { expect,it } from 'vitest';
import { eq } from 'drizzle-orm';
import { calendarNativeEvents,calendarSources,calendarEvents,calendarConnections,users,workspaces,purgeAccount } from '@nextdoo/db';
import { requireTestDatabase } from '../../../../../tests/database';
import { getDb } from '../db';
import { registerUser } from './accounts';
import { connectedToday,connectedCalendar } from './connected';
import { createTask } from './tasks';
import { createGoal,createMilestone } from './goals';
import { buildExport } from './data-rights';
import * as service from './calendar-center';
await requireTestDatabase();
const range={start:'2026-09-01T00:00:00Z',end:'2026-09-30T23:59:59Z'};
async function fixture(){const user=await registerUser({email:`center-${randomUUID()}@test.local`,passwordHash:'test',name:null,timeZone:'UTC'});const actor={userId:user.id,workspaceId:user.workspaceId};const source=await service.createCalendarSource(actor,{name:'Personal',timeZone:'UTC'});return {actor,source};}
const event=(sourceId:string)=>({sourceId,title:'Appointment',startsAt:'2026-09-23T10:00:00Z',endsAt:'2026-09-23T11:00:00Z',timeZone:'UTC'});
const ics=(title='Imported')=>'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:original\r\nDTSTART:20260923T120000Z\r\nDTEND:20260923T130000Z\r\nSUMMARY:'+title+'\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
const imported=(content=ics())=>({name:'College',timeZone:'UTC',content,from:'2026-01-01',through:'2027-01-01'});
it('keeps Google all-day DATE mirrors on their original day west of UTC',async()=>{
  const {actor}=await fixture(),id=randomUUID();
  await getDb().update(workspaces).set({timeZone:'America/Los_Angeles'}).where(eq(workspaces.id,actor.workspaceId));
  await getDb().insert(calendarConnections).values({id,userId:actor.userId,workspaceId:actor.workspaceId,provider:'google',status:'ACTIVE',mode:'READ_ONLY',accessTokenEncrypted:'fixture-only'});
  // Existing provider normalizes Google DATE values to UTC-midnight surrogates.
  await getDb().insert(calendarEvents).values({id:randomUUID(),workspaceId:actor.workspaceId,connectionId:id,calendarId:'primary',externalId:'date',title:'Google holiday',isAllDay:true,startsAt:new Date('2026-09-23T00:00:00Z'),endsAt:new Date('2026-09-24T00:00:00Z')});
  const today={start:'2026-09-23T07:00:00Z',end:'2026-09-24T06:59:59Z'};
  expect((await service.listCenterEvents(actor,today)).data).toMatchObject([{startDay:'2026-09-23',endDay:'2026-09-24'}]);
  expect((await service.listCenterEvents(actor,{start:'2026-09-22T07:00:00Z',end:'2026-09-23T06:59:59Z'})).data).toEqual([]);
});
it('lists virtual defaults without creating rows and persists internal colors/visibility',async()=>{
  const {actor}=await fixture();const before=await getDb().select().from(calendarSources).where(eq(calendarSources.workspaceId,actor.workspaceId));
  expect((await service.listCalendarSources(actor)).filter(s=>s.kind==='INTERNAL')).toHaveLength(5);
  expect(await getDb().select().from(calendarSources).where(eq(calendarSources.workspaceId,actor.workspaceId))).toEqual(before);
  await service.updateCalendarSource(actor,'internal:task',{version:0,color:'#123456',visible:false});
  expect((await service.listCalendarSources(actor)).find(s=>s.id==='internal:task')).toMatchObject({color:'#123456',visible:false,version:1});
  await expect(service.updateCalendarSource(actor,'internal:goal',{version:0,archived:true})).rejects.toMatchObject({code:'VALIDATION_FAILED'});
});
it('creates, moves between owned sources, resizes and deletes a versioned native event',async()=>{
  const {actor,source}=await fixture(),second=await service.createCalendarSource(actor,{name:'Other',timeZone:'UTC'}),row=await service.saveNativeEvent(actor,null,event(source.id));
  const updated=await service.saveNativeEvent(actor,row.id,{version:1,event:{...event(second.id),title:'Moved',startsAt:'2026-09-24T10:00:00Z',endsAt:'2026-09-24T12:30:00Z'}});
  expect(updated).toMatchObject({title:'Moved',sourceId:second.id,version:2});expect((await service.listCenterEvents(actor,range)).data).toHaveLength(1);
  await service.deleteNativeEvent(actor,row.id,2);expect((await service.listCenterEvents(actor,range)).data).toEqual([]);
  await expect(service.loadNativeEvent(actor,row.id)).rejects.toMatchObject({code:'NOT_FOUND'});
});
it('rejects concurrent stale event and source writes',async()=>{
  const {actor,source}=await fixture(),row=await service.saveNativeEvent(actor,null,event(source.id));
  const results=await Promise.allSettled(['A','B'].map(title=>service.saveNativeEvent(actor,row.id,{version:1,event:{...event(source.id),title}})));
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.find(r=>r.status==='rejected')).toMatchObject({reason:{code:'RESOURCE_VERSION_CONFLICT'}});
  const sources=await Promise.allSettled([true,false].map(visible=>service.updateCalendarSource(actor,source.id,{version:1,visible})));
  expect(sources.filter(r=>r.status==='fulfilled')).toHaveLength(1);
});
it('hides and archives without deleting events, restores and keeps Today consistent',async()=>{
  const {actor,source}=await fixture();await service.saveNativeEvent(actor,null,event(source.id));const now=new Date('2026-09-23T09:00:00Z');
  expect((await connectedToday(actor.workspaceId,actor.userId,now)).calendar.data[0]!.title).toBe('Appointment');
  await service.updateCalendarSource(actor,source.id,{version:1,visible:false});expect((await connectedToday(actor.workspaceId,actor.userId,now)).calendar.data).toEqual([]);
  expect((await service.listCenterEvents(actor,range,true)).data).toHaveLength(1);
  await service.updateCalendarSource(actor,source.id,{version:2,archived:true});expect((await service.listCenterEvents(actor,range,true)).data).toEqual([]);
  await expect(service.saveNativeEvent(actor,null,event(source.id))).rejects.toMatchObject({code:'VALIDATION_FAILED'});
  await service.updateCalendarSource(actor,source.id,{version:3,archived:false,visible:true});expect((await service.listCenterEvents(actor,range)).data).toHaveLength(1);
});
it('imports once, updates matching UID in place, rejects native editing and exports an authenticated snapshot',async()=>{
  const {actor}=await fixture(),first=await service.importCalendar(actor,imported()),replay=await service.importCalendar(actor,imported());expect(replay.source.id).toBe(first.source.id);expect(replay.unchanged).toBe(true);
  const before=(await service.listCenterEvents(actor,range)).data[0]!;
  await service.importCalendar(actor,{...imported(ics('Renamed')),sourceId:first.source.id,version:1});const after=(await service.listCenterEvents(actor,range)).data[0]!;
  expect(after).toMatchObject({id:before.id,title:'Renamed',kind:'ICS'});
  await expect(service.saveNativeEvent(actor,after.id,{version:after.version,event:event(first.source.id)})).rejects.toMatchObject({code:'VALIDATION_FAILED'});
  expect(await service.exportCalendar(actor,first.source.id)).toContain('SUMMARY:Renamed');
});
it('rejects malformed imports atomically and isolates native sources, events and downloads',async()=>{
  const a=await fixture(),b=await fixture(),row=await service.saveNativeEvent(a.actor,null,event(a.source.id));
  await expect(service.importCalendar(a.actor,imported('not an ICS'))).rejects.toMatchObject({code:'VALIDATION_FAILED'});
  expect((await service.listCalendarSources(a.actor)).filter(s=>s.kind==='ICS')).toHaveLength(0);
  for(const run of [()=>service.loadNativeEvent(b.actor,row.id),()=>service.exportCalendar(b.actor,a.source.id),()=>service.saveNativeEvent(b.actor,null,event(a.source.id)),()=>service.updateCalendarSource(b.actor,a.source.id,{version:1,name:'Stolen'})])await expect(run()).rejects.toMatchObject({code:'NOT_FOUND'});
  expect((await service.listCenterEvents(b.actor,range)).data).toEqual([]);
  await expect(getDb().insert(calendarNativeEvents).values({id:randomUUID(),workspaceId:b.actor.workspaceId,sourceId:a.source.id,title:'Wrong',startsAt:new Date(range.start),endsAt:new Date(range.end),timeZone:'UTC'})).rejects.toThrow();
});
it('preserves all-day dates across time zones and DST and validates event intervals',async()=>{
  const {actor,source}=await fixture();const row=await service.saveNativeEvent(actor,null,{...event(source.id),startsAt:'2026-03-28T23:00:00Z',endsAt:'2026-03-29T22:00:00Z',timeZone:'Europe/Berlin',isAllDay:true});
  expect(row).toMatchObject({startDay:'2026-03-29',endDay:'2026-03-30'});
  expect((await service.listCenterEvents(actor,{start:'2026-03-29T00:00:00Z',end:'2026-03-29T23:59:59Z'})).data).toHaveLength(1);
  expect((await service.listCenterEvents(actor,{start:'2026-03-28T00:00:00Z',end:'2026-03-28T23:59:59Z'})).data).toHaveLength(0);
  await expect(service.saveNativeEvent(actor,null,{...event(source.id),isAllDay:true})).rejects.toMatchObject({code:'VALIDATION_FAILED'});
  await expect(service.saveNativeEvent(actor,null,{...event(source.id),endsAt:'2026-09-23T09:00:00Z'})).rejects.toThrow();
});
it('surfaces real provider calendar identities individually, isolates visibility, and retains connection errors',async()=>{
  const {actor}=await fixture(),id=randomUUID();await getDb().insert(calendarConnections).values({id,userId:actor.userId,workspaceId:actor.workspaceId,provider:'google',status:'ACTIVE',externalAccountId:'fixture-only@example.test'});
  for(const calendarId of ['primary','existing-secondary-id'])await getDb().insert(calendarEvents).values({id:randomUUID(),workspaceId:actor.workspaceId,connectionId:id,calendarId,externalId:calendarId,title:calendarId,startsAt:new Date('2026-09-23T10:00:00Z'),endsAt:new Date('2026-09-23T11:00:00Z')});
  const google=(await service.listCalendarSources(actor)).filter(s=>s.kind==='GOOGLE');expect(google).toHaveLength(2);
  await service.updateCalendarSource(actor,`google:${id}:primary`,{version:0,visible:false});expect((await service.listCenterEvents(actor,range)).data.map(e=>e.title)).toEqual(['existing-secondary-id']);
  await getDb().update(calendarConnections).set({status:'SUSPENDED',pauseReason:'AUTH_REVOKED'}).where(eq(calendarConnections.id,id));
  expect((await service.listCalendarSources(actor)).find(s=>s.id===`google:${id}:primary`)!.detail).toContain('AUTH_REVOKED');expect((await service.listCenterEvents(actor,range)).data).toEqual([]);
  await getDb().update(calendarConnections).set({status:'ACTIVE',pauseReason:null}).where(eq(calendarConnections.id,id));expect((await service.listCenterEvents(actor,range)).data).toHaveLength(1);
});
it('keeps domain identity and progress ownership when source preferences change',async()=>{
  const {actor}=await fixture();const task=await createTask(actor,{workspaceId:actor.workspaceId,title:'Do',priority:'NONE',tagIds:[],dueAt:'2026-09-23T12:00:00Z'}),goal=await createGoal(actor,{workspaceId:actor.workspaceId,title:'Plan',priority:'NONE',dueAt:'2026-09-23T12:00:00Z'});await createMilestone(actor,goal.id,{title:'Stage',dueAt:'2026-09-23T12:00:00Z'});
  await service.updateCalendarSource(actor,'internal:goal',{version:0,visible:false});
  expect((await connectedCalendar(actor.workspaceId,range)).data.map(i=>i.type)).toEqual(['goal','milestone']);
  expect((await service.listCenterEvents(actor,range)).data).toEqual([]);expect(task.id).not.toBe(goal.id);
});
it('pages events without duplicates and rejects oversized query windows',async()=>{
  const {actor,source}=await fixture();for(let i=0;i<3;i++)await service.saveNativeEvent(actor,null,{...event(source.id),title:String(i)});
  const first=await service.listCenterEvents(actor,{...range,limit:2}),second=await service.listCenterEvents(actor,{...range,offset:first.nextOffset,limit:2});expect(new Set([...first.data,...second.data].map(e=>e.id)).size).toBe(3);expect(second.nextOffset).toBeNull();
  await expect(service.listCenterEvents(actor,{start:range.start,end:'2030-01-01T00:00:00Z'})).rejects.toThrow();
});
it('exports and purges all native/imported account data through existing data rights',async()=>{
  const {actor,source}=await fixture();await service.saveNativeEvent(actor,null,event(source.id));await service.importCalendar(actor,imported());
  const snapshot=await buildExport(actor.userId);expect(snapshot.calendarSources).toHaveLength(2);expect(snapshot.calendarNativeEvents).toHaveLength(2);
  await getDb().update(users).set({deletionRequestedAt:new Date('2000-01-01')}).where(eq(users.id,actor.userId));expect(await purgeAccount(getDb(),actor.userId,new Date())).toBe(true);
  expect(await getDb().select().from(calendarNativeEvents).where(eq(calendarNativeEvents.workspaceId,actor.workspaceId))).toHaveLength(0);
});
