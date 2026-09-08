'use client';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, type Task } from '@/lib/api';
interface Detail extends Task { tagIds: string[]; timeZone: string | null }
interface Project { id: string; name: string; status: string }
interface Tag { id: string; name: string }
interface Draft { title: string; description: string; projectId: string; priority: Task['priority']; due: string; estimate: string; tagIds: string[]; newTags: string }
const localTime = (iso: string | null) => { if (!iso) return ''; const d = new Date(iso); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
const draftOf = (t: Detail): Draft => ({ title: t.title, description: t.description ?? '', projectId: t.projectId ?? '', priority: t.priority, due: localTime(t.dueAt), estimate: t.estimateMinutes?.toString() ?? '', tagIds: t.tagIds, newTags: '' });
export function TaskEditor({ task, onClose, onSaved }: { task: Task; onClose: () => void; onSaved: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [base, setBase] = useState<Draft | null>(null), [draft, setDraft] = useState<Draft | null>(null);
  const [version, setVersion] = useState(task.version), [projects, setProjects] = useState<Project[]>([]), [tags, setTags] = useState<Tag[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [conflict, setConflict] = useState<Detail | null>(null);
  const identity = useRef<{ body: string; key: string } | null>(null);
  const dirty = Boolean(base && draft && JSON.stringify(base) !== JSON.stringify(draft));
  useEffect(() => { const element = dialog.current!; element.showModal(); return () => element.close(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([api<Detail>(`/tasks/${task.id}`, { signal: controller.signal }), api<{ data: Project[] }>('/projects', { signal: controller.signal }), api<{ data: Tag[] }>('/tags', { signal: controller.signal })])
      .then(([detail, p, t]) => { if (controller.signal.aborted) return; const d = draftOf(detail); setBase(d); setDraft(d); setVersion(detail.version); setProjects(p.data); setTags(t.data); })
      .catch((e) => { if (!controller.signal.aborted) setError(e instanceof ApiError ? e.problem.detail : 'Could not load task details. Close and retry.'); });
    return () => controller.abort();
  }, [task.id]);
  function close() { if (!busy && (!dirty || window.confirm('Discard unsaved changes?'))) { dialog.current?.close(); onClose(); } }
  async function save(e: React.FormEvent) {
    e.preventDefault(); if (!draft || !base || busy || conflict || !dirty) return;
    const patch: Record<string, unknown> = { version };
    if (draft.title !== base.title) patch.title = draft.title;
    if (draft.description !== base.description) patch.description = draft.description || null;
    if (draft.projectId !== base.projectId) patch.projectId = draft.projectId || null;
    if (draft.priority !== base.priority) patch.priority = draft.priority;
    if (draft.estimate !== base.estimate) patch.estimateMinutes = draft.estimate === '' ? null : Number(draft.estimate);
    if (draft.due !== base.due) { patch.dueAt = draft.due ? new Date(draft.due).toISOString() : null; patch.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone; }
    if (draft.newTags.trim() || JSON.stringify(draft.tagIds) !== JSON.stringify(base.tagIds)) {
      patch.tagIds = draft.tagIds; patch.tagNames = draft.newTags.split(',').map((n) => n.trim()).filter(Boolean);
    }
    const body = JSON.stringify(patch);
    if (identity.current?.body !== body) identity.current = { body, key: crypto.randomUUID() };
    setBusy(true); setError(null);
    try {
      await api(`/tasks/${task.id}`, { method: 'PATCH', headers: { 'Idempotency-Key': identity.current.key }, body });
      dialog.current?.close(); onClose(); onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.problem.detail : 'Could not save. Your draft is kept; retry uses the same request identity.');
      if (e instanceof ApiError && e.isConflict) {
        try { setConflict(await api<Detail>(`/tasks/${task.id}`)); }
        catch { setError('The task changed but its latest version could not be loaded. Your draft is kept; retry when connected.'); }
      }
    } finally { setBusy(false); }
  }
  function change<K extends keyof Draft>(key: K, value: Draft[K]) { setDraft((d) => d && ({ ...d, [key]: value })); }
  return <dialog ref={dialog} aria-labelledby="task-editor-title" className="task-editor" onCancel={(e) => { e.preventDefault(); close(); }}>
    <h2 id="task-editor-title">Edit task</h2>
    {error && <div className="banner banner-error" role="alert" id="task-editor-error">{error}</div>}
    {conflict && <section className="banner banner-warn" aria-label="Latest server version">
      <p>The task changed elsewhere. Your draft below has not been replaced.</p>
      <p><strong>Server title:</strong> {conflict.title}</p><p><strong>Server notes:</strong> {conflict.description || 'None'}</p>
      <p>Priority: {conflict.priority}; due: {conflict.dueAt || 'None'}; estimate: {conflict.estimateMinutes ?? 'None'}; project: {projects.find((p) => p.id === conflict.projectId)?.name ?? 'Inbox'}; tags: {conflict.tagIds.map((id) => tags.find((t) => t.id === id)?.name ?? id).join(', ') || 'None'}.</p>
      <button disabled={busy} onClick={() => { setVersion(conflict.version); setConflict(null); setError(null); }}>Keep my changes against this version</button>{' '}
      <button disabled={busy} onClick={() => { if (window.confirm('Replace your draft with the server version?')) { const d = draftOf(conflict); setBase(d); setDraft(d); setVersion(conflict.version); setConflict(null); setError(null); } }}>Use server version</button>
    </section>}
    {!draft ? <p role="status">{error ? 'Details unavailable.' : 'Loading task details…'}</p> : <form onSubmit={save} aria-describedby={error ? 'task-editor-error' : undefined}>
      <fieldset disabled={busy} style={{ border: 0, padding: 0 }}>
        <label htmlFor="edit-title">Title</label><input autoFocus id="edit-title" required maxLength={500} value={draft.title} onChange={(e) => change('title', e.target.value)} />
        <label htmlFor="edit-notes">Notes</label><textarea id="edit-notes" maxLength={20000} rows={4} value={draft.description} onChange={(e) => change('description', e.target.value)} />
        <label htmlFor="edit-project">Project</label><select id="edit-project" value={draft.projectId} onChange={(e) => change('projectId', e.target.value)}><option value="">Inbox (unfiled)</option>{projects.map((p) => <option key={p.id} value={p.id} disabled={p.status !== 'ACTIVE'}>{p.name}{p.status !== 'ACTIVE' ? ' (archived)' : ''}</option>)}</select>
        <label htmlFor="edit-priority">Priority</label><select id="edit-priority" value={draft.priority} onChange={(e) => change('priority', e.target.value as Task['priority'])}>{['NONE', 'LOW', 'MEDIUM', 'HIGH'].map((p) => <option key={p}>{p}</option>)}</select>
        <label htmlFor="edit-due">Due date and time ({Intl.DateTimeFormat().resolvedOptions().timeZone})</label><input id="edit-due" type="datetime-local" value={draft.due} onChange={(e) => change('due', e.target.value)} />
        <label htmlFor="edit-estimate">Estimate (minutes)</label><input id="edit-estimate" type="number" min={0} max={44640} step={1} value={draft.estimate} onChange={(e) => change('estimate', e.target.value)} />
        <fieldset><legend>Tags</legend>{tags.map((t) => <label key={t.id} style={{ display: 'block' }}><input type="checkbox" checked={draft.tagIds.includes(t.id)} onChange={(e) => change('tagIds', e.target.checked ? [...draft.tagIds, t.id] : draft.tagIds.filter((id) => id !== t.id))} /> #{t.name}</label>)}
          <label htmlFor="edit-new-tags">New tags (comma separated)</label><input id="edit-new-tags" value={draft.newTags} onChange={(e) => change('newTags', e.target.value)} />
        </fieldset>
      </fieldset>
      <div className="row" style={{ marginTop: 16 }}><button className="btn-primary" disabled={busy || !dirty || Boolean(conflict)}>{busy ? 'Saving…' : 'Save changes'}</button><button type="button" disabled={busy} onClick={close}>Cancel</button></div>
    </form>}
    {!draft && <button onClick={close}>Close</button>}
  </dialog>;
}
