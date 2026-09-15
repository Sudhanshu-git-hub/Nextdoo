'use client';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type Task } from '@/lib/api';
import { TaskEditor } from '@/components/TaskEditor';
import { useWorkspace } from '@/components/WorkspaceContext';
import { fetchPushStatus, pushSupport, registerServiceWorker, subscribeToPush, unsubscribeFromPush } from '@/lib/push-client';
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
type PushState =
 | { phase: 'loading' }
 | { phase: 'unsupported'; reason: string }
 | { phase: 'unconfigured' }
 | { phase: 'denied' }
 | { phase: 'ready'; total: number };

export function NotificationsView({ initialTask }: { initialTask: Task | null }) {
 const { timeZone } = useWorkspace(); const [task, setTask] = useState(initialTask), [editing, setEditing] = useState<Task | null>(null);
 const history = useHistory<Reminder>(`/reminders?history=true${task ? `&taskId=${task.id}` : ''}`), notices = useHistory<Notice>('/notifications');
 const [mode, setMode] = useState('relative'), [before, setBefore] = useState('15'), [when, setWhen] = useState(''), [channel, setChannel] = useState('WEB');
 const [push, setPush] = useState<PushState>({ phase: 'loading' }), [pushBusy, setPushBusy] = useState(false), [pushMessage, setPushMessage] = useState(''), [pushError, setPushError] = useState<string | null>(null);
 const refreshPush = useCallback(async () => {
  const support = pushSupport();
  if (support.kind !== 'supported') { setPush({ phase: 'unsupported', reason: support.reason }); return; }
  const status = await fetchPushStatus();
  if (!status.configured) { setPush({ phase: 'unconfigured' }); return; }
  if (status.permission === 'denied') { setPush({ phase: 'denied' }); return; }
  setPush({ phase: 'ready', total: status.total });
 }, []);
 useEffect(() => { void refreshPush(); }, [refreshPush]);
 async function enablePush() {
  setPushBusy(true); setPushError(null); setPushMessage('');
  try {
   await registerServiceWorker();
   const keyResponse = await fetch('/api/v1/push/public-key');
   if (!keyResponse.ok) throw new Error('Push is not configured.');
   const { vapidPublicKey } = await keyResponse.json();
   const result = await subscribeToPush(vapidPublicKey);
   if (!result.ok) { setPushError('Browser push could not be enabled. Check that notifications are allowed for this site, then try again.'); await refreshPush(); return; }
   setPushMessage(`Browser push enabled (${result.total} subscription${result.total === 1 ? '' : 's'} registered).`);
   await refreshPush();
  } catch {
   setPushError('Browser push could not be enabled. Try again or check your browser settings.');
  } finally { setPushBusy(false); }
 }
 async function disablePush() {
  setPushBusy(true); setPushError(null); setPushMessage('');
  try { const removed = await unsubscribeFromPush(); setPushMessage(removed ? 'Browser push disabled on this device.' : 'Browser push disabled locally; the server registration is already gone.'); await refreshPush(); }
  catch { setPushError('Could not disable browser push on this device.'); }
  finally { setPushBusy(false); }
 }
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
  <p>WEB / SENT means saved in this notification center, not a browser popup or email. PUSH / SENT additionally delivers a browser notification through your registered devices (when browser push is enabled below). Refresh to check for new deliveries; the worker checks every 30 seconds.</p>
  <section aria-labelledby="push-heading" style={{ marginTop: 16 }} className="card">
   <h2 id="push-heading">Browser push</h2>
   {push.phase === 'loading' && <p role="status">Checking browser push…</p>}
   {push.phase === 'unsupported' && <p>Browser push is not supported in this browser. Reminders continue to appear in this notification center.</p>}
   {push.phase === 'unconfigured' && <p>Browser push is not configured on this deployment. Reminders continue to appear in this notification center.</p>}
   {push.phase === 'denied' && <p>Notifications are blocked for this site in your browser settings. Allow notifications to use browser push; reminders continue to appear in this notification center.</p>}
   {push.phase === 'ready' && <>
    <p>{push.total > 0 ? `Browser push is enabled — ${push.total} subscription${push.total === 1 ? '' : 's'} registered for this account.` : 'Browser push is available. Enable it to receive reminders as browser notifications on this device.'}</p>
    {push.total === 0 && <button disabled={pushBusy || busy} onClick={() => void enablePush()}>Enable browser push</button>}
    {push.total > 0 && <button disabled={pushBusy || busy} onClick={() => void disablePush()}>Disable browser push on this device</button>}
   </>}
   {pushError && <p className="banner banner-error" role="alert">{pushError}</p>}
   {pushMessage && <p role="status">{pushMessage}</p>}
  </section>
  {task && <section className="card" aria-labelledby="schedule-heading"><h2 id="schedule-heading">Reminders for {task.title}</h2>
   <form onSubmit={(e) => { e.preventDefault(); if (!task) return; void command('/reminders', { taskId: task.id, taskVersion: task.version, channel, ...(mode === 'relative' ? { minutesBeforeDue: Number(before) } : { scheduledAt: new Date(when).toISOString() }) }, 'Reminder scheduled.'); }}>
    <fieldset disabled={busy || task.status !== 'ACTIVE'} style={{ border: 0, padding: 0 }}>
     <label htmlFor="reminder-channel">Delivery</label><select id="reminder-channel" value={channel} onChange={(e) => setChannel(e.target.value)}><option value="WEB">In-app notification center</option><option value="PUSH" disabled={push.phase !== 'ready' || push.total === 0}>Browser push{push.phase !== 'ready' || push.total === 0 ? ' (enable browser push first)' : ''}</option></select>
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
    {r.task?.status === 'ACTIVE' && !r.supersededById && (r.channel === 'WEB' || r.channel === 'PUSH') && ['SCHEDULED','SENT','FAILED'].includes(r.status) && <button disabled={busy} onClick={() => void command(`/reminders/${r.id}/snooze`, { version: r.version, minutes: 10 }, 'New snoozed reminder scheduled.')}>Snooze 10 minutes</button>}{' '}
    {['SCHEDULED','PROCESSING','FAILED'].includes(r.status) && <button disabled={busy} onClick={() => void command(`/reminders/${r.id}/cancel`, { version: r.version }, 'Reminder canceled.')}>Cancel reminder</button>}{' '}
    {!task && r.task && <Link href={`/notifications?taskId=${r.task.id}`}>Manage task reminders</Link>}
   </article>)}
   {history.cursor && <button disabled={history.busy || busy} onClick={() => void history.more()}>Load more reminders</button>}
  </section>
  {editing && <TaskEditor task={editing} onClose={() => setEditing(null)} onSaved={() => { void notices.reload(); void history.reload(); }} />}
 </div>;
}
