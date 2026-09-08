'use client';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
export interface Project {
  id: string; name: string; description: string | null; color: string | null;
  status: 'ACTIVE' | 'ARCHIVED'; version: number;
}
interface Draft { name: string; description: string; color: string }
const draftOf = (p: Project): Draft => ({ name: p.name, description: p.description ?? '', color: p.color ?? '' });

/** Scoped native dialog: drafts survive conflicts; lifecycle actions never cascade tasks. */
export function ProjectSettings({ project, onClose, onSaved }: { project: Project; onClose: () => void; onSaved: (p: Project) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [current, setCurrent] = useState<Project | null>(null);
  const [base, setBase] = useState<Draft | null>(null), [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [conflict, setConflict] = useState<Project | null>(null);
  const identity = useRef<{ fingerprint: string; key: string } | null>(null);
  const dirty = Boolean(base && draft && JSON.stringify(base) !== JSON.stringify(draft));
  useEffect(() => { const d = dialog.current!; d.showModal(); return () => d.close(); }, []);
  useEffect(() => {
    const abort = new AbortController();
    void api<Project>(`/projects/${project.id}`, { signal: abort.signal }).then((p) => {
      if (abort.signal.aborted) return;
      setCurrent(p); setBase(draftOf(p)); setDraft(draftOf(p));
    }).catch((e) => { if (!abort.signal.aborted) setError(e instanceof ApiError ? e.problem.detail : 'Could not load project settings. Close and retry.'); });
    return () => abort.abort();
  }, [project.id]);
  function close() {
    if (!busy && (!dirty || window.confirm('Discard unsaved project changes?'))) { dialog.current?.close(); onClose(); }
  }
  async function send(path: string, method: string, input: Record<string, unknown>) {
    if (busy || conflict) return;
    const body = JSON.stringify(input), fingerprint = `${method}:${path}:${body}`;
    if (identity.current?.fingerprint !== fingerprint) identity.current = { fingerprint, key: crypto.randomUUID() };
    setBusy(true); setError(null);
    try {
      const saved = await api<Project>(path, { method, body, headers: { 'Idempotency-Key': identity.current.key } });
      dialog.current?.close(); onSaved(saved); onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.problem.detail : 'Could not save. Your changes are kept; retry uses the same request identity.');
      if (e instanceof ApiError && e.isConflict) {
        try { setConflict(await api<Project>(`/projects/${project.id}`)); }
        catch { setError('The project changed, but its latest version is unavailable. Your draft is kept; retry when connected.'); }
      }
    } finally { setBusy(false); }
  }
  function save(e: React.FormEvent) {
    e.preventDefault(); if (!current || !draft || !base || !dirty) return;
    const patch: Record<string, unknown> = { version: current.version };
    if (draft.name !== base.name) patch.name = draft.name;
    if (draft.description !== base.description) patch.description = draft.description || null;
    if (draft.color !== base.color) patch.color = draft.color || null;
    void send(`/projects/${project.id}`, 'PATCH', patch);
  }
  function changeStatus() {
    if (!current || dirty) return;
    const archive = current.status === 'ACTIVE';
    if (archive && !window.confirm('Archive this project? Existing tasks and reminders will stay unchanged. You can restore the project later.')) return;
    void send(`/projects/${project.id}/${archive ? 'archive' : 'restore'}`, 'POST', { version: current.version });
  }
  return <dialog ref={dialog} className="task-editor project-settings" aria-labelledby="project-settings-title" onCancel={(e) => { e.preventDefault(); close(); }}>
    <h2 id="project-settings-title">Project settings</h2>
    {error && <div id="project-settings-error" className="banner banner-error" role="alert">{error}</div>}
    {conflict && <section className="banner banner-warn" aria-label="Latest server project">
      <p>This project changed elsewhere. Your draft has not been replaced.</p>
      <p><strong>Server name:</strong> {conflict.name}</p><p><strong>Description:</strong> {conflict.description || 'None'}</p>
      <p>Color: {conflict.color || 'Default'}; status: {conflict.status}.</p>
      <button onClick={() => { setCurrent(conflict); setConflict(null); setError(null); }}>Keep my changes against this version</button>{' '}
      <button onClick={() => { if (window.confirm('Replace your project draft with the server version?')) { setCurrent(conflict); setDraft(draftOf(conflict)); setBase(draftOf(conflict)); setConflict(null); setError(null); } }}>Use server version</button>
    </section>}
    {!draft || !current ? <><p role="status">{error ? 'Settings unavailable.' : 'Loading project settings…'}</p><button onClick={close}>Close</button></> : <>
      <form onSubmit={save} aria-describedby={error ? 'project-settings-error' : undefined}>
        <fieldset disabled={busy} style={{ border: 0, padding: 0 }}>
          <label htmlFor="project-edit-name">Project name</label><input autoFocus id="project-edit-name" required maxLength={200} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <label htmlFor="project-edit-description">Description</label><textarea id="project-edit-description" rows={4} maxLength={2000} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          <label htmlFor="project-edit-color">Color (optional #RRGGBB)</label><input id="project-edit-color" pattern="#[0-9a-fA-F]{6}" maxLength={7} placeholder="#6aa6ff" value={draft.color} onChange={(e) => setDraft({ ...draft, color: e.target.value })} />
        </fieldset>
        <div className="row" style={{ marginTop: 16 }}><button className="btn-primary" disabled={busy || !dirty || Boolean(conflict)}>{busy ? 'Saving…' : 'Save project'}</button><button type="button" disabled={busy} onClick={close}>Cancel</button></div>
      </form>
      <section aria-label="Project lifecycle" style={{ marginTop: 24 }}>
        <h3>{current.status === 'ACTIVE' ? 'Archive project' : 'Restore project'}</h3>
        <p>Archiving hides the project from the active project list and prevents new assignments. Existing tasks, reminders and history stay unchanged. Archived projects remain available in the Archived list.</p>
        <p>Restoring uses an active-project slot in your plan.</p>
        {dirty && <p role="status">Save or discard your metadata changes before changing project status.</p>}
        <button disabled={busy || dirty || Boolean(conflict)} onClick={changeStatus}>{current.status === 'ACTIVE' ? 'Archive project' : 'Restore project'}</button>
      </section>
    </>}
  </dialog>;
}
