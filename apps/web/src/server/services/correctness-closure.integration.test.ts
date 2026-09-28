import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { calendarConnections, calendarEvents, knowledgeDatabases, knowledgeRecords, subscriptions } from '@nextdoo/db';
import { requireTestDatabase } from '../../../../../tests/database';
import { getDb } from '../db';
import { registerUser } from './accounts';
import { getInsights } from './insights';
import { insightsExport } from './insights-export';
import { setWellbeingPreferences } from './preferences';
import { createKnowledgeDatabase, createKnowledgeRecord, createKnowledgeNote } from './knowledge';
import { knowledgeNoteDetail, listKnowledgeNotes } from './knowledge-query';
import { knowledgeTarget, searchKnowledgeTargets, linkKnowledgeRelation, knowledgeRelationDetails, knowledgeBacklinks } from './knowledge-relations';
import { searchConnected } from './connected';
import { createCalendarSource, saveNativeEvent, updateCalendarSource, deleteNativeEvent } from './calendar-center';

await requireTestDatabase();
async function fixture(timeZone='UTC') {
  const u=await registerUser({email:`closure-${randomUUID()}@test.local`,passwordHash:'test',name:null,timeZone});
  return {userId:u.id,workspaceId:u.workspaceId};
}
it('retains relations but hides archived-parent sources and restores their eligibility',async()=>{
  const a=await fixture(), db=await createKnowledgeDatabase(a,{name:'Closure library'}), record=await createKnowledgeRecord(a,db.id,{title:'Closure record'}), note=await createKnowledgeNote(a,{title:'Closure note',recordId:record.id});
  const source=await createKnowledgeNote(a,{title:'Independent note'});
  await linkKnowledgeRelation(a,'note',source.id,{version:1,kind:'note',targetId:note.id,linked:true});
  await linkKnowledgeRelation(a,'note',note.id,{version:1,kind:'note',targetId:source.id,linked:true});
  expect((await knowledgeBacklinks(a.workspaceId,'note',source.id)).data).toHaveLength(1);
  for(const archived of [true,false]) {
    await getDb().update(knowledgeDatabases).set({archived}).where(eq(knowledgeDatabases.id,db.id));
    expect((await knowledgeTarget(a.workspaceId,'note',note.id,false)).unavailable).toBe(archived);
    expect((await knowledgeRelationDetails(a.workspaceId,'note',source.id)).data[0]!.target.href===null).toBe(archived);
    expect((await searchKnowledgeTargets(a.workspaceId,{kind:'note',q:'Closure note'})).data).toHaveLength(archived?0:1);
    expect((await searchConnected(a.workspaceId,{q:'Closure note'})).data).toHaveLength(archived?0:1);
    expect((await knowledgeBacklinks(a.workspaceId,'note',source.id)).data).toHaveLength(archived?0:1);
    expect((await knowledgeNoteDetail(a.workspaceId,note.id)).parentUnavailable).toBe(archived);
    expect((await listKnowledgeNotes(a.workspaceId,{q:'Closure note'})).data).toHaveLength(archived?0:1);
  }
  await getDb().update(knowledgeRecords).set({deletedAt:new Date()}).where(eq(knowledgeRecords.id,record.id));
  expect((await knowledgeTarget(a.workspaceId,'note',note.id,false)).unavailable).toBe(true);
  expect((await knowledgeRelationDetails(a.workspaceId,'note',source.id)).data).toHaveLength(1);
  expect((await searchConnected(a.workspaceId,{q:'Closure note'})).data).toHaveLength(0);
  await getDb().update(knowledgeRecords).set({deletedAt:null}).where(eq(knowledgeRecords.id,record.id));
  expect((await knowledgeTarget(a.workspaceId,'note',note.id)).unavailable).toBe(false);
  const other=await fixture();
  await expect(knowledgeTarget(other.workspaceId,'note',note.id,false)).rejects.toMatchObject({code:'NOT_FOUND'});
});
it('retained Google mirrors follow connection state without deleting historical relations',async()=>{
  const a=await fixture(),connectionId=randomUUID(),id=randomUUID(),source=await createKnowledgeNote(a,{title:'Calendar reference'});
  await getDb().insert(calendarConnections).values({id:connectionId,userId:a.userId,workspaceId:a.workspaceId,provider:'google',status:'ACTIVE',mode:'READ_ONLY'});
  await getDb().insert(calendarEvents).values({id,workspaceId:a.workspaceId,connectionId,externalId:'closure-event',title:'Closure event',startsAt:new Date(),endsAt:new Date(Date.now()+3600000)});
  await linkKnowledgeRelation(a,'note',source.id,{version:1,kind:'calendar',targetId:id,linked:true});
  for(const status of ['SUSPENDED','DISCONNECTED','ACTIVE'] as const){
    await getDb().update(calendarConnections).set({status}).where(eq(calendarConnections.id,connectionId));
    const active=status==='ACTIVE';
    expect((await searchKnowledgeTargets(a.workspaceId,{kind:'calendar'})).data).toHaveLength(active?1:0);
    expect((await searchConnected(a.workspaceId,{q:'Closure event'})).data).toHaveLength(active?1:0);
    const links=await knowledgeRelationDetails(a.workspaceId,'note',source.id);
    expect(links.data).toHaveLength(1);expect(links.data[0]!.target.unavailable).toBe(!active);
    expect(links.data[0]!.target.href).toBe(active?`/calendar/events/${id}`:null);
  }
});
it('native source archive and restore preserve relation identity',async()=>{
  const a=await fixture(),source=await createCalendarSource(a,{name:'Closure calendar',timeZone:'UTC'});
  const event=await saveNativeEvent(a,null,{sourceId:source.id,title:'Closure appointment',timeZone:'UTC',startsAt:'2026-09-28T12:00:00Z',endsAt:'2026-09-28T13:00:00Z'});
  const note=await createKnowledgeNote(a,{title:'Appointment note'});
  await linkKnowledgeRelation(a,'note',note.id,{version:1,kind:'native_event',targetId:event.id,linked:true});
  await updateCalendarSource(a,source.id,{version:1,archived:true});
  expect((await knowledgeRelationDetails(a.workspaceId,'note',note.id)).data[0]!.target.unavailable).toBe(true);
  expect((await searchKnowledgeTargets(a.workspaceId,{kind:'native_event'})).data).toHaveLength(0);
  await updateCalendarSource(a,source.id,{version:2,archived:false});
  expect((await knowledgeRelationDetails(a.workspaceId,'note',note.id)).data[0]!.target.href).toBe(`/calendar/events/${event.id}`);
  await deleteNativeEvent(a,event.id,1);
  expect((await knowledgeRelationDetails(a.workspaceId,'note',note.id)).data[0]!.target.unavailable).toBe(true);
  expect((await searchConnected(a.workspaceId,{q:'Closure appointment'})).data).toHaveLength(0);
});
it('enforces Free history on standard/custom/comparison reports and export snapshots; paid history remains available',async()=>{
  const a=await fixture(),now=new Date('2026-09-28T12:00:00Z');
  expect((await getInsights(a,{period:'day',date:'2026-09-01'},now)).window.from).toBe('2026-09-01');
  for(const query of [{period:'day',date:'2026-08-01'},{period:'year',date:'2026-09-28'},{period:'custom',from:'2026-08-01',to:'2026-09-01'}]) await expect(getInsights(a,query,now)).rejects.toMatchObject({code:'ENTITLEMENT_LIMIT_REACHED'});
  await setWellbeingPreferences(a.userId,{disableComparativeMetrics:false});
  await expect(getInsights(a,{period:'custom',from:'2026-08-29',to:'2026-09-03',compare:'true'},now)).rejects.toMatchObject({code:'ENTITLEMENT_LIMIT_REACHED'});
  const allowed=await getInsights(a,{period:'day',date:'2026-09-02',compare:'true'},now);
  expect(allowed.comparison?.window.from).toBe('2026-09-01');
  for(const format of ['csv','json'] as const) expect(insightsExport(allowed,format).content).toContain('2026-09-02');
  await getDb().update(subscriptions).set({plan:'PRO',status:'ACTIVE',currentPeriodEnd:new Date(Date.now()+86400000)}).where(eq(subscriptions.userId,a.userId));
  expect((await getInsights(a,{period:'day',date:'2026-08-01'},now)).window.from).toBe('2026-08-01');
});
it('uses the workspace day for the existing inclusive 30-day history cutoff',async()=>{
  const west=await fixture('America/Los_Angeles'),east=await fixture('Asia/Kolkata'),now=new Date('2026-09-28T01:00:00Z');
  expect((await getInsights(west,{period:'day',date:'2026-08-28'},now)).window.from).toBe('2026-08-28');
  await expect(getInsights(east,{period:'day',date:'2026-08-28'},now)).rejects.toMatchObject({code:'ENTITLEMENT_LIMIT_REACHED'});
});
