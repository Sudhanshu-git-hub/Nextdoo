'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { workspaceSettingsSchema } from '@nextdoo/contracts';
import { minuteTime, workdayDescription } from '@nextdoo/core/calendar';
import { api, ApiError } from '@/lib/api';
import { useWorkspace, type WorkspaceSnapshot } from './WorkspaceContext';
const asDraft = (w: WorkspaceSnapshot) => ({ name: w.name, timeZone: w.timeZone, weekStart: String(w.weekStart), start: minuteTime(w.workdayStartMinute), end: minuteTime(w.workdayEndMinute) });
const minutes = (text: string) => { if (!/^\d{2}:\d{2}$/.test(text)) return NaN; const [h, m] = text.split(':').map(Number); return h! * 60 + m!; };
export function WorkspaceSettings() {
 const initial = useWorkspace(), router = useRouter();
 const [current, setCurrent] = useState(initial), [draft, setDraft] = useState(() => asDraft(initial));
 const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState('');
 const attempt = useRef<{ body: string; key: string } | null>(null), locked = useRef(false);
 const dirty = JSON.stringify(draft) !== JSON.stringify(asDraft(current));
 useEffect(() => {
  if (!dirty && !busy) return;
  const unload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
  const navigate = (e: MouseEvent) => {
   if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
   const link = e.target instanceof Element ? e.target.closest('a[href]') as HTMLAnchorElement | null : null;
   if (!link || link.target === '_blank' || link.hasAttribute('download') || link.href === location.href || link.getAttribute('href')?.startsWith('#')) return;
   if (locked.current || !window.confirm('Discard unsaved workspace settings and leave?')) { e.preventDefault(); e.stopPropagation(); }
  };
  window.addEventListener('beforeunload', unload); document.addEventListener('click', navigate, true);
  return () => { window.removeEventListener('beforeunload', unload); document.removeEventListener('click', navigate, true); };
 }, [dirty, busy]);
 const accept = (row: WorkspaceSnapshot) => { setCurrent(row); setDraft(asDraft(row)); attempt.current = null; router.refresh(); };
 async function save(e: React.FormEvent) {
  e.preventDefault(); if (locked.current || !dirty) return;
  const parsed = workspaceSettingsSchema.safeParse({ name: draft.name, timeZone: draft.timeZone, weekStart: Number(draft.weekStart), workdayStartMinute: minutes(draft.start), workdayEndMinute: minutes(draft.end) });
  if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? 'Check the workspace settings.'); return; }
  const body = JSON.stringify({ version: current.version, ...parsed.data }); if (attempt.current?.body !== body) attempt.current = { body, key: crypto.randomUUID() };
  locked.current = true; setBusy(true); setError(null); setNotice('');
  try { accept(await api<WorkspaceSnapshot>(`/workspaces/${current.id}`, { method: 'PATCH', headers: { 'Idempotency-Key': attempt.current.key }, body })); setNotice('Workspace settings saved. Existing task dates and recurrence rules are unchanged.'); }
  catch (caught) { setError(caught instanceof ApiError ? caught.problem.detail : 'The request was not acknowledged. Your draft is kept; retry uses the same request identity.'); }
  finally { locked.current = false; setBusy(false); }
 }
 async function reload() {
  if (locked.current || dirty && !window.confirm('Discard this settings draft and load the latest workspace version?')) return;
  locked.current = true; setBusy(true); setError(null); setNotice('');
  try { accept(await api<WorkspaceSnapshot>(`/workspaces/${current.id}`)); } catch { setError('Could not reload workspace settings. Your draft is kept.'); }
  finally { locked.current = false; setBusy(false); }
 }
 return <section className="card workspace-settings" aria-labelledby="workspace-heading" style={{ marginBottom: 20 }}>
  <h2 id="workspace-heading">Personal workspace</h2>
  <p>One personal workspace per account. These defaults affect new capture, task display, Today and the week calendar; existing dates and series schedules are not rewritten.</p>
  <form onSubmit={save}><fieldset disabled={busy} style={{ border: 0, padding: 0 }}>
   <label htmlFor="workspace-name">Workspace name</label><input id="workspace-name" required maxLength={200} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
   <label htmlFor="workspace-zone">Workspace time zone</label><input id="workspace-zone" required maxLength={64} placeholder="Asia/Kolkata" value={draft.timeZone} onChange={(e) => setDraft({ ...draft, timeZone: e.target.value })} aria-describedby="workspace-zone-help" />
   <p id="workspace-zone-help" className="muted">Use an IANA zone such as Asia/Kolkata. Explicit task zones and recurrence rules are preserved.</p>
   <label htmlFor="workspace-week">Week starts on</label><select id="workspace-week" value={draft.weekStart} onChange={(e) => setDraft({ ...draft, weekStart: e.target.value })}>{['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].map((day, i) => <option value={i} key={day}>{day}</option>)}</select>
   <div className="task-filter-grid"><div><label htmlFor="workspace-start">Workday starts</label><input id="workspace-start" type="time" required value={draft.start} onChange={(e) => setDraft({ ...draft, start: e.target.value })} /></div><div><label htmlFor="workspace-end">Workday ends</label><input id="workspace-end" type="time" required value={draft.end} onChange={(e) => setDraft({ ...draft, end: e.target.value })} /></div></div>
   <p>Earlier end times mean the following day. Start and end must differ; use 00:00 for midnight. These are configured wall-clock hours, not a guarantee of available time.</p>
   {draft.start && draft.end && <p>{workdayDescription(minutes(draft.start), minutes(draft.end))}</p>}
   <button type="submit" disabled={!dirty}>{busy ? 'Saving…' : 'Save workspace settings'}</button>{' '}<button type="button" onClick={() => void reload()}>Reload workspace settings</button>
  </fieldset></form>
  {error && <p className="banner banner-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
 </section>;
}
