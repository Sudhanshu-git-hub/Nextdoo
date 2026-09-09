'use client';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { TrackingFreshness } from '@nextdoo/contracts';
import { api, ApiError } from '@/lib/api';

type Pagination={has_more:boolean;next_cursor:string|null};
type StatusPage={data:{id:string;title:string;freshness:TrackingFreshness}[];pagination:Pagination};
type Result={id:string;score:number|null;outcome:string;explanation:string;calculationVersion:number;recalculated:boolean;createdAt:string;supersededAt?:string|null;inputSnapshot?:unknown;components?:{key:string;value:number|null;reason:string;measured:boolean;weight:number}[]};
type Detail={task:{id:string;title:string};freshness:TrackingFreshness;scoresEnabled:boolean;result:Result|null;events:{id:string;sequence:number;type:string;occurredAt:string;payload:unknown}[];eventPagination:Pagination;history:Result[];historyPagination:Pagination};
const message=(error:unknown)=>error instanceof ApiError?`${error.problem.detail}${error.problem.request_id?` Request ID: ${error.problem.request_id}`:''}`:'The request was not acknowledged. Please retry.';
function Freshness({state}:{state:TrackingFreshness}) {
 return <div role="status" className={state.status==='FRESH'?'muted':'banner'} data-tracking-state={state.status}>
  <strong>{state.status==='FRESH'?'Tracking up to date':state.status==='FAILED'?'Tracking needs attention':state.status==='RETRYING'?(state.processing?'Tracking evaluation in progress':'Tracking delayed — retry scheduled'):'Tracking pending'}</strong>
  {state.status!=='FRESH'&&<p>Task changes are saved. Any stored score below is a previous result, not a confirmed current calculation.</p>}
  {state.evaluatedAt&&<p>Last evaluated: {new Date(state.evaluatedAt).toLocaleString()}</p>}
  {state.processing&&<p>Background evaluation is in progress (attempt {state.attempts} of 6).</p>}
  {state.nextAttemptAt&&<p>Next automatic attempt no earlier than {new Date(state.nextAttemptAt).toLocaleString()}.</p>}
  {state.status==='FAILED'&&<p>Automatic evaluation stopped after the initial attempt and five retries. You can request another evaluation below.</p>}
  {state.reference&&<p>Support reference: <code>{state.reference}</code></p>}
 </div>;
}
export function TrackingPanel({taskId}:{taskId?:string}) {
 return <section className="tracking-panel card" aria-label="Tracking status and evidence">
  <h2>Tracking status and evidence</h2>
  {taskId?<TrackingDetail key={taskId} taskId={taskId}/>:<TrackingList/>}
 </section>;
}
function TrackingList() {
 const [page,setPage]=useState<StatusPage|null>(null),[error,setError]=useState<string|null>(null),[loading,setLoading]=useState(false);
 const active=useRef<AbortController|null>(null);
 const [filter,setFilter]=useState<'all'|'attention'|'failed'>('all');
 const load=useCallback(async(cursor?:string)=>{
  active.current?.abort();const controller=new AbortController();active.current=controller;setLoading(true);setError(null);
  try { const result=await api<StatusPage>(`/tracking/status?filter=${filter}${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`,{signal:controller.signal});
   if(!controller.signal.aborted)setPage(previous=>({...result,data:cursor?[...(previous?.data??[]),...result.data.filter(row=>!previous?.data.some(old=>old.id===row.id))]:result.data}));
  }catch(error){if(!controller.signal.aborted)setError(message(error));}finally{if(!controller.signal.aborted)setLoading(false);}
 },[filter]);
 useEffect(()=>{setPage(null);void load();return()=>active.current?.abort();},[load]);
 return <>
  <p>All non-deleted workspace tasks, including unscheduled work. This list is a snapshot; open a task for automatically refreshed tracking status.</p>
  <label htmlFor="tracking-filter">Filter tracking status</label>
  <select id="tracking-filter" value={filter} onChange={event=>setFilter(event.target.value as typeof filter)}><option value="all">All tasks</option><option value="attention">Not up to date</option><option value="failed">Automatic retries exhausted</option></select>
  <button onClick={()=>void load()}>Refresh status</button>
  {loading&&<p role="status">Loading tracking status…</p>}
  {error&&<p role="alert">{error} Previously loaded rows have been kept.</p>}
  {page?.data.length===0&&<p>No tasks match this status filter. Choose All tasks or add a task to start the planning and review loop.</p>}
  <ul>{page?.data.map(row=><li key={row.id}><Link href={`/analytics?taskId=${row.id}`}>{row.title}</Link> — {row.freshness.status}</li>)}</ul>
  {page?.pagination.next_cursor&&<button disabled={loading} onClick={()=>void load(page.pagination.next_cursor!)}>Load more tracking statuses</button>}
 </>;
}
function TrackingDetail({taskId}:{taskId:string}) {
 const [detail,setDetail]=useState<Detail|null>(null),[error,setError]=useState<string|null>(null),[notice,setNotice]=useState<string|null>(null);
 const [reason,setReason]=useState(''),[saving,setSaving]=useState(false),[loading,setLoading]=useState(false),[paging,setPaging]=useState(false);
 const requests=useRef<Record<string,AbortController>>({});
 const pending=useRef<{key:string;body:string}|null>(null);
 const busy=useRef(new Set<string>()),errorSource=useRef('');
 const url=`/tracking/tasks/${taskId}`;
 const load=useCallback(async(mode:'full'|'poll'|'refresh'|'events'|'history'='full',cursor?:string)=>{
  const slot=mode==='poll'||mode==='refresh'?'full':mode;
  if(mode==='poll'&&busy.current.has('full'))return;
  busy.current.add(slot);
  requests.current[slot]?.abort();
  if(mode==='full'){for(const request of Object.values(requests.current))request.abort();setLoading(true);setPaging(false);}
  if(mode==='events'||mode==='history')setPaging(true);
  const controller=new AbortController();requests.current[slot]=controller;
  try {
   const query=cursor?`?${mode==='events'?'eventCursor':'historyCursor'}=${encodeURIComponent(cursor)}`:'';
   const data=await api<Detail>(url+query,{signal:controller.signal});
   if(controller.signal.aborted)return;
   if(mode==='full'||errorSource.current===mode)setError(null);
   setDetail(previous=>{
    if(!previous||mode==='full'||!data.scoresEnabled)return data;
    if(mode==='poll'||mode==='refresh')return {...previous,freshness:data.freshness,result:data.result,scoresEnabled:data.scoresEnabled};
    if(mode==='events')return {...previous,events:[...previous.events,...data.events.filter(e=>!previous.events.some(old=>old.id===e.id))],eventPagination:data.eventPagination};
    return {...previous,history:[...previous.history,...data.history.filter(r=>!previous.history.some(old=>old.id===r.id))],historyPagination:data.historyPagination};
   });
  }catch(error){if(!controller.signal.aborted){errorSource.current=mode;setError(message(error));}}
  finally{if(requests.current[slot]===controller)busy.current.delete(slot);if(!controller.signal.aborted){if(slot==='full')setLoading(false);if(mode==='events'||mode==='history')setPaging(false);}}
 },[url]);
 useEffect(()=>{
  void load();const interval=setInterval(()=>{if(!document.hidden&&!pending.current)void load('poll');},5000);
  const current=requests.current;
  return()=>{clearInterval(interval);for(const request of Object.values(current))request.abort();};
 },[load]);
 async function recalculate(event:React.FormEvent){
  event.preventDefault();if(!detail)return;
  pending.current??={key:crypto.randomUUID(),body:JSON.stringify({revision:detail.freshness.revision,reason:reason.trim()})};
  setSaving(true);setError(null);setNotice(null);
  try {
   await api(url+'/recalculate',{method:'POST',headers:{'Idempotency-Key':pending.current.key},body:pending.current.body});
   pending.current=null;setReason('');setNotice('Re-evaluation queued. Identical inputs keep the same result and history.');await load('refresh');
  }catch(error){
   if(error instanceof ApiError&&error.problem.status<500){pending.current=null;await load('refresh');}
   errorSource.current='action';setError(message(error));
  }finally{setSaving(false);}
 }
 return <>
  <Link href="/analytics">All tracking statuses</Link>
  <button onClick={()=>void load()} disabled={loading}>Refresh evidence</button>
  {loading&&<p role="status">Loading tracking evidence…</p>}
  {error&&<div role="alert">{error} Status could not be confirmed; any displayed data is the last loaded snapshot. <button onClick={()=>void load()}>Retry loading</button></div>}
  {notice&&<p role="status">{notice}</p>}
  {detail&&<>
   <h3>{detail.task.title}</h3><Freshness state={detail.freshness}/>
   <p className="muted">Status refreshes every five seconds while this tab is visible. Background evaluation requires the worker; this is not a delivery-time guarantee.</p>
   {!detail.scoresEnabled?<p>Numeric scores and explanations are hidden by your stored preference.</p>:<>
    {detail.result?<div><h3>{detail.freshness.status==='FRESH'?'Current stored result':'Previous stored result — stale'}</h3>
     <p>Score: {detail.result.score??'Unmeasured'} · Outcome: {detail.result.outcome}</p><p>{detail.result.explanation}</p>
     <ul>{detail.result.components?.map(c=><li key={c.key}>{c.key}: {c.measured?c.value:'Unmeasured (excluded)'} — {c.reason}</li>)}</ul>
    </div>:<p>No result has been stored yet. Pending evaluation is not a zero or an Unmeasured result.</p>}
    <h3>Source events</h3><p className="muted">Evidence is a loaded snapshot. Refresh evidence after further task changes. Events use server ingestion order, not client timestamps. Legacy ordinals were assigned during migration.</p>
    <ol>{detail.events.map(e=><li key={e.id} data-tracking-event-id={e.id}>{e.type} · {new Date(e.occurredAt).toLocaleString()}<details><summary>Event payload</summary><pre style={{whiteSpace:'pre-wrap'}}>{JSON.stringify(e.payload,null,2)}</pre></details></li>)}</ol>
    {detail.eventPagination.next_cursor&&<button disabled={paging} onClick={()=>void load('events',detail.eventPagination.next_cursor!)}>Load more source events</button>}
    <h3>Calculation history</h3><p>Superseded calculations retain their original inputs. Replaying identical inputs does not add a duplicate result.</p>
    <ul>{detail.history.map(r=><li key={r.id} data-tracking-result-id={r.id}>{new Date(r.createdAt).toLocaleString()} · {r.outcome} · score {r.score??'Unmeasured'} · {r.supersededAt?'Superseded':'Active when evidence loaded'} · engine {r.calculationVersion}{r.recalculated?' · Recalculated':''}<details><summary>Stored calculation inputs</summary><pre style={{whiteSpace:'pre-wrap'}}>{JSON.stringify(r.inputSnapshot,null,2)}</pre></details></li>)}</ul>
    {detail.historyPagination.next_cursor&&<button disabled={paging} onClick={()=>void load('history',detail.historyPagination.next_cursor!)}>Load more calculation history</button>}
   </>}
   <form onSubmit={recalculate}>
    <label htmlFor="tracking-reason">Reason for re-evaluation</label>
    <input id="tracking-reason" value={reason} onChange={e=>setReason(e.target.value)} required maxLength={500} disabled={saving||pending.current!==null}/>
    <p className="muted">Re-evaluates this task’s current inputs; it does not edit due dates or change score rules. Your reason is recorded.</p>
    <button type="submit" disabled={saving||!reason.trim()}>{saving?'Requesting…':pending.current?'Retry same request':'Request re-evaluation'}</button>
   </form>
  </>}
 </>;
}
