'use client';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { KnowledgePropertyInput, KnowledgeValue } from '@nextdoo/contracts';
import { api, ApiError } from '@/lib/api';
export type Property=KnowledgePropertyInput & {id:string;position:number};
export interface KnowledgeDatabase {id:string;name:string;description:string|null;icon:string|null;color:string|null;version:number;archived:boolean;favorite:boolean;}
export interface KnowledgeItem {id:string;title:string;content:string;version:number;databaseId:string|null;recordId?:string|null;deletedAt:string|null;updatedAt:string;}
export interface RecordRow extends KnowledgeItem {values:Record<string,KnowledgeValue>;referenceCounts:Record<string,number>;}
export interface Page<T> {data:T[];nextOffset:number|null;total?:number;}
export const errorMessage=(e:unknown)=>e instanceof ApiError?e.message:'Could not reach the server. Your draft is kept. Retry when connected.';
export function useKnowledgeRead<T>(path:string) {
  const [data,setData]=useState<T|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[revision,setRevision]=useState(0);
  useEffect(()=>{const c=new AbortController();setLoading(true);setError('');void api<T>(path,{signal:c.signal}).then(d=>{if(!c.signal.aborted)setData(d);}).catch(e=>{if(!c.signal.aborted)setError(errorMessage(e));}).finally(()=>{if(!c.signal.aborted)setLoading(false);});return()=>c.abort();},[path,revision]);
  return {data,error,loading,refresh:useCallback(()=>setRevision(v=>v+1),[])};
}
export function useKnowledgeCommand() {
  const identity=useRef({body:'',key:''}),lock=useRef(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  async function send<T>(path:string,body:object,method='POST'):Promise<T|null> {
    if(lock.current)return null;lock.current=true;setBusy(true);setError('');
    const encoded=JSON.stringify(body),fingerprint=method+path+encoded;
    if(identity.current.body!==fingerprint)identity.current={body:fingerprint,key:crypto.randomUUID()};
    try {const result=await api<T>(path,{method,body:encoded,headers:{'Idempotency-Key':identity.current.key}});identity.current.body='';return result;}
    catch(e){setError(e instanceof ApiError&&e.isConflict?'This item changed elsewhere. Your draft is kept. Use “Reload saved version” to review the latest version before editing again.':errorMessage(e));return null;}
    finally{lock.current=false;setBusy(false);}
  }
  return {send,busy,error};
}
export function KnowledgeStatus({error,loading}:{error?:string;loading?:boolean}) {return <>{loading&&<p role="status">Loading…</p>}{error&&<p role="alert">{error}</p>}</>;}
export function KnowledgePager({offset,nextOffset,setOffset,label='Knowledge pages'}:{offset:number;nextOffset:number|null;setOffset:(value:number)=>void;label?:string}) {return <nav className="row" aria-label={label}><button type="button" disabled={!offset} onClick={()=>setOffset(Math.max(0,offset-40))}>Previous page</button><span>Page {Math.floor(offset/40)+1}</span><button type="button" disabled={nextOffset===null} onClick={()=>setOffset(nextOffset!)}>Next page</button></nav>;}
export function KnowledgeHeader() {return <><Link href="/knowledge">Knowledge &amp; Data</Link><p className="muted">Notes, files and structured records connected to your work. Online connection required; changes are saved to your account.</p></>;}
export function ValueInput({property,value,onChange}:{property:Property;value:KnowledgeValue|undefined;onChange:(value:KnowledgeValue)=>void}) {
  const {type,name,config}=property;
  if(type==='CHECKBOX')return <label className="row"><input type="checkbox" checked={value===true} onChange={e=>onChange(e.target.checked)}/>{name}</label>;
  if(type==='MULTI_SELECT')return <fieldset><legend>{name}</legend>{config.options.map(option=><label className="row" key={option}><input type="checkbox" checked={Array.isArray(value)&&value.includes(option)} onChange={e=>{const prior=Array.isArray(value)?value:[];onChange(e.target.checked?[...prior,option]:prior.filter(v=>v!==option));}}/>{option}</label>)}</fieldset>;
  if(type==='SELECT')return <label>{name}<select value={typeof value==='string'?value:''} onChange={e=>onChange(e.target.value||null)}><option value="">Not set</option>{config.options.map(v=><option key={v}>{v}</option>)}</select></label>;
  if(type==='RICH_TEXT')return <label>{name}<textarea maxLength={20000} value={String(value??'')} onChange={e=>onChange(e.target.value)}/></label>;
  return <label>{name}<input type={type==='NUMBER'?'number':type==='DATE'?'date':type==='URL'?'url':type==='EMAIL'?'email':type==='PHONE'?'tel':'text'} step={type==='NUMBER'?'any':undefined} maxLength={20000} value={String(value??'')} onChange={e=>onChange(e.target.value===''?null:type==='NUMBER'?Number(e.target.value):e.target.value)}/></label>;
}
export function displayValue(value:KnowledgeValue|undefined){return value===null||value===undefined?'—':Array.isArray(value)?value.join(', '):typeof value==='boolean'?value?'Yes':'No':String(value);}
export function KnowledgeBacklinks({kind,id}:{kind:string;id:string}) {
  const [offset,setOffset]=useState(0),[linking,setLinking]=useState(false);const read=useKnowledgeRead<Page<{id:string;title:string;href:string}>>(`/knowledge/backlinks?kind=${kind}&id=${id}&offset=${offset}`);
  return <section className="card" aria-label="Knowledge references"><h3>Knowledge references</h3>{['task','goal','milestone','tracker'].includes(kind)&&<button type="button" onClick={()=>setLinking(v=>!v)}>{linking?'Close reference picker':'Link Knowledge'}</button>}{linking&&<ContextKnowledgeLink kind={kind} id={id} onSaved={()=>{setLinking(false);read.refresh();}}/>}<KnowledgeStatus error={read.error} loading={read.loading}/>{read.data?.data.length===0&&<p className="muted">No linked notes or records yet.</p>}<ul>{read.data?.data.map(r=><li key={r.id}><Link href={r.href}>{r.title}</Link></li>)}</ul>{read.data&&<KnowledgePager offset={offset} nextOffset={read.data.nextOffset} setOffset={setOffset}/>}</section>;
}

/** Commands go to the existing PC3 relation endpoint; there is no new relationship store. */
export function ContextKnowledgeLink({kind,id,onSaved}:{kind:string;id:string;onSaved:()=>void}) {
  const [source,setSource]=useState('record'),[draft,setDraft]=useState(''),[q,setQ]=useState(''),[offset,setOffset]=useState(0),[error,setError]=useState(''),[loading,setLoading]=useState(false);
  const read=useKnowledgeRead<Page<{id:string;label:string}>>(`/knowledge/targets?kind=${source}&q=${encodeURIComponent(q)}&offset=${offset}`),command=useKnowledgeCommand();
  async function link(sourceId:string) {
    setLoading(true);setError('');
    try {const detail=await api<{record?:{version:number};note?:{version:number}}>(`/knowledge/${source}s/${sourceId}`);const version=(detail.record??detail.note)!.version;
      if(await command.send(`/knowledge/${source}s/${sourceId}/relations`,{version,kind,targetId:id,linked:true}))onSaved();
    } catch(e){setError(errorMessage(e));}finally{setLoading(false);}
  }
  return <div><form className="row" aria-label="Link Knowledge" onSubmit={e=>{e.preventDefault();setQ(draft);setOffset(0);}}><label>Knowledge type<select aria-label="Knowledge type" value={source} onChange={e=>{setSource(e.target.value);setOffset(0);}}><option value="record">Record</option><option value="note">Note</option></select></label><label>Find Knowledge<input maxLength={200} value={draft} onChange={e=>setDraft(e.target.value)}/></label><button>Find references</button></form><KnowledgeStatus loading={read.loading} error={read.error||error||command.error}/>{read.data?.data.length===0&&<p className="muted">No matching references. Try another search or create a note or record in Knowledge &amp; Data.</p>}<ul>{read.data?.data.map(item=><li key={item.id}>{item.label} <button type="button" disabled={loading||command.busy} onClick={()=>void link(item.id)}>Link reference {item.label}</button></li>)}</ul>{read.data&&<KnowledgePager offset={offset} nextOffset={read.data.nextOffset} setOffset={setOffset}/>}</div>;
}
