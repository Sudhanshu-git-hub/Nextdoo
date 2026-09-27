'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { ConnectedItem, ConnectedPage } from '@nextdoo/contracts';
import { useKnowledgeRead, KnowledgeStatus, KnowledgePager } from './knowledge/shared';

export function ConnectedLinks({items}:{items:ConnectedItem[]}) {return <ul className="connected-links">{items.map(item=><li key={item.type+item.id}>{item.href&&<Link href={item.href}>{item.title}</Link>}<span className="muted"> · {item.detail}{item.state&&['PAUSED','ARCHIVED','COMPLETED'].includes(item.state)?' · '+item.state.toLowerCase():''}</span></li>)}</ul>;}
interface TodayData {timeZone:string;asOf:string;day:string;upcoming:Section;goals:Section;trackers:Section;knowledge:Section;calendar:Section;dates:Section;}
interface Section {data:ConnectedItem[];hasMore:boolean;}
export function ConnectedToday({revision}:{revision:number}) {
  const read=useKnowledgeRead<TodayData>(`/connected/today?revision=${revision}`);
  useEffect(()=>{const sync=()=>read.refresh();const timer=setInterval(()=>{if(!document.hidden&&navigator.onLine)read.refresh();},30000);window.addEventListener('nextdoo-synced',sync);return()=>{clearInterval(timer);window.removeEventListener('nextdoo-synced',sync);};},[read.refresh]);
  const sections=[['upcoming','Upcoming tasks','/upcoming'],['goals','Goals for your work','/goals'],['trackers','Tracker today','/trackers'],['knowledge','References for your work','/knowledge'],['calendar','Calendar today','/calendar'],['dates','Dates in the next week','/calendar']] as const;
  return <section className="connected-today" aria-label="Connected today"><div className="row"><h2>Your connected day</h2><button type="button" onClick={read.refresh}>Refresh connected day</button></div><p className="muted">Live context alongside your tasks. Tracker activity may take a moment to update after you complete a task. Dates and recorded activity are context, not extra scheduled workload.</p><KnowledgeStatus error={read.error} loading={read.loading}/>{read.data&&!read.error&&<><p className="muted">Updated {new Date(read.data.asOf).toLocaleTimeString()} · {read.data.timeZone}</p><div className="connected-grid">{sections.map(([key,title,href])=><section className="card" key={key} aria-label={title}><h3>{title}</h3><ConnectedLinks items={read.data![key].data}/>{!read.data![key].data.length&&<p className="muted">Nothing to show here today.</p>}<Link href={href}>{read.data![key].hasMore?'See more':'Open'} {title.toLowerCase()}</Link></section>)}</div></>}</section>;
}
export function ConnectedSearch() {
  const params=useSearchParams(),tags=useKnowledgeRead<{data:{id:string;name:string}[]}>('/tags');
  const [tagId,setTagId]=useState(params.get('tagId')??'');
  const [draft,setDraft]=useState(params.get('q')??''),[query,setQuery]=useState(params.get('q')??''),[type,setType]=useState('all'),[offset,setOffset]=useState(0);
  useEffect(()=>{setDraft(params.get('q')??'');setQuery(params.get('q')??'');setTagId(params.get('tagId')??'');setType('all');setOffset(0);},[params]);
  const read=useKnowledgeRead<ConnectedPage<ConnectedItem>>(`/connected/search?q=${encodeURIComponent(query)}&type=${type}&offset=${offset}${tagId?`&tagId=${encodeURIComponent(tagId)}`:''}`);
  return <div><h1>Search NextDoo</h1><p>Find tasks, goals, milestones, trackers, databases, records, notes, projects, lists and saved Calendar events. Archived and deleted items are excluded.</p><form className="row" onSubmit={e=>{e.preventDefault();setQuery(draft);setOffset(0);}}><label>Search all your work<input maxLength={200} value={draft} onChange={e=>setDraft(e.target.value)}/></label><label>Result type<select value={type} onChange={e=>{setType(e.target.value);setOffset(0);}}>{['all','task','goal','milestone','tracker','database','record','note','project','list','calendar'].map(t=><option key={t}>{t}</option>)}</select></label><label>Shared tag<select value={tagId} onChange={e=>{setTagId(e.target.value);setOffset(0);}}><option value="">All tags</option>{tags.data?.data.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label><button>Search</button></form><p className="muted">Shared tags filter Tasks and Notes. Other module labels are separate. Calendar search uses saved events, including hidden sources; no provider refresh is requested.</p><KnowledgeStatus error={read.error||tags.error} loading={read.loading}/>{read.data&&!read.loading&&!read.error&&<><ConnectedLinks items={read.data.data}/>{!read.data.data.length&&<p>No matching items. Try a shorter search or another type.</p>}<KnowledgePager label="Connected work pages" offset={offset} nextOffset={read.data.nextOffset} setOffset={setOffset}/></>}</div>;
}
