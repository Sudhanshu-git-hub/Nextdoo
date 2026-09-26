'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import { api } from '@/lib/api';
import { enqueue, listQueued } from '@/lib/offline-queue';
import { durationLabel, entryLocalTime, workspaceDateTime } from '@/lib/time-entry';
import { useWorkspace } from '../WorkspaceContext';
type Entry={id:string;startedAt:string;endedAt:string;elapsedSeconds:number;version:number;note:string;removed:boolean};
export function TimeEntries({taskId}:{taskId:string}) {
  const {id:workspaceId,timeZone}=useWorkspace();
  const [entries,setEntries]=useState<Entry[]>([]),[more,setMore]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
  const [pending,setPending]=useState(false),generation=useRef(0);
  const [edit,setEdit]=useState<Entry|null>(null),[start,setStart]=useState(''),[end,setEnd]=useState(''),[note,setNote]=useState('');
  const load=useCallback(async()=>{
    const current=++generation.current;
    try{
      const queued=await listQueued(workspaceId,true);
      const waiting=queued.some(q=>String(q.payload.action).startsWith('entry-'));
      if(current!==generation.current)return;if(waiting)setPending(true);
      const result=await api<{entries:Entry[];hasMore:boolean}>(`/time-entries?taskId=${taskId}`);
      if(current!==generation.current)return;setEntries(result.entries);setMore(result.hasMore);setPending(waiting);
    }catch{if(current===generation.current)setError('Entry history is unavailable offline. New entries can still be saved on this device.');}
  },[taskId,workspaceId]);
  useEffect(()=>{setEntries([]);setEdit(null);setError('');void load();const refresh=()=>void load();window.addEventListener('nextdoo-synced',refresh);window.addEventListener('nextdoo-queue-changed',refresh);return()=>{generation.current++;window.removeEventListener('nextdoo-synced',refresh);window.removeEventListener('nextdoo-queue-changed',refresh);};},[load]);
  async function submit(remove=false){
    if(busy||(pending&&edit))return;generation.current++;setBusy(true);setError('');setMessage('');
    try{
      if(!note.trim())throw new Error('Enter a reason or note.');
      const payload:Record<string,unknown>={action:remove?'entry-remove':edit?'entry-edit':'entry-create',note:note.trim()};
      if(edit){payload.entryId=edit.id;payload.version=edit.version;}else payload.taskId=taskId;
      if(!remove){payload.startedAt=workspaceDateTime(start,timeZone);payload.endedAt=workspaceDateTime(end,timeZone);const seconds=(Date.parse(String(payload.endedAt))-Date.parse(String(payload.startedAt)))/1000;if(seconds<=0||seconds>86400)throw new Error('End must follow start, with no more than 24 hours of work.');if(Date.parse(String(payload.endedAt))>Date.now()+15*60000)throw new Error('Entries cannot end in the future.');}
      await enqueue({workspaceId,mutationId:crypto.randomUUID(),entityType:'timer_session',entityId:crypto.randomUUID(),operation:'update',baseVersion:null,payload});
      setPending(true);setMessage('Time entry saved on this device, awaiting sync.');setEdit(null);setStart('');setEnd('');setNote('');
    }catch(e){setError(e instanceof Error?e.message:'Could not save the entry.');}finally{setBusy(false);}
  }
  return <section className="card" aria-label="Task time entries"><h2>{edit?'Correct time entry':'Add time entry'}</h2><p>Dates and times use {timeZone}. Corrections retain an audit history. During a repeated daylight-saving hour, the workspace’s standard time conversion selects the occurrence.</p>
    {error&&<p role="alert">{error}</p>}{message&&<p role="status">{message}</p>}
    <form onSubmit={e=>{e.preventDefault();void submit();}}><div className="row"><label>Entry start<input type="datetime-local" required value={start} onChange={e=>setStart(e.target.value)}/></label><label>Entry end<input type="datetime-local" required value={end} onChange={e=>setEnd(e.target.value)}/></label></div><label>Entry note<textarea required maxLength={500} value={note} onChange={e=>setNote(e.target.value)}/></label><button disabled={busy||(pending&&!!edit)}>{edit?'Save entry correction':'Add time entry'}</button>{edit&&<><button type="button" disabled={busy||pending} onClick={()=>void submit(true)}>Remove this entry</button><button type="button" onClick={()=>{setEdit(null);setStart('');setEnd('');setNote('');}}>Cancel correction</button></>}</form>
    <h3>Manual entry history</h3>{pending&&<p role="status">Entry changes are awaiting sync. Edit again after the current version arrives.</p>}<button onClick={()=>void load()}>Refresh entry history</button>{!entries.length&&<p>No manual entries loaded.</p>}<ul>{entries.map(entry=><li key={entry.id}><span>{entryLocalTime(entry.startedAt,timeZone).replace('T',' ')} · {entry.removed?'Removed':durationLabel(entry.elapsedSeconds)} · {entry.note}</span>{!entry.removed&&<button disabled={busy||pending} onClick={()=>{setEdit(entry);setStart(entryLocalTime(entry.startedAt,timeZone));setEnd(entryLocalTime(entry.endedAt,timeZone));setNote(entry.note);}}>Correct entry</button>}</li>)}</ul>{more&&<p>Showing the latest 50 entries.</p>}
  </section>;
}
