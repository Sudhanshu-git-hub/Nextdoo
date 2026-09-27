'use client';
import Link from 'next/link';
import { useState } from 'react';
import type { CenterEvent,CalendarSource } from '@nextdoo/contracts';
import { useKnowledgeRead,KnowledgeStatus,KnowledgeBacklinks } from './knowledge/shared';
import { CalendarEventDialog } from './CalendarCenter';
export function CalendarEventPage({id}:{id:string}){
 const event=useKnowledgeRead<CenterEvent>('/calendar/center/events/'+id),sources=useKnowledgeRead<{data:CalendarSource[]}>('/calendar/center/sources'),[editing,setEditing]=useState(false);
 return <div><Link href="/calendar">Calendar</Link><h1>Calendar event</h1><KnowledgeStatus error={event.error||sources.error} loading={event.loading||sources.loading}/>{event.data&&!event.error&&<><h2>{event.data.title}</h2><p>{event.data.isAllDay?`${event.data.startDay} – ${event.data.endDay} (end exclusive)`:new Date(event.data.startsAt).toLocaleString(undefined,{timeZone:event.data.timeZone})+' – '+new Date(event.data.endsAt).toLocaleString(undefined,{timeZone:event.data.timeZone})} · {event.data.timeZone}</p><p>{event.data.description}</p><p>{event.data.location}</p>{event.data.taskId&&<Link href={'/tasks/'+event.data.taskId}>Open linked task</Link>}<button disabled={!sources.data} onClick={()=>setEditing(true)}>Open event details</button>{event.data.kind==='NATIVE'&&<KnowledgeBacklinks kind="native_event" id={id} allowLink={sources.data?.data.some(s=>s.id===event.data!.sourceId&&!s.archived)??false}/>} {event.data.kind==='GOOGLE'&&<KnowledgeBacklinks kind="calendar" id={id}/>} {editing&&sources.data&&<CalendarEventDialog event={event.data} sources={sources.data.data} timeZone={event.data.timeZone} onClose={()=>setEditing(false)} onSaved={event.refresh}/>}</>}<button onClick={event.refresh}>Refresh event</button></div>;
}
