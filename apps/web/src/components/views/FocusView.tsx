'use client';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTaskPages } from '@/lib/use-task-pages';
import { TaskPagination } from '@/components/TaskPagination';
import { api, type Task } from '@/lib/api';
import { enqueue, listQueued, readFocusSnapshot, saveFocusSnapshot, readFocusBreak, saveFocusBreak, dequeue, readCachedTasks, cacheTasks, readPomodoro, savePomodoro, type FocusSnapshot } from '@/lib/offline-queue';
import { focusElapsed, projectFocus } from '@/lib/focus-state';
import { useWorkspace } from '../WorkspaceContext';
import { TimeEntries } from '../focus/TimeEntries';
import { durationLabel } from '@/lib/time-entry';
import { workCycle, breakCycle, readyCycle, workDeadline, type PomodoroState } from '@/lib/pomodoro';
import { dailyFilters, dailyWindow } from '@/lib/daily-tasks';
import { usePersonalization } from '../PersonalizationContext';

export function FocusView({ workspaceId }: { workspaceId: string }) {
  const {timeZone}=useWorkspace();
  const [source,setSource]=useState('all'),[search,setSearch]=useState('');
  const [selectedTask,setSelectedTask]=useState<Task|null>(null),[subtasks,setSubtasks]=useState<Task[]>([]);
  const [cycle,setCycle]=useState<PomodoroState|null>(null);
  const filters=new URLSearchParams({status:'ACTIVE'});
  if(source==='upcoming')for(const [key,value] of dailyFilters('upcoming',new Date(),timeZone))filters.set(key,value);
  if(source==='today'){const day=dailyWindow(new Date(),timeZone);filters.set('dueAfter',day.start.toISOString());filters.set('dueBefore',day.end.toISOString().replace('.999Z','.999999Z'));}
  if(source==='priority')filters.set('priority','HIGH');
  if(source==='project'&&selectedTask?.projectId)filters.set('projectId',selectedTask.projectId);
  if(search.trim())filters.set('q',search.trim());
  const page = useTaskPages(workspaceId, filters.toString(), true);
  const { preferences, save } = usePersonalization();
  const [timer, setTimer] = useState<FocusSnapshot | null>(null), [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null), [pending, setPending] = useState(0), [attention, setAttention] = useState(false);
  const [busy, setBusy] = useState(false), [clock, setClock] = useState(Date.now());
  const [breakEnd, setBreakEnd] = useState<number | null>(null), [selected, setSelected] = useState('');
  const [minutes, setMinutes] = useState(''), [note, setNote] = useState('');
  const inFlight = useRef(false), autoTransition=useRef(false);
  const locked = useCallback(<T,>(fn: () => Promise<T>) => navigator.locks ? navigator.locks.request(`nextdoo-sync:${workspaceId}`, fn) : fn(), [workspaceId]);
  const readLocal = useCallback(async () => {
    const queued = (await listQueued(workspaceId, true)).filter(q => q.entityType === 'timer_session');
    const projected = projectFocus(await readFocusSnapshot(workspaceId), queued);
    setTimer(projected); setPending(queued.length); setAttention(queued.some(q => q.quarantined));
    const savedCycle=await readPomodoro(workspaceId);setCycle(savedCycle);
    setBreakEnd(savedCycle && ['short-break','long-break'].includes(savedCycle.phase) ? savedCycle.deadline ?? Date.now()+(savedCycle.remaining??0) : await readFocusBreak(workspaceId));
    return { queued, projected };
  }, [workspaceId]);
  const load = useCallback(async () => {
    try { await locked(async () => {
      const { queued } = await readLocal();
      if (!queued.length && navigator.onLine) {
        const response = await api<{ timer: FocusSnapshot | null }>('/timers');
        await saveFocusSnapshot(workspaceId, response.timer?.workspaceId && response.timer.workspaceId!==workspaceId ? null : response.timer); await readLocal();
      }
    }); } catch { setError('Could not refresh the server session. Saved local actions remain on this device.'); }
    finally { setLoading(false); }
  }, [locked, readLocal, workspaceId]);
  useEffect(() => { setSelected(new URLSearchParams(window.location.search).get('taskId') ?? ''); void load(); }, [load]);
  useEffect(() => {
    const refresh = () => { void load(); };
    const synced = () => { void load(); void page.reload(); };
    const tick = setInterval(() => setClock(Date.now()), 1000), poll = setInterval(refresh, 15000);
    window.addEventListener('nextdoo-synced', synced); window.addEventListener('nextdoo-queue-changed', refresh); window.addEventListener('focus', refresh);
    return () => { clearInterval(tick); clearInterval(poll); window.removeEventListener('nextdoo-synced', synced); window.removeEventListener('nextdoo-queue-changed', refresh); window.removeEventListener('focus', refresh); };
  }, [load, page.reload]);
  async function command(action: 'start' | 'pause' | 'resume' | 'stop' | 'adjust', taskId?: string, takeBreak = false, deadline?:number) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(null);
    try {
      await locked(async () => {
        const { queued, projected } = await readLocal();
        if (queued.some(q => q.quarantined)) throw new Error('Review rejected actions before recording more time.');
        const at = new Date(deadline??Date.now()).toISOString();
        if (action === 'start' && projected) throw new Error('Stop the current session first.');
        if (!['start','adjust'].includes(action) && !projected) throw new Error('The session changed. Refresh before continuing.');
        const adjustment = Number(minutes);
        if (action === 'adjust' && (!taskId || !Number.isInteger(adjustment) || !adjustment || Math.abs(adjustment) > 1440 || !note.trim())) throw new Error('Choose a task, a nonzero adjustment up to 1,440 minutes, and a reason.');
        const id=action==='start'||action==='adjust'?crypto.randomUUID():projected!.id;
        const savedCycle=await readPomodoro(workspaceId);
        const nextCycle=action==='start' ? preferences.focusMode==='pomodoro'?workCycle(savedCycle,taskId!,id,preferences):null : takeBreak&&savedCycle ? breakCycle(savedCycle,preferences,Date.parse(at)) : action==='stop'&&savedCycle ? {...savedCycle,phase:'ready' as const,timerId:undefined} : savedCycle;
        await savePomodoro(workspaceId,nextCycle,{ workspaceId, mutationId: crypto.randomUUID(), entityType: 'timer_session',
          entityId:id,
          operation: action === 'start' ? 'create' : 'update', baseVersion: action === 'start' || action === 'adjust' ? null : projected!.version,
          payload: action === 'start' ? { taskId, startedAt: at } : action === 'adjust' ? { action, taskId, minutes: adjustment, note: note.trim() } : { action, at } });
        if (action === 'start') await saveFocusBreak(workspaceId, null);
        if (takeBreak && !savedCycle) await saveFocusBreak(workspaceId, Date.now() + preferences.breakMinutes * 60000);
        if(action==='start'&&taskId)setSelected(taskId);
        await readLocal();
      });
      if (action === 'adjust') { setMinutes(''); setNote(''); }
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not save the action on this device.'); }
    finally { inFlight.current = false; setBusy(false); }
  }
  const elapsed = timer ? focusElapsed(timer, clock) : 0, breaking = breakEnd !== null;
  const displayed = breaking ? Math.max(0, Math.ceil((cycle?.remaining??(breakEnd - clock)) / 1000)) : preferences.focusMode === 'pomodoro' && timer ? Math.max(0, (cycle?.targetSeconds??preferences.focusMinutes * 60) - elapsed) : elapsed;
  const task = page.tasks.find(t => t.id === timer?.taskId) ?? selectedTask;
  const shownTaskId=timer?.taskId??selected;
  const selectedRef=useRef(shownTaskId);selectedRef.current=shownTaskId;
  const preferenceError = () => setError('Could not save timer preferences.');
  const loadSelected=useCallback(async()=>{
    if(!shownTaskId){setSelectedTask(null);setSubtasks([]);return;}
    try {const [detail,children]=await Promise.all([api<Task>(`/tasks/${shownTaskId}`),api<{data:Task[]}>(`/tasks?workspaceId=${workspaceId}&parentTaskId=${shownTaskId}&limit=100`)]);if(selectedRef.current!==shownTaskId)return;setSelectedTask(detail);setSubtasks(children.data);await cacheTasks(workspaceId,[detail,...children.data]);}
    catch{const cached=await readCachedTasks<Task>(workspaceId);if(selectedRef.current!==shownTaskId)return;setSelectedTask(cached.find(t=>t.id===shownTaskId)??null);setSubtasks(cached.filter(t=>t.parentTaskId===shownTaskId));}
  },[shownTaskId,workspaceId]);
  useEffect(()=>{void loadSelected();const refresh=()=>void loadSelected();window.addEventListener('nextdoo-synced',refresh);return()=>window.removeEventListener('nextdoo-synced',refresh);},[loadSelected]);
  async function complete(task:Task){
    if(busy)return;setBusy(true);setError(null);
    try{await locked(async()=>{const {projected}=await readLocal();const active=projected?.taskId===task.id?projected:null;
      await enqueue({workspaceId,mutationId:crypto.randomUUID(),entityType:'timer_session',entityId:crypto.randomUUID(),operation:'update',baseVersion:null,
        payload:{action:'complete',taskId:task.id,taskVersion:task.version,at:new Date().toISOString(),...(active?{timerId:active.id,timerVersion:active.version}:{})}});
      await readLocal();});
    }catch(e){setError(e instanceof Error?e.message:'Could not save completion.');}finally{setBusy(false);}
  }
  async function changeBreak(action:'pause'|'resume'|'end'){
    try{await locked(async()=>{const current=await readPomodoro(workspaceId);
      if(current&&['short-break','long-break'].includes(current.phase)){const next=action==='end'?readyCycle(current):action==='pause'?{...current,remaining:Math.max(0,(current.deadline??Date.now())-Date.now()),deadline:null}:{...current,deadline:Date.now()+(current.remaining??0),remaining:null};await savePomodoro(workspaceId,next);}
      if(action==='end')await saveFocusBreak(workspaceId,null);await readLocal();});}catch{setError('Could not save the break.');}
  }
  useEffect(()=>{
    if(loading||busy||attention||autoTransition.current)return;
    const deadline=workDeadline(cycle,timer,clock);
    if(deadline!==null){void command('stop',undefined,true,deadline);return;}
    if(cycle&&['short-break','long-break'].includes(cycle.phase)&&cycle.deadline!==null&&clock>=cycle.deadline&&preferences.focusAutoStart){
      autoTransition.current=true;void changeBreak('end').then(()=>command('start',cycle.taskId)).finally(()=>{autoTransition.current=false;});
    }
  });

  return <><div className="page-head"><div><h1>Focus</h1><p className="subtitle">One task at a time. Work is recorded on the existing task; breaks never count as work.</p></div></div>
    {error && <p className="banner banner-error" role="alert">{error}</p>}
    {pending > 0 && <p role="status">{pending} focus action{pending === 1 ? '' : 's'} saved on this device, awaiting sync.</p>}
    {attention && <div className="banner banner-warn"><p>A session changed or an action was rejected. Local commands are preserved in <Link href="/conflicts">Sync conflicts</Link>. Review before discarding.</p><button onClick={async () => { await locked(async () => { for (const q of await listQueued(workspaceId, true)) if (q.entityType === 'timer_session') await dequeue(workspaceId, q.mutationId); }); await load(); }}>Discard pending focus actions and use server session</button></div>}
    <div className="card focus-card"><div className="row">
      <label>Timer mode<select value={preferences.focusMode} disabled={loading || busy || !!timer || breaking} onChange={e => { void save({ focusMode: e.target.value as 'stopwatch' | 'pomodoro' }).catch(preferenceError); }}><option value="stopwatch">Stopwatch</option><option value="pomodoro">Pomodoro</option></select></label>
      {preferences.focusMode === 'pomodoro' && <><label>Work minutes<input type="number" min={1} max={180} value={preferences.focusMinutes} disabled={!!timer || busy} onChange={e => { const n = Number(e.target.value); if (n >= 1 && n <= 180) void save({ focusMinutes: n }).catch(preferenceError); }}/></label><label>Break minutes<input type="number" min={1} max={60} value={preferences.breakMinutes} disabled={breaking || busy} onChange={e => { const n = Number(e.target.value); if (n >= 1 && n <= 60) void save({ breakMinutes: n }).catch(preferenceError); }}/></label></>}
      {preferences.focusMode==='pomodoro'&&<><label>Long break minutes<input type="number" min={1} max={120} value={preferences.longBreakMinutes} disabled={!!timer||breaking} onChange={e=>{const n=Number(e.target.value);if(n>=1&&n<=120)void save({longBreakMinutes:n}).catch(preferenceError);}}/></label><label>Sessions before long break<input type="number" min={1} max={12} value={preferences.sessionsBeforeLongBreak} disabled={!!timer||breaking} onChange={e=>{const n=Number(e.target.value);if(n>=1&&n<=12)void save({sessionsBeforeLongBreak:n}).catch(preferenceError);}}/></label><label><input type="checkbox" checked={preferences.focusAutoStart} onChange={e=>void save({focusAutoStart:e.target.checked}).catch(preferenceError)}/>Auto-start next work session</label><p role="status">Session {cycle?.session??1} · {cycle?.phase==='long-break'?'Long break':cycle?.phase==='short-break'?'Short break':'Work'}</p><p>Work ends at its deadline. Breaks do not count as work. Auto-start begins when this app is available, without creating unattended past sessions.</p></>}
    </div><div className="focus-clock" role="timer" aria-live="off">{formatClock(displayed)}</div>
    <p className="subtitle">{breaking ? displayed ? 'Break — no work time is recorded' : 'Break complete' : timer ? `${timer.status === 'RUNNING' ? 'Running' : 'Paused'} · ${task?.title ?? 'Task'}` : 'No timer running'}</p>
    {timer && preferences.focusMode === 'pomodoro' && elapsed >= (cycle?.targetSeconds??preferences.focusMinutes*60) && <p role="status">Work interval complete. Saving the interval…</p>}
    <div className="row">
      {timer?.status === 'RUNNING' && <button disabled={busy || attention} onClick={() => command('pause')}>Pause</button>}
      {timer?.status === 'PAUSED' && <button disabled={busy || attention} onClick={() => command('resume')}>Resume</button>}
      {timer && <button disabled={busy || attention} onClick={() => command('stop')}>Stop and save</button>}
      {preferences.focusMode==='pomodoro'&&timer&&<button disabled={busy||attention} onClick={()=>void command('stop',undefined,true)}>Skip work session</button>}{timer && preferences.focusMode === 'pomodoro' && <button disabled={busy || attention} onClick={() => command('stop', undefined, true)}>Finish work and take a break</button>}
      {breaking && <><button onClick={()=>void changeBreak('end')}>End break</button>{cycle&&<button onClick={()=>void changeBreak(cycle.remaining===null?'pause':'resume')}>{cycle.remaining===null?'Pause break':'Resume break'}</button>}</>}
      <button disabled={busy} onClick={load}>Refresh session</button>
    </div></div>
    {selectedTask&&<section className="card" aria-label="Selected focus task"><h2>{selectedTask.title}</h2><p>Status: {selectedTask.status==='COMPLETED'?'Completed':'Active'}</p><div className="home-stats focus-times"><div><strong>{durationLabel(selectedTask.actualSeconds+(timer?.taskId===selectedTask.id?elapsed:0))}</strong><span>Actual time</span></div><div><strong>{selectedTask.estimateMinutes===null?'Not planned':durationLabel(selectedTask.estimateMinutes*60)}</strong><span>Planned time</span></div></div><p>Saved work plus the current session. Pending changes reconcile after sync.</p><Link href={`/tasks/${selectedTask.id}`}>Open task details</Link> <button disabled={busy||attention||selectedTask.status!=='ACTIVE'} onClick={()=>void complete(selectedTask)}>Complete task</button><h3>Subtasks</h3>{!subtasks.length&&<p>No subtasks.</p>}<ul>{subtasks.map(child=><li key={child.id}><Link href={`/tasks/${child.id}`}>{child.title}</Link> · {child.status==='COMPLETED'?'Completed':'Active'} {child.status==='ACTIVE'&&<button disabled={busy||attention} onClick={()=>void complete(child)}>Complete subtask {child.title}</button>}</li>)}</ul></section>}
    <h2>Start a session</h2>{!shownTaskId&&<p>Choose a task to begin focusing.</p>}<div className="row"><label>Focus task source<select value={source} onChange={e=>setSource(e.target.value)}><option value="all">Active tasks</option><option value="today">Today</option><option value="upcoming">Upcoming</option><option value="priority">Priority tasks</option>{selectedTask?.projectId&&<option value="project">Current project</option>}</select></label><label>Find a focus task<input type="search" value={search} onChange={e=>setSearch(e.target.value)}/></label></div>{loading && <p role="status">Loading session…</p>}
    {page.stale && <p>Showing cached tasks. Focus actions are saved on this device until connected.</p>}
    {selected && !page.tasks.some(t => t.id === selected) && <p><Link href={`/tasks/${encodeURIComponent(selected)}`}>Open selected task</Link> · <button disabled={busy || loading || !!timer || attention || breaking} onClick={() => command('start', selected)}>Start selected task</button></p>}
    <ul className="focus-tasks">{[...page.tasks].sort((a,b) => Number(b.id === selected) - Number(a.id === selected)).map(t => <li className="task-row" key={t.id}><div className="task-main"><button disabled={!!timer} onClick={()=>setSelected(t.id)} aria-pressed={selected===t.id}>{t.title}</button><p className="task-meta">{t.estimateMinutes !== null ? `Estimated ${t.estimateMinutes}m · ` : ''}Recorded {t.actualMinutes}m</p></div><button aria-label={`Start a focus timer for ${t.title}`} disabled={busy || loading || !!timer || attention || breaking} onClick={() => command('start', t.id)}>Start</button></li>)}</ul>
    {!page.loading && !page.tasks.length && <p>No active tasks. Add one from Inbox or Today.</p>}
    <TaskPagination {...page} count={page.tasks.length} onMore={page.loadMore} onRetry={page.tasks.length ? page.loadMore : page.reload}/>
    {shownTaskId&&<TimeEntries key={shownTaskId} taskId={shownTaskId}/>}
    <form className="card" onSubmit={e => { e.preventDefault(); void command('adjust', selected); }}><h2>Manual time correction</h2><p>Add missed time or subtract incorrectly recorded time. Every adjustment is audited. Negative totals are rejected.</p>
      <label>Task for correction<select required value={selected} onChange={e => setSelected(e.target.value)}><option value="">Choose a task</option>{selected && !page.tasks.some(t => t.id === selected) && <option value={selected}>Selected task</option>}{page.tasks.map(t => <option value={t.id} key={t.id}>{t.title}</option>)}</select></label>
      <label>Adjustment in minutes<input required type="number" min={-1440} max={1440} step={1} value={minutes} onChange={e => setMinutes(e.target.value)}/></label><label>Reason<textarea required maxLength={500} value={note} onChange={e => setNote(e.target.value)}/></label><button disabled={busy || attention}>Save time correction</button>
    </form></>;
}
function formatClock(seconds: number) { const s = Math.max(0, seconds); return [Math.floor(s / 3600), Math.floor(s % 3600 / 60), s % 60].map(n => String(n).padStart(2, '0')).join(':'); }
