'use client';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTaskPages } from '@/lib/use-task-pages';
import { TaskPagination } from '@/components/TaskPagination';
import { api } from '@/lib/api';
import { enqueue, listQueued, readFocusSnapshot, saveFocusSnapshot, readFocusBreak, saveFocusBreak, dequeue, type FocusSnapshot } from '@/lib/offline-queue';
import { focusElapsed, projectFocus } from '@/lib/focus-state';
import { usePersonalization } from '../PersonalizationContext';

export function FocusView({ workspaceId }: { workspaceId: string }) {
  const page = useTaskPages(workspaceId, 'status=ACTIVE', true);
  const { preferences, save } = usePersonalization();
  const [timer, setTimer] = useState<FocusSnapshot | null>(null), [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null), [pending, setPending] = useState(0), [attention, setAttention] = useState(false);
  const [busy, setBusy] = useState(false), [clock, setClock] = useState(Date.now());
  const [breakEnd, setBreakEnd] = useState<number | null>(null), [selected, setSelected] = useState('');
  const [minutes, setMinutes] = useState(''), [note, setNote] = useState('');
  const inFlight = useRef(false);
  const locked = useCallback(<T,>(fn: () => Promise<T>) => navigator.locks ? navigator.locks.request(`nextdoo-sync:${workspaceId}`, fn) : fn(), [workspaceId]);
  const readLocal = useCallback(async () => {
    const queued = (await listQueued(workspaceId, true)).filter(q => q.entityType === 'timer_session');
    const projected = projectFocus(await readFocusSnapshot(workspaceId), queued);
    setTimer(projected); setPending(queued.length); setAttention(queued.some(q => q.quarantined));
    setBreakEnd(await readFocusBreak(workspaceId));
    return { queued, projected };
  }, [workspaceId]);
  const load = useCallback(async () => {
    try { await locked(async () => {
      const { queued } = await readLocal();
      if (!queued.length && navigator.onLine) {
        const response = await api<{ timer: FocusSnapshot | null }>('/timers');
        await saveFocusSnapshot(workspaceId, response.timer); await readLocal();
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
  async function command(action: 'start' | 'pause' | 'resume' | 'stop' | 'adjust', taskId?: string, takeBreak = false) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(null);
    try {
      await locked(async () => {
        const { queued, projected } = await readLocal();
        if (queued.some(q => q.quarantined)) throw new Error('Review rejected actions before recording more time.');
        const at = new Date().toISOString();
        if (action === 'start' && projected) throw new Error('Stop the current session first.');
        if (!['start','adjust'].includes(action) && !projected) throw new Error('The session changed. Refresh before continuing.');
        const adjustment = Number(minutes);
        if (action === 'adjust' && (!taskId || !Number.isInteger(adjustment) || !adjustment || Math.abs(adjustment) > 1440 || !note.trim())) throw new Error('Choose a task, a nonzero adjustment up to 1,440 minutes, and a reason.');
        await enqueue({ workspaceId, mutationId: crypto.randomUUID(), entityType: 'timer_session',
          entityId: action === 'start' || action === 'adjust' ? crypto.randomUUID() : projected!.id,
          operation: action === 'start' ? 'create' : 'update', baseVersion: action === 'start' || action === 'adjust' ? null : projected!.version,
          payload: action === 'start' ? { taskId, startedAt: at } : action === 'adjust' ? { action, taskId, minutes: adjustment, note: note.trim() } : { action, at } });
        if (action === 'start') await saveFocusBreak(workspaceId, null);
        if (takeBreak) await saveFocusBreak(workspaceId, Date.now() + preferences.breakMinutes * 60000);
        await readLocal();
      });
      if (action === 'adjust') { setMinutes(''); setNote(''); }
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not save the action on this device.'); }
    finally { inFlight.current = false; setBusy(false); }
  }
  const elapsed = timer ? focusElapsed(timer, clock) : 0, breaking = breakEnd !== null;
  const displayed = breaking ? Math.max(0, Math.ceil((breakEnd - clock) / 1000)) : preferences.focusMode === 'pomodoro' && timer ? Math.max(0, preferences.focusMinutes * 60 - elapsed) : elapsed;
  const task = page.tasks.find(t => t.id === timer?.taskId);
  const preferenceError = () => setError('Could not save timer preferences.');
  return <><div className="page-head"><div><h1>Focus</h1><p className="subtitle">One task at a time. Work is recorded on the existing task; breaks never count as work.</p></div></div>
    {error && <p className="banner banner-error" role="alert">{error}</p>}
    {pending > 0 && <p role="status">{pending} focus action{pending === 1 ? '' : 's'} saved on this device, awaiting sync.</p>}
    {attention && <div className="banner banner-warn"><p>A session changed or an action was rejected. Local commands are preserved in <Link href="/conflicts">Sync conflicts</Link>. Review before discarding.</p><button onClick={async () => { await locked(async () => { for (const q of await listQueued(workspaceId, true)) if (q.entityType === 'timer_session') await dequeue(workspaceId, q.mutationId); }); await load(); }}>Discard pending focus actions and use server session</button></div>}
    <div className="card focus-card"><div className="row">
      <label>Timer mode<select value={preferences.focusMode} disabled={loading || busy || !!timer || breaking} onChange={e => { void save({ focusMode: e.target.value as 'stopwatch' | 'pomodoro' }).catch(preferenceError); }}><option value="stopwatch">Stopwatch</option><option value="pomodoro">Pomodoro</option></select></label>
      {preferences.focusMode === 'pomodoro' && <><label>Work minutes<input type="number" min={1} max={180} value={preferences.focusMinutes} disabled={!!timer || busy} onChange={e => { const n = Number(e.target.value); if (n >= 1 && n <= 180) void save({ focusMinutes: n }).catch(preferenceError); }}/></label><label>Break minutes<input type="number" min={1} max={60} value={preferences.breakMinutes} disabled={breaking || busy} onChange={e => { const n = Number(e.target.value); if (n >= 1 && n <= 60) void save({ breakMinutes: n }).catch(preferenceError); }}/></label></>}
    </div><div className="focus-clock" role="timer" aria-live="off">{formatClock(displayed)}</div>
    <p className="subtitle">{breaking ? displayed ? 'Break — no work time is recorded' : 'Break complete' : timer ? `${timer.status === 'RUNNING' ? 'Running' : 'Paused'} · ${task?.title ?? 'Task'}` : 'No timer running'}</p>
    {timer && preferences.focusMode === 'pomodoro' && elapsed >= preferences.focusMinutes * 60 && <p role="status">Work interval complete. Finish when ready to save your actual time and take a break.</p>}
    <div className="row">
      {timer?.status === 'RUNNING' && <button disabled={busy || attention} onClick={() => command('pause')}>Pause</button>}
      {timer?.status === 'PAUSED' && <button disabled={busy || attention} onClick={() => command('resume')}>Resume</button>}
      {timer && <button disabled={busy || attention} onClick={() => command('stop')}>Stop and save</button>}
      {timer && preferences.focusMode === 'pomodoro' && <button disabled={busy || attention} onClick={() => command('stop', undefined, true)}>Finish work and take a break</button>}
      {breaking && <button onClick={async () => { await saveFocusBreak(workspaceId, null); setBreakEnd(null); }}>End break</button>}
      <button disabled={busy} onClick={load}>Refresh session</button>
    </div></div>
    <h2>Start a session</h2>{loading && <p role="status">Loading session…</p>}
    {page.stale && <p>Showing cached tasks. Focus actions are saved on this device until connected.</p>}
    {selected && !page.tasks.some(t => t.id === selected) && <p><Link href={`/tasks/${encodeURIComponent(selected)}`}>Open selected task</Link> · <button disabled={busy || loading || !!timer || attention || breaking} onClick={() => command('start', selected)}>Start selected task</button></p>}
    <ul className="focus-tasks">{[...page.tasks].sort((a,b) => Number(b.id === selected) - Number(a.id === selected)).map(t => <li className="task-row" key={t.id}><div className="task-main"><Link href={`/tasks/${t.id}`}>{t.title}</Link><p className="task-meta">{t.estimateMinutes !== null ? `Estimated ${t.estimateMinutes}m · ` : ''}Recorded {t.actualMinutes}m</p></div><button aria-label={`Start a focus timer for ${t.title}`} disabled={busy || loading || !!timer || attention || breaking} onClick={() => command('start', t.id)}>Start</button></li>)}</ul>
    {!page.loading && !page.tasks.length && <p>No active tasks. Add one from Inbox or Today.</p>}
    <TaskPagination {...page} count={page.tasks.length} onMore={page.loadMore} onRetry={page.tasks.length ? page.loadMore : page.reload}/>
    <form className="card" onSubmit={e => { e.preventDefault(); void command('adjust', selected); }}><h2>Manual time correction</h2><p>Add missed time or subtract incorrectly recorded time. Every adjustment is audited. Negative totals are rejected.</p>
      <label>Task for correction<select required value={selected} onChange={e => setSelected(e.target.value)}><option value="">Choose a task</option>{selected && !page.tasks.some(t => t.id === selected) && <option value={selected}>Selected task</option>}{page.tasks.map(t => <option value={t.id} key={t.id}>{t.title}</option>)}</select></label>
      <label>Adjustment in minutes<input required type="number" min={-1440} max={1440} step={1} value={minutes} onChange={e => setMinutes(e.target.value)}/></label><label>Reason<textarea required maxLength={500} value={note} onChange={e => setNote(e.target.value)}/></label><button disabled={busy || attention}>Save time correction</button>
    </form></>;
}
function formatClock(seconds: number) { const s = Math.max(0, seconds); return [Math.floor(s / 3600), Math.floor(s % 3600 / 60), s % 60].map(n => String(n).padStart(2, '0')).join(':'); }
