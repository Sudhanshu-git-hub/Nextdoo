'use client';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type Task } from '@/lib/api';
import { TaskEditor } from '@/components/TaskEditor';
import { useWorkspace } from '@/components/WorkspaceContext';
interface Reminder { id: string; taskId: string; scheduledAt: string; channel: string; status: string; version: number; attempts: number; lastError: string | null; nextAttemptAt: string; supersededById: string | null; task: Task | null }
interface Notice { id: string; title: string; body: string | null; createdAt: string; readAt: string | null; task: Task | null }
interface Page<T> { data: T[]; pagination: { has_more: boolean; next_cursor: string | null } }
function useHistory<T extends { id: string }>(path: string) {
 const [rows, setRows] = useState<T[]>([]), [cursor, setCursor] = useState<string | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
 const request = useRef<AbortController | null>(null), locked = useRef(false);
 const load = useCallback(async (next?: string | null) => {
  if (next && locked.current) return; request.current?.abort(); locked.current = true; setBusy(true); setError(null);
  const controller = new AbortController(); request.current = controller;
  try { const p = await api<Page<T>>(`${path}${next ? `${path.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(next)}` : ''}`, { signal: controller.signal }); if (!controller.signal.aborted) { setRows((old) => [...new Map([...(next ? old : []), ...p.data].map((r) => [r.id, r])).values()]); setCursor(p.pagination.next_cursor); } }
  catch (e) { if (!controller.signal.aborted) setError(e instanceof ApiError ? e.problem.detail : 'Could not load history. Loaded records are kept; retry when connected.'); }
  finally { if (request.current === controller) { locked.current = false; setBusy(false); } }
 }, [path]);
 useEffect(() => { void load(); return () => { request.current?.abort(); locked.current = false; }; }, [load]);
 return { rows, cursor, busy, error, reload: () => load(), more: () => load(cursor) };
}
export function NotificationsView({ initialTask }: { initialTask: Task | null }) {
 const { timeZone } = useWorkspace(); const [task, setTask] = useState(initialTask), [editing, setEditing] = useState<Task | null>(null);
 const history = useHistory<Reminder>(`/reminders?history=true${task ? `&taskId=${task.id}` : ''}`), notices = useHistory<Notice>('/notifications');
 const [mode, setMode] = useState('relative'), [before, setBefore] = useState('15'), [when, setWhen] = useState('');
 const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [message, setMessage] = useState('');
 const locked = useRef(false), keys = useRef(new Map<string, string>());
 const date = (s: string) => new Date(s).toLocaleString(undefined, { timeZone });
 async function command(path: string, data: object, success: string) {
  if (locked.current) return; locked.current = true; setBusy(true); setError(null); setMessage('');
  const body = JSON.stringify(data), identity = `${path}:${body}`; if (!keys.current.has(identity)) keys.current.set(identity, crypto.randomUUID());
  try { await api(path, { method: 'POST', headers: { 'Idempotency-Key': keys.current.get(identity)! }, body }); keys.current.delete(identity); setMessage(success); await Promise.all([history.reload(), notices.reload()]); }
  catch (e) { setError(e instanceof ApiError ? e.problem.detail : 'The request was not acknowledged. Your input is kept; an unchanged retry uses the same identity.'); }
  finally { locked.current = false; setBusy(false); }
 }
 async function reloadTask() {
  if (!task || locked.current) return; locked.current = true; setBusy(true); setError(null);
  try { setTask(await api<Task>(`/tasks/${task.id}`)); await history.reload(); } catch { setError('Could not reload the task. Your reminder input is kept.'); } finally { locked.current = false; setBusy(false); }
 }
 return <div className="notifications-view">
  <div className="page-head"><div><h1>Notifications</h1><p className="subtitle">Durable in-app reminders and delivery history · {timeZone}</p></div></div>
  <p>WEB / SENT means saved in this notification center, not a browser popup, desktop alert or email. External channels are not enabled. Refresh to check for new deliveries; the worker checks every 30 seconds.</p>
  {task && <section className="card" aria-labelledby="schedule-heading"><h2 id="schedule-heading">Reminders for {task.title}</h2>
   <form onSubmit={(e) => { e.preventDefault(); if (!task) return; void command('/reminders', { taskId: task.id, taskVersion: task.version, channel: 'WEB', ...(mode === 'relative' ? { minutesBeforeDue: Number(before) } : { scheduledAt: new Date(when).toISOString() }) }, 'Reminder scheduled.'); }}>
    <fieldset disabled={busy || task.status !== 'ACTIVE'} style={{ border: 0, padding: 0 }}>
     <label htmlFor="reminder-mode">Reminder mode</label><select id="reminder-mode" value={mode} onChange={(e) => setMode(e.target.value)}><option value="relative">Before due date</option><option value="absolute">Specific time</option></select>
     {mode === 'relative' ? <><label htmlFor="reminder-before">Minutes before due</label><input id="reminder-before" type="number" required min={0} max={43200} value={before} onChange={(e) => setBefore(e.target.value)} /><p>Relative reminders follow future due-date edits while pending. A due date is required.</p></> : <><label htmlFor="reminder-at">Reminder time (browser timezone)</label><input id="reminder-at" type="datetime-local" required max="9999-12-31T23:59" value={when} onChange={(e) => setWhen(e.target.value)} /><p>A past time is eligible immediately; reminders over 24 hours late expire.</p></>}
     <button type="submit">Schedule reminder</button>
    </fieldset>
   </form><button type="button" disabled={busy} onClick={() => void reloadTask()}>Reload task for review</button><p>Task status: {task.status}. Reload after changes elsewhere; your input is kept.</p>
  </section>}
  {!task && <p>Use a task’s <strong>Reminders</strong> link to schedule a new reminder.</p>}
  {error && <p className="banner banner-error" role="alert">{error}</p>}{message && <p role="status">{message}</p>}
  <section aria-labelledby="notice-heading"><h2 id="notice-heading">Delivered notifications</h2><button disabled={notices.busy || busy} onClick={() => void notices.reload()}>Refresh notifications</button>
   {notices.error && <p role="alert">{notices.error}</p>}{notices.busy && <p role="status">Loading notifications…</p>}
   {!notices.busy && !notices.rows.length && !notices.error && <p>No delivered notifications yet.</p>}
   {notices.rows.map((n) => <article className="card" key={n.id} data-notification-id={n.id} style={{ marginTop: 12 }}><h3>{n.title}</h3><p>{n.body}</p><p>{date(n.createdAt)} · <span>{n.readAt ? 'Read' : 'Unread'}</span></p>
    {!n.readAt && <button disabled={busy} onClick={() => void command(`/notifications/${n.id}/read`, {}, 'Notification marked read.')}>Mark read</button>}{' '}
    {n.task && <button disabled={busy} onClick={() => setEditing(n.task)}>View task</button>}
   </article>)}
   {notices.cursor && <button disabled={notices.busy || busy} onClick={() => void notices.more()}>Load more notifications</button>}
  </section>
  <section aria-labelledby="history-heading" style={{ marginTop: 24 }}><h2 id="history-heading">Reminder delivery history</h2><button disabled={history.busy || busy} onClick={() => void history.reload()}>Refresh reminders</button>
   <p>Snooze creates a new, absolute reminder ten minutes from now. Earlier delivery history is preserved. Pending reminders are canceled when their task is completed, archived, skipped or deleted.</p>
   {history.error && <p role="alert">{history.error}</p>}{history.busy && <p role="status">Loading reminders…</p>}
   {!history.busy && !history.rows.length && !history.error && <p>No reminders scheduled.</p>}
   {history.rows.map((r) => <article className="card" key={r.id} data-reminder-id={r.id} style={{ marginTop: 12 }}><h3>{r.task?.title ?? 'Unavailable task'}</h3><p>{r.status} · {r.channel} · scheduled {date(r.scheduledAt)} · attempts {r.attempts}</p>
    {r.lastError && <p>{r.lastError}{r.status === 'SCHEDULED' ? ` · next retry ${date(r.nextAttemptAt)}` : ' · delivery stopped; review before scheduling again'}</p>}
    {r.supersededById && <p>Replaced by a new reminder; this history is preserved.</p>}
    {r.task?.status === 'ACTIVE' && !r.supersededById && r.channel === 'WEB' && ['SCHEDULED','SENT','FAILED'].includes(r.status) && <button disabled={busy} onClick={() => void command(`/reminders/${r.id}/snooze`, { version: r.version, minutes: 10 }, 'New snoozed reminder scheduled.')}>Snooze 10 minutes</button>}{' '}
    {['SCHEDULED','PROCESSING','FAILED'].includes(r.status) && <button disabled={busy} onClick={() => void command(`/reminders/${r.id}/cancel`, { version: r.version }, 'Reminder canceled.')}>Cancel reminder</button>}{' '}
    {!task && r.task && <Link href={`/notifications?taskId=${r.task.id}`}>Manage task reminders</Link>}
   </article>)}
   {history.cursor && <button disabled={history.busy || busy} onClick={() => void history.more()}>Load more reminders</button>}
  </section>
  {editing && <TaskEditor task={editing} onClose={() => setEditing(null)} onSaved={() => { void notices.reload(); void history.reload(); }} />}
 </div>;
}
