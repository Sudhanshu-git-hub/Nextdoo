'use client';
import Link from 'next/link';
import { useCallback,useEffect,useRef,useState } from 'react';
import type { ConnectedDate,ConnectedPage } from '@nextdoo/contracts';
import { api } from '@/lib/api';
import { errorMessage } from './knowledge/shared';
export function useConnectedCalendar(start:string,end:string) {
  const [items,setItems]=useState<ConnectedDate[]>([]),[next,setNext]=useState<number|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false);
  const [layers,setLayers]=useState(['goal','milestone','tracker','record']),request=useRef<AbortController|null>(null);
  const load=useCallback(async(offset=0)=>{
    request.current?.abort();const c=new AbortController();request.current=c;setLoading(true);setError('');if(offset===0){setItems([]);setNext(null);}
    try{const result=await api<ConnectedPage<ConnectedDate>>(`/connected/calendar?${new URLSearchParams({start,end,offset:String(offset)})}`,{signal:c.signal});if(!c.signal.aborted){setItems(old=>offset?[...old,...result.data]:result.data);setNext(result.nextOffset);}}
    catch(e){if(!c.signal.aborted)setError(errorMessage(e));}finally{if(!c.signal.aborted)setLoading(false);}
  },[start,end]);
  useEffect(()=>{void load();const sync=()=>void load();window.addEventListener('nextdoo-synced',sync);return()=>{request.current?.abort();window.removeEventListener('nextdoo-synced',sync);};},[load]);
  return {items:items.filter(i=>layers.includes(i.type)),controls:<section aria-label="Connected calendar layers"><h2>Connected dates</h2><p className="muted">Read-only goal/milestone deadlines, recorded Tracker activity and Knowledge date fields. These do not reserve time or affect capacity. Tracker days retain their tracker time zone; no future tracking sessions are generated.</p><div className="row connected-layers">{[['goal','Goal deadlines'],['milestone','Milestone deadlines'],['tracker','Tracker activity'],['record','Knowledge dates']].map(([type,label])=><label key={type}><input type="checkbox" checked={layers.includes(type!)} onChange={e=>setLayers(old=>e.target.checked?[...old,type!]:old.filter(k=>k!==type))}/>{label}</label>)}<button type="button" disabled={loading} onClick={()=>void load()}>Refresh connected dates</button></div>{error&&<p role="alert">{error}</p>}{loading&&<p role="status">Loading connected dates…</p>}{next!==null&&<button disabled={loading} onClick={()=>void load(next)}>Load more connected dates</button>}{!loading&&!error&&!items.length&&<p className="muted">No connected dates in this period.</p>}</section>};
}
export function ConnectedCalendarItems({items}:{items:ConnectedDate[]}) {return <>{items.map(item=><div className="cal-connected" key={item.type+item.id} aria-label={`${item.detail}: ${item.title}`} onClick={e=>e.stopPropagation()}><Link href={item.href!}>{item.title}</Link><small>{item.detail}</small></div>)}</>;}
