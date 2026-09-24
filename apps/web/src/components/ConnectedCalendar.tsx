'use client';
import Link from 'next/link';
import { useCallback,useEffect,useRef,useState } from 'react';
import type { ConnectedDate,ConnectedPage } from '@nextdoo/contracts';
import { api } from '@/lib/api';
import { errorMessage } from './knowledge/shared';
export function useConnectedCalendar(start:string,end:string) {
  const [items,setItems]=useState<ConnectedDate[]>([]),[error,setError]=useState(''),[loading,setLoading]=useState(false),request=useRef<AbortController|null>(null);
  const load=useCallback(async()=>{
    request.current?.abort();const c=new AbortController();request.current=c;setLoading(true);setError('');setItems([]);
    try{const rows=new Map<string,ConnectedDate>();
      for(let from=Date.parse(start);from<Date.parse(end);){const through=Math.min(from+90*86400000-1,Date.parse(end));let offset:number|null=0;
        while(offset!==null){const result:ConnectedPage<ConnectedDate>=await api<ConnectedPage<ConnectedDate>>(`/connected/calendar?${new URLSearchParams({start:new Date(from).toISOString(),end:new Date(through).toISOString(),offset:String(offset)})}`,{signal:c.signal});if(c.signal.aborted)return;for(const item of result.data)rows.set(item.type+item.id,item);offset=result.nextOffset;}
        from=through+1;
      }
      if(!c.signal.aborted)setItems([...rows.values()]);
    }catch(e){if(!c.signal.aborted)setError(errorMessage(e));}finally{if(!c.signal.aborted)setLoading(false);}
  },[start,end]);
  useEffect(()=>{void load();const sync=()=>void load();window.addEventListener('nextdoo-synced',sync);return()=>{request.current?.abort();window.removeEventListener('nextdoo-synced',sync);};},[load]);
  return {items,loading,controls:<section aria-label="Connected date loading"><p className="muted">Goal and milestone deadlines, recorded Tracker activity and Knowledge dates link to their original items. Tracker dates retain their tracker time zone.</p><button type="button" disabled={loading} onClick={()=>void load()}>Refresh connected dates</button>{error&&<p role="alert">{error}</p>}{loading&&<p role="status">Loading connected dates…</p>}</section>};
}
export function ConnectedCalendarItems({items,color}:{items:ConnectedDate[];color?:(type:string)=>string}) {return <>{items.map(item=><div className="cal-connected" style={color?{borderLeftColor:color(item.type)}:undefined} key={item.type+item.id} aria-label={`${item.detail}: ${item.title}`} onClick={e=>e.stopPropagation()}><Link href={item.href!}>{item.title}</Link><small>{item.detail}</small></div>)}</>;}
