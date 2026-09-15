'use client';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RecurrenceRuleInput } from '@nextdoo/contracts';
import { api, ApiError, type Task } from '@/lib/api';
import { TaskList } from '@/components/TaskList';
import { RecurrenceRuleFields, ruleDraft, parseRule, type RuleDraft } from '@/components/RecurrenceRuleFields';
interface Series { id: string; version: number; rule: RecurrenceRuleInput; active: boolean; generationError: string | null; failureCount: number; startsAt: string; effectiveAfter: string; lastPlannedDate: string | null; occurrences: { id: string; taskId: string | null; occurrenceKey: string; dueAt: string; status: string; task: Task | null }[]; nextCursor: string | null }
export function RecurrenceView({ id }: { id: string }) {
 const [series, setSeries] = useState<Series | null>(null), [draft, setDraft] = useState<RuleDraft | null>(null), [initial, setInitial] = useState(''), [startsAt, setStartsAt] = useState('');
 const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState('');
 const request = useRef<AbortController | null>(null), locked = useRef(false), attempt = useRef<{ body: string; key: string; path: string } | null>(null);
 const dirty = !!draft && (JSON.stringify(draft) !== initial || !!startsAt);
 const load = useCallback(async (cursor?: string, review = false) => {
  request.current?.abort(); const controller = new AbortController(); request.current = controller; setLoading(true); setError(null);
  try {
   const data = await api<Series>(`/recurrences/${id}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, { signal: controller.signal });
   if (controller.signal.aborted) return;
   setSeries((old) => !old || review ? data : { ...old, occurrences: cursor ? [...new Map([...old.occurrences, ...data.occurrences].map((o) => [o.id, o])).values()] : data.occurrences, nextCursor: data.nextCursor });
   if (review) { const d = ruleDraft(data.rule); setDraft(d); setInitial(JSON.stringify(d)); setStartsAt(''); }
  } catch (caught) { if (!controller.signal.aborted) setError(caught instanceof ApiError ? caught.problem.detail : 'Could not load recurrence. Retry when connected.'); }
  finally { if (!controller.signal.aborted) setLoading(false); }
 }, [id]);
 useEffect(() => { void load(undefined, true); return () => request.current?.abort(); }, [load]);
 async function mutate(path: string, payload: unknown, method: string, message: string, success: string) {
  if (locked.current || !window.confirm(message)) return;
  const body = JSON.stringify(payload);
  if (attempt.current?.body !== body || attempt.current.path !== path) attempt.current = { body, path, key: crypto.randomUUID() };
  locked.current = true; setBusy(true); setError(null);
  try {
   await api(path, { method, body, headers: { 'Idempotency-Key': attempt.current.key } }); attempt.current = null; setNotice(success);
   await load(undefined, path.startsWith('/recurrences/'));
  } catch (caught) { setError(caught instanceof ApiError ? caught.problem.detail : 'Request not acknowledged. Your draft is kept; retry uses the same request identity.'); }
  finally { locked.current = false; setBusy(false); }
 }
 function review() { if (!dirty || window.confirm('Discard the unsaved future schedule and reload the series?')) void load(undefined, true); }
 async function change(e: React.FormEvent) {
  e.preventDefault(); if (!draft || !series || busy || loading) return;
  try {
   const rule = parseRule(draft), instant = new Date(startsAt);
   if (!startsAt || !Number.isFinite(instant.getTime())) { setError('Choose a valid new start after the existing generated range.'); return; }
   await mutate(`/recurrences/${id}`, { version: series.version, rule, startsAt: instant.toISOString() }, 'PATCH', 'Change only future generation from the new start? Every existing occurrence, completion and task edit stays unchanged. A count applies to this new schedule segment.', 'Future schedule saved.');
  } catch { setError('Check the frequency, interval, time zone and end condition.'); }
 }
 return <div className="recurrence-view">
  <Link className="history-link" href="/tasks">Browse tasks</Link><h1>Recurrence</h1>
  <p className="subtitle">Real task occurrences, generated online by the worker. Edit or complete each task normally; skip records a distinct outcome.</p>
  {error && <div role="alert" className="banner banner-error">{error} <button disabled={busy || loading} onClick={review}>Reload series</button></div>}
  <p role="status">{notice || (loading ? 'Loading recurrence…' : series ? `${series.occurrences.length} occurrences loaded.` : '')}</p>
  {series && draft && <>
   <p>Generation: <strong>{series.active ? 'Active' : 'Paused'}</strong>. Schedule time zone: {series.rule.timeZone}.</p>
   {series.generationError && <p className="banner banner-warn" role="status">Generation needs attention: {series.generationError}. Free capacity or restore unavailable references, then retry. {series.failureCount >= 5 ? 'Automatic retries stopped after five failures.' : ''}</p>}
   <fieldset disabled={busy || loading} style={{ border: 0, padding: 0 }}>
    <div className="row"><button disabled={dirty} onClick={() => void mutate(`/recurrences/${id}`, { version: series.version, active: !series.active }, 'PATCH', `${series.active ? 'Pause' : 'Resume'} generation? Existing tasks and reminders will not be removed or rescheduled.`, 'Generation setting saved.')}>{series.active ? 'Pause series' : 'Resume series'}</button>
     {series.active && <button disabled={dirty} onClick={() => void mutate(`/recurrences/${id}`, { version: series.version, active: true }, 'PATCH', 'Retry generation within the same task limit and bounded window?', 'Generation retried.')}>Retry generation</button>}
     <button onClick={review}>Reload series details</button></div>
    <form className="card" style={{ marginTop: 18 }} onSubmit={change}>
     <h2>Future schedule</h2><p>Existing generated dates are preserved through {series.lastPlannedDate ?? 'the current range'}. Choose a date after that range and after {new Date(series.effectiveAfter).toLocaleString()}. Changing the time zone must also use a later local date.</p>
     <RecurrenceRuleFields prefix="edit-series" draft={draft} onChange={setDraft} />
     <label htmlFor="series-start">New start (browser timezone)</label><input id="series-start" type="datetime-local" required value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
     <p className="muted">The new start determines wall-clock time in the selected recurrence zone. Counts apply to the new schedule segment. Existing task metadata is never rewritten; newly generated tasks use the original saved template, without copying reminders, subtasks or prerequisites.</p>
     <button className="btn-primary" type="submit">Apply future schedule</button>
    </form>
    <h2>Occurrences</h2>
    <p className="muted">At most 50 future occurrences within 60 days are pre-generated. Each uses one active-task slot. Pausing stops generation only; completing, archiving or deleting one instance does not stop the series.</p>
    <TaskList tasks={series.occurrences.flatMap((o) => o.task ? [o.task] : [])} loading={false} error={null} emptyTitle="No available occurrence tasks" emptyBody="Deleted instance history remains recorded below; check Task history for recovery." onChanged={() => void load()}
      taskActions={(task) => { const occurrence = series.occurrences.find((o) => o.taskId === task.id); return <div><span className="muted">Planned: {occurrence?.dueAt ? new Date(occurrence.dueAt).toLocaleString() : ''} · {occurrence?.status.toLowerCase()}</span>{task.status === 'ACTIVE' && occurrence?.status === 'PENDING' && <button type="button" onClick={() => void mutate(`/tasks/${task.id}/skip`, { version: task.version }, 'POST', 'Skip this occurrence? It will be archived and pending reminders canceled. Other occurrences stay unchanged.', 'Occurrence skipped.')}>Skip occurrence</button>}</div>; }} />
    {series.occurrences.filter((o) => !o.task).map((o) => <p key={o.id}>Task unavailable — originally planned {new Date(o.dueAt).toLocaleString()} ({o.status.toLowerCase()}). <Link className="history-link" href="/task-history">Task history</Link></p>)}
    {series.nextCursor && <button onClick={() => void load(series.nextCursor!)}>Load more occurrences</button>}
   </fieldset>
  </>}
 </div>;
}
