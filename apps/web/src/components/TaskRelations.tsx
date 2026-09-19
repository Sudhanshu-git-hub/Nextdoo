'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type Task } from '@/lib/api';
import { useTaskPages } from '@/lib/use-task-pages';
import { TaskPagination } from './TaskPagination';
interface Links { task: Task; parent: Task | null; parentUnavailable: boolean }
export function TaskRelations({ task, version, disabled, onBusyChange, onDraftChange, onChanged, onReload, onOpen }: {
 task: Task; version: number; disabled: boolean; onBusyChange: (busy: boolean) => void;
 onDraftChange: (dirty: boolean) => void; onChanged: (version?: number) => void;
 onReload: () => Promise<void>; onOpen: (task: Task) => void;
}) {
 const children = useTaskPages(task.workspaceId, `parentTaskId=${task.id}&includeArchived=true`);
 const dependencies = useTaskPages(task.workspaceId, `dependencyOfTaskId=${task.id}&includeArchived=true`);
 const [links, setLinks] = useState<Links | null>(null), [loadError, setLoadError] = useState<string | null>(null);
 const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false), [title, setTitle] = useState('');
 const [term, setTerm] = useState(''), [search, setSearch] = useState<{ q: string; key: string } | null>(null);
 const [announcement, setAnnouncement] = useState('');
 const request = useRef<AbortController | null>(null), locked = useRef(false);
 const attempt = useRef<{ identity: string; key: string } | null>(null);
 const status = useRef<HTMLParagraphElement>(null);
 useEffect(() => { onDraftChange(!!title.trim()); }, [title, onDraftChange]);
 const load = useCallback(async () => {
  request.current?.abort(); const controller = new AbortController(); request.current = controller;
  setLoadError(null);
  try { const result = await api<Links>(`/tasks/${task.id}/relations`, { signal: controller.signal }); if (!controller.signal.aborted) setLinks(result); }
  catch (caught) { if (!controller.signal.aborted) setLoadError(caught instanceof ApiError ? caught.problem.detail : 'Could not load relationships.'); }
 }, [task.id]);
 useEffect(() => { void load(); return () => request.current?.abort(); }, [load]);
 async function mutate(fields: object, subtask = false) {
  if (locked.current || disabled) return false;
  locked.current = true; setBusy(true); onBusyChange(true); setError(null);
  const path = `/tasks/${task.id}/${subtask ? 'subtasks' : 'relations'}`, body = JSON.stringify({ version, ...fields });
  const identity = `${path}:${body}`;
  if (attempt.current?.identity !== identity) attempt.current = { identity, key: crypto.randomUUID() };
  try {
   const result = await api<Task>(path, { method: subtask ? 'POST' : 'PATCH', headers: { 'Idempotency-Key': attempt.current.key }, body });
   attempt.current = null; onChanged(subtask ? undefined : result.version);
   await Promise.all([load(), children.reload(), dependencies.reload()]);
   setAnnouncement(subtask ? 'Subtask created.' : 'Relationships updated.'); status.current?.focus(); return true;
  } catch (caught) {
   setError(caught instanceof ApiError && caught.isConflict ? 'This task changed elsewhere. Your input is retained. Reload the task and review it before trying again.' : caught instanceof ApiError ? caught.problem.detail : 'Could not save. Your input is retained; retry checks the same request.');
   return false;
  } finally { locked.current = false; setBusy(false); onBusyChange(false); }
 }
 async function reloadAll() {
  if (disabled || locked.current) return;
  locked.current = true; setBusy(true); onBusyChange(true);
  try { await onReload(); await Promise.all([load(), children.reload(), dependencies.reload()]); setError(null); }
  catch (caught) { setError(caught instanceof ApiError ? caught.problem.detail : 'Could not reload the task. Your input is retained.'); }
  finally { locked.current = false; setBusy(false); onBusyChange(false); }
 }
 const blocked = disabled || busy || !links || !!loadError;
 return <section className="task-relations" aria-label="Task relationships">
  <p className="muted">Subtasks and prerequisites remain independent tasks. Completing, archiving or moving one does not change the others. Prerequisites describe order; they do not block completion.</p>
  {disabled && <p role="status">Save or discard task edits before changing relationships.</p>}
  <p role="status" tabIndex={-1} ref={status}>{announcement}</p>
  {(error || loadError) && <div role="alert" className="banner banner-error">{error || loadError}</div>}
  <button type="button" disabled={disabled || busy} onClick={() => void reloadAll()}>Reload task and relationships</button>
  <h3>Parent</h3>
  {links?.parent ? <button disabled={busy} onClick={() => onOpen(links.parent!)}>Open parent "{links.parent.title}"</button> : <p>{links?.parentUnavailable ? 'Parent unavailable. You can detach this task without deleting it.' : 'No parent task.'}</p>}
  {(links?.parent || links?.parentUnavailable) && <button disabled={blocked} onClick={() => void mutate({ parentTaskId: null })}>Remove parent</button>}
  <h3>Subtasks</h3>
  <p className="muted">New subtasks start in this task’s project and section, without copying its dates, estimates or priority.</p>
  <form className="row" onSubmit={async (e) => { e.preventDefault(); if (title.trim() && await mutate({ title: title.trim() }, true)) setTitle(''); }}>
   <label htmlFor="new-subtask">New subtask</label><input id="new-subtask" value={title} maxLength={500} disabled={busy} onChange={(e) => setTitle(e.target.value)} />
   <button type="submit" disabled={blocked || !title.trim()}>Add subtask</button>
  </form>
  <RelationList kind="subtask" page={children} onOpen={onOpen} disabled={busy} />
  <h3>Prerequisites</h3>
  <p className="muted">Deleted prerequisite tasks are hidden during retention; their links remain for recovery.</p>
  <RelationList kind="prerequisite" page={dependencies} onOpen={onOpen} disabled={busy} remove={(row) => void mutate({ removeDependencyId: row.id })} mutationDisabled={blocked} />
  <h3>Link an existing task</h3>
  <form className="row" onSubmit={(e) => { e.preventDefault(); setSearch({ q: term.trim(), key: crypto.randomUUID() }); }}>
   <label htmlFor="related-search">Find a related task</label><input id="related-search" maxLength={200} value={term} onChange={(e) => setTerm(e.target.value)} />
   <button type="submit">Search tasks</button>
  </form>
  <p className="muted">Search by whole words, or leave empty to browse. Links may span projects in your workspace.</p>
  {search && <TaskLookup key={search.key} workspaceId={task.workspaceId} excludeId={task.id} query={search.q} disabled={blocked}
   onParent={(id) => void mutate({ parentTaskId: id })} onDependency={(id) => void mutate({ addDependencyId: id })} />}
 </section>;
}
function RelationList({ kind, page, onOpen, disabled, remove, mutationDisabled }: {
 kind: 'subtask' | 'prerequisite'; page: ReturnType<typeof useTaskPages>; onOpen: (task: Task) => void;
 disabled: boolean; remove?: (task: Task) => void; mutationDisabled?: boolean;
}) {
 return <section aria-label={kind === 'subtask' ? 'Subtask list' : 'Prerequisite list'} aria-busy={page.loading}>
  {!page.loading && !page.error && !page.tasks.length && <p>No {kind === 'subtask' ? 'subtasks' : 'prerequisites'}.</p>}
  <ul>{page.tasks.map((row) => <li key={row.id} className="row" style={{ marginBottom: 8 }}>
   <button disabled={disabled} onClick={() => onOpen(row)}>Open {kind} "{row.title}"</button><span className="muted">{row.status.toLowerCase()}</span>
   {remove && <button disabled={mutationDisabled} aria-label={`Remove prerequisite "${row.title}"`} onClick={() => remove(row)}>Remove</button>}
  </li>)}</ul>
  <TaskPagination {...page} count={page.tasks.length} onMore={page.loadMore} onRetry={page.tasks.length ? page.loadMore : page.reload} />
 </section>;
}
function TaskLookup({ workspaceId, excludeId, query, disabled, onParent, onDependency }: {
 workspaceId: string; excludeId: string; query: string; disabled: boolean; onParent: (id: string) => void; onDependency: (id: string) => void;
}) {
 const page = useTaskPages(workspaceId, `includeArchived=true&q=${encodeURIComponent(query)}`);
 const [selected, setSelected] = useState('');
 return <div>
  <label htmlFor="related-task">Select related task</label><select id="related-task" value={selected} onChange={(e) => setSelected(e.target.value)} disabled={disabled}>
   <option value="">Choose a task</option>{page.tasks.filter((t) => t.id !== excludeId).map((t) => <option key={t.id} value={t.id}>{t.title} · {t.status.toLowerCase()} · {t.id.slice(-6)}</option>)}
  </select>
  <div className="row"><button disabled={disabled || !selected} onClick={() => onParent(selected)}>Set parent</button><button disabled={disabled || !selected} onClick={() => onDependency(selected)}>Add prerequisite</button></div>
  <TaskPagination {...page} count={page.tasks.length} onMore={page.loadMore} onRetry={page.tasks.length ? page.loadMore : page.reload} />
 </div>;
}
