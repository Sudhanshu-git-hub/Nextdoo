'use client';
import { KnowledgeBacklinks } from '@/components/knowledge/shared';
import { TaskAttachments } from '@/components/TaskAttachments';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type Task } from '@/lib/api';
import { TaskEditor } from '@/components/TaskEditor';
import { useTaskPages } from '@/lib/use-task-pages';
import { TaskPagination } from '@/components/TaskPagination';

type Status = 'ACTIVE' | 'COMPLETED' | 'ARCHIVED';
interface Entity { id: string; identifier: string; title: string; description: string | null; dueAt: string | null; status: Status; version: number; }
interface Goal extends Entity { parentGoalId: string | null; category: string | null; priority: 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH'; startAt: string | null; }
interface Progress { percent: number | null; completed: number; total: number; }
interface GoalPage { data: Array<{ goal: Goal; progress: Progress }>; nextCursor: string | null; }
interface Detail {
  goal: Goal; progress: Progress; parent: Goal | null; children: Goal[]; taskIds: string[];
  milestones: Array<Entity & { progress: Progress; taskIds: string[] }>;
  linkedTasks: Array<{ id: string; title: string; status: string; completedAt: string | null }>;
}
const errorText = (error: unknown) => error instanceof ApiError ? error.problem.detail : 'Could not reach the server. Your input is kept; retry when connected.';
const localDate = (value: string | null) => value ? new Date(new Date(value).getTime() - new Date(value).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';

/** A failed request retains its key and exact body. Double clicks cannot start a second command. */
function useGoalCommand() {
  const pending = useRef<{ identity: string; key: string } | null>(null), lock = useRef(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  async function send<T>(path: string, body: object, method = 'POST'): Promise<T | null> {
    if (lock.current) return null;
    lock.current = true; setBusy(true); setError(null); setConflict(false);
    const encoded = JSON.stringify(body), identity = `${method}:${path}:${encoded}`;
    if (pending.current?.identity !== identity) pending.current = { identity, key: crypto.randomUUID() };
    try {
      const result = await api<T>(path, { method, headers: { 'Idempotency-Key': pending.current.key }, body: encoded });
      pending.current = null; return result;
    } catch (caught) {
      setError(errorText(caught)); setConflict(caught instanceof ApiError && caught.isConflict); return null;
    } finally { lock.current = false; setBusy(false); }
  }
  return { send, busy, error, conflict, clear: () => { setError(null); setConflict(false); } };
}

function ProgressText({ value }: { value: Progress }) {
  return <p className="muted">{value.percent === null ? 'Not measured — link tasks or add milestones to track progress.' : `${value.percent}% · ${value.completed} of ${value.total} work items complete`}</p>;
}

export function GoalsView({ workspaceId }: { workspaceId: string }) {
  const [rows, setRows] = useState<GoalPage['data']>([]), [cursor, setCursor] = useState<string | null>(null);
  const [archived, setArchived] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const load = useCallback(async (after?: string) => {
    controller.current?.abort(); const request = new AbortController(); controller.current = request;
    setLoading(true); setError(null);
    try {
      const result = await api<GoalPage>(`/goals?includeArchived=${archived}${after ? `&after=${after}` : ''}`, { signal: request.signal });
      if (!request.signal.aborted) { setRows((old) => after ? [...old, ...result.data] : result.data); setCursor(result.nextCursor); }
    } catch (caught) { if (!request.signal.aborted) setError(errorText(caught)); }
    finally { if (!request.signal.aborted) setLoading(false); }
  }, [archived]);
  useEffect(() => { void load(); return () => controller.current?.abort(); }, [load]);
  return <div className="goals-view">
    <h1>Goal Center</h1><p className="subtitle">Connect what you want to achieve with the work that moves it forward.</p>
    <GoalForm workspaceId={workspaceId} onSaved={() => void load()} />
    <div className="row"><label><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Include archived goals</label>
      <button disabled={loading} onClick={() => void load()}>Refresh goals</button></div>
    {error && <p role="alert">{error}</p>}
    {loading && <p role="status">Loading goals…</p>}
    {!loading && !error && !rows.length && <div className="empty"><h2>No goals yet</h2><p>Start with one outcome you care about, then add milestones and link tasks.</p></div>}
    <div className="grid grid-2">{rows.map(({ goal, progress }) => <article className="card" key={goal.id}>
      <p className="muted">{goal.identifier} · {goal.status.toLowerCase()}{goal.category ? ` · ${goal.category}` : ''}</p>
      <h2><Link href={`/goals/${goal.id}`}>{goal.title}</Link></h2>
      {goal.parentGoalId && <Link href={`/goals/${goal.parentGoalId}`}>View parent goal</Link>}
      <ProgressText value={progress} />
      {goal.dueAt && <p>Target: <time dateTime={goal.dueAt}>{new Date(goal.dueAt).toLocaleString()}</time></p>}
    </article>)}</div>
    {cursor && <button disabled={loading} onClick={() => void load(cursor)}>Load more goals</button>}
  </div>;
}

function GoalForm({ workspaceId, initial, parentId, onSaved }: { workspaceId: string; initial?: Goal; parentId?: string; onSaved: () => void }) {
  const [base] = useState(initial);
  const [title, setTitle] = useState(initial?.title ?? ''), [description, setDescription] = useState(initial?.description ?? '');
  const [category, setCategory] = useState(initial?.category ?? ''), [priority, setPriority] = useState(initial?.priority ?? 'NONE');
  const [start, setStart] = useState(localDate(initial?.startAt ?? null)), [due, setDue] = useState(localDate(initial?.dueAt ?? null));
  const [parent, setParent] = useState(parentId ?? initial?.parentGoalId ?? ''), [version, setVersion] = useState(initial?.version ?? 1);
  const [latest, setLatest] = useState<Goal | null>(null), [loadError, setLoadError] = useState<string | null>(null), [saved, setSaved] = useState(false);
  const command = useGoalCommand();
  const prefix = initial ? `edit-${initial.id}` : parentId ? `sub-${parentId}` : 'new-goal';
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setSaved(false);
    const fields = { title: title.trim(), description: description || null, category: category.trim() || null, priority,
      startAt: start === localDate(base?.startAt ?? null) ? base?.startAt ?? null : start ? new Date(start).toISOString() : null,
      dueAt: due === localDate(base?.dueAt ?? null) ? base?.dueAt ?? null : due ? new Date(due).toISOString() : null,
      parentGoalId: parent || null };
    const patch = base ? Object.fromEntries(Object.entries(fields).filter(([key, value]) => value !== base[key as keyof Goal])) : fields;
    if (initial && !Object.keys(patch).length) { setLoadError('Change a field before saving.'); return; }
    const result = await command.send<Goal>(initial ? `/goals/${initial.id}` : '/goals', initial ? { ...patch, version } : { ...fields, workspaceId }, initial ? 'PATCH' : 'POST');
    if (result) { setVersion(result.version); setSaved(true); if (!initial) { setTitle(''); setDescription(''); setCategory(''); setStart(''); setDue(''); setPriority('NONE'); } onSaved(); }
  }
  async function reviewLatest() {
    if (!initial) return;
    try { setLatest((await api<Detail>(`/goals/${initial.id}`)).goal); setLoadError(null); }
    catch (caught) { setLoadError(errorText(caught)); }
  }
  return <form className="card" onSubmit={(e) => void submit(e)} aria-label={initial ? 'Edit goal' : parentId ? 'New sub-goal' : 'New goal'}>
    <h2>{initial ? 'Edit goal' : parentId ? 'New sub-goal' : 'New goal'}</h2>
    <fieldset disabled={command.busy} style={{ border: 0, padding: 0 }}>
      <label htmlFor={`${prefix}-title`}>Goal title</label><input id={`${prefix}-title`} value={title} maxLength={300} required onChange={(e) => setTitle(e.target.value)} />
      <label htmlFor={`${prefix}-description`}>Description</label><textarea id={`${prefix}-description`} value={description} maxLength={20000} onChange={(e) => setDescription(e.target.value)} />
      <div className="grid grid-2"><div><label htmlFor={`${prefix}-category`}>Area of life</label><input id={`${prefix}-category`} value={category} maxLength={100} onChange={(e) => setCategory(e.target.value)} /></div>
        <div><label htmlFor={`${prefix}-priority`}>Priority</label><select id={`${prefix}-priority`} value={priority} onChange={(e) => setPriority(e.target.value as Goal['priority'])}>{['NONE', 'LOW', 'MEDIUM', 'HIGH'].map((p) => <option key={p} value={p}>{p.toLowerCase()}</option>)}</select></div>
        <div><label htmlFor={`${prefix}-start`}>Start date and time</label><input id={`${prefix}-start`} type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} /></div>
        <div><label htmlFor={`${prefix}-due`}>Target date and time</label><input id={`${prefix}-due`} type="datetime-local" value={due} min={start || undefined} onChange={(e) => setDue(e.target.value)} /></div></div>
      {!parentId && <ParentPicker id={`${prefix}-parent`} value={parent} excludeId={initial?.id} onChange={setParent} />}
      <p className="muted">Dates use your browser’s time zone. Goal changes need an internet connection.</p>
      {command.error && <p role="alert">{command.error} Your draft is kept.</p>}{loadError && <p role="alert">{loadError}</p>}
      {command.conflict && <button type="button" onClick={() => void reviewLatest()}>Review latest goal</button>}
      {latest && <div className="banner"><p>Latest saved goal: {latest.title} · version {latest.version}. Compare it with your draft before applying your changes.</p>
        <p>{latest.description}</p><p>{latest.category} · {latest.priority.toLowerCase()}</p>
        <button type="button" onClick={() => { setVersion(latest.version); setLatest(null); command.clear(); }}>Use latest version and keep my draft</button></div>}
      <button className="btn-primary" disabled={command.busy || command.conflict || !title.trim()} type="submit">{command.busy ? 'Saving…' : initial ? 'Save goal' : 'Create goal'}</button>
      {saved && <p role="status">Goal saved.</p>}
    </fieldset>
  </form>;
}

function ParentPicker({ id, value, excludeId, onChange }: { id: string; value: string; excludeId?: string; onChange: (value: string) => void }) {
  const [options, setOptions] = useState<Goal[]>([]), [cursor, setCursor] = useState<string | null>(null), [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async (after?: string) => {
    setBusy(true);
    try { const page = await api<GoalPage>(`/goals${after ? `?after=${after}` : ''}`); setOptions((rows) => after ? [...rows, ...page.data.map((r) => r.goal)] : page.data.map((r) => r.goal)); setCursor(page.nextCursor); setError(null); }
    catch (caught) { setError(errorText(caught)); } finally { setBusy(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  return <><label htmlFor={id}>Parent goal</label><select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
    <option value="">No parent</option>{value && !options.some((g) => g.id === value) && <option value={value}>Current parent (kept)</option>}
    {options.filter((g) => g.id !== excludeId).map((g) => <option key={g.id} value={g.id}>{g.identifier} · {g.title}</option>)}
  </select>{cursor && <button type="button" disabled={busy} onClick={() => void load(cursor)}>Load more parent goals</button>}
    {error && <p role="alert">{error} <button type="button" onClick={() => void load()}>Retry parents</button></p>}</>;
}

export function GoalDetailView({ workspaceId, goalId }: { workspaceId: string; goalId: string }) {
  const [detail, setDetail] = useState<Detail | null>(null), [error, setError] = useState<string | null>(null), [loading, setLoading] = useState(true);
  const [edit, setEdit] = useState(false), [subGoal, setSubGoal] = useState(false), [task, setTask] = useState<Task | null>(null);
  const controller = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    controller.current?.abort(); const request = new AbortController(); controller.current = request;
    setLoading(true);
    try { const data = await api<Detail>(`/goals/${goalId}`, { signal: request.signal }); if (!request.signal.aborted) { setDetail(data); setError(null); } }
    catch (caught) { if (!request.signal.aborted) setError(errorText(caught)); }
    finally { if (!request.signal.aborted) setLoading(false); }
  }, [goalId]);
  useEffect(() => { void load(); return () => controller.current?.abort(); }, [load]);
  async function openTask(id: string) { try { setTask(await api<Task>(`/tasks/${id}`)); } catch (caught) { setError(errorText(caught)); } }
  if (!detail) return <><Link href="/goals">Back to goals</Link>{loading ? <p role="status">Loading goal…</p> : <p role="alert">{error}</p>}<button onClick={() => void load()}>Retry</button></>;
  const { goal } = detail;
  return <div className="goals-view">
    <Link href="/goals">Back to goals</Link>{detail.parent && <> · <Link href={`/goals/${detail.parent.id}`}>Parent: {detail.parent.title}</Link></>}
    <p className="muted">{goal.identifier} · {goal.status.toLowerCase()}</p><h1>{goal.title}</h1>
    <KnowledgeBacklinks kind="goal" id={goal.id} />
    <TaskAttachments goalId={goal.id} disabled={goal.status==='ARCHIVED'} />
    <p>{goal.description}</p><p>{goal.category} · Priority: {goal.priority.toLowerCase()}</p>
    {goal.startAt && <p>Start: <time dateTime={goal.startAt}>{new Date(goal.startAt).toLocaleString()}</time></p>}
    {goal.dueAt && <p>Target: <time dateTime={goal.dueAt}>{new Date(goal.dueAt).toLocaleString()}</time></p>}
    <ProgressText value={detail.progress} />
    <p className="muted">Progress counts each linked task once across this goal and its sub-goals, plus milestones without tasks. Archived sub-goals and milestones are excluded. Marking the goal complete does not change measured progress.</p>
    {error && <p role="alert">{error}</p>}
    <div className="row"><button disabled={loading} onClick={() => void load()}>Refresh goal</button><button onClick={() => setEdit((v) => !v)}>{edit ? 'Close goal editor' : 'Edit goal'}</button></div>
    <StatusButtons entity={goal} path={`/goals/${goal.id}`} onSaved={() => void load()} />
    {edit && <GoalForm key={goal.id} initial={goal} workspaceId={workspaceId} onSaved={() => { setEdit(false); void load(); }} />}
    <section aria-label="Sub-goals"><h2>Sub-goals</h2><ul>{detail.children.map((g) => <li key={g.id}><Link href={`/goals/${g.id}`}>{g.identifier} · {g.title}</Link> · {g.status.toLowerCase()}</li>)}</ul>
      {!detail.children.length && <p>No sub-goals yet.</p>}{goal.status === 'ACTIVE' && <button onClick={() => setSubGoal((v) => !v)}>{subGoal ? 'Close sub-goal form' : 'Add sub-goal'}</button>}
      {subGoal && <GoalForm workspaceId={workspaceId} parentId={goal.id} onSaved={() => { setSubGoal(false); void load(); }} />}</section>
    <section aria-label="Goal tasks"><h2>Tasks for this goal</h2>
      <TaskLinks workspaceId={workspaceId} entity={goal} path={`/goals/${goal.id}`} taskIds={detail.taskIds} tasks={detail.linkedTasks} onOpen={(id) => void openTask(id)} onSaved={() => void load()} />
    </section>
    <section aria-label="Milestones"><h2>Milestones</h2>
      {!detail.milestones.length && <p>Add a milestone for the next meaningful step.</p>}
      {detail.milestones.map((m) => <article className="card" key={m.id} id={`milestone-${m.id}`} aria-label={`${m.identifier} ${m.title}`}>
        <h3>{m.identifier} · {m.title}</h3><p>{m.status.toLowerCase()}</p><p>{m.description}</p>
        {m.dueAt && <p>Target: <time dateTime={m.dueAt}>{new Date(m.dueAt).toLocaleString()}</time></p>}
        <ProgressText value={m.progress} /><StatusButtons entity={m} path={`/milestones/${m.id}`} onSaved={() => void load()} />
        <KnowledgeBacklinks kind="milestone" id={m.id} />
        <details><summary>Edit milestone</summary><MilestoneForm initial={m} goalId={goal.id} onSaved={() => void load()} /></details>
        <TaskLinks workspaceId={workspaceId} entity={m} path={`/milestones/${m.id}`} taskIds={m.taskIds} tasks={detail.linkedTasks} onOpen={(id) => void openTask(id)} onSaved={() => void load()} canLink={goal.status === 'ACTIVE'} />
      </article>)}
      {goal.status === 'ACTIVE' && <MilestoneForm goalId={goal.id} onSaved={() => void load()} />}
    </section>
    {task && <TaskEditor task={task} onClose={() => { setTask(null); void load(); }} onSaved={() => void load()} />}
  </div>;
}

function StatusButtons({ entity, path, onSaved }: { entity: Entity; path: string; onSaved: () => void }) {
  const command = useGoalCommand();
  async function change(status: Status) {
    if (status === 'ARCHIVED' && !window.confirm(`Archive “${entity.title}”? Linked tasks keep their current state.`)) return;
    if (await command.send(path + '/status', { version: entity.version, status })) onSaved();
  }
  return <><div className="row" role="group" aria-label={`Status of ${entity.title}`}>
    {entity.status !== 'COMPLETED' && <button disabled={command.busy} onClick={() => void change('COMPLETED')}>Mark complete</button>}
    {entity.status !== 'ACTIVE' && <button disabled={command.busy} onClick={() => void change('ACTIVE')}>{entity.status === 'ARCHIVED' ? 'Restore' : 'Reopen'}</button>}
    {entity.status !== 'ARCHIVED' && <button disabled={command.busy} onClick={() => void change('ARCHIVED')}>Archive</button>}
  </div>{command.error && <p role="alert">{command.error} {command.conflict && <button onClick={() => { command.clear(); onSaved(); }}>Reload latest version</button>}</p>}</>;
}

function MilestoneForm({ goalId, initial, onSaved }: { goalId: string; initial?: Entity; onSaved: () => void }) {
  const [base, setBase] = useState(initial), [latest, setLatest] = useState<Entity | null>(null);
  const [title, setTitle] = useState(initial?.title ?? ''), [description, setDescription] = useState(initial?.description ?? ''), [due, setDue] = useState(localDate(initial?.dueAt ?? null));
  const [version, setVersion] = useState(initial?.version ?? 1), [message, setMessage] = useState<string | null>(null);
  const command = useGoalCommand(), prefix = initial?.id ?? 'new-milestone';
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const fields = { title: title.trim(), description: description || null, dueAt: due === localDate(base?.dueAt ?? null) ? base?.dueAt ?? null : due ? new Date(due).toISOString() : null };
    const patch = base ? Object.fromEntries(Object.entries(fields).filter(([key, value]) => value !== base[key as keyof Entity])) : fields;
    if (initial && !Object.keys(patch).length) { setMessage('Change a field before saving.'); return; }
    const result = await command.send<Entity>(initial ? `/milestones/${initial.id}` : `/goals/${goalId}/milestones`, { ...patch, ...(initial ? { version } : {}) }, initial ? 'PATCH' : 'POST');
    if (result) { if (!initial) { setTitle(''); setDescription(''); setDue(''); } else { setBase(result); setTitle(result.title); setDescription(result.description ?? ''); setDue(localDate(result.dueAt)); } setVersion(result.version); setMessage('Milestone saved.'); onSaved(); }
  }
  async function review() {
    try { const detail = await api<Detail>(`/goals/${goalId}`); setLatest(detail.milestones.find((m) => m.id === initial?.id) ?? null); }
    catch (caught) { setMessage(errorText(caught)); }
  }
  return <form onSubmit={(e) => void submit(e)} aria-label={initial ? `Edit ${initial.identifier}` : 'New milestone'} className="card">
    <h3>{initial ? 'Edit milestone' : 'New milestone'}</h3><fieldset disabled={command.busy} style={{ border: 0, padding: 0 }}>
      <label htmlFor={`${prefix}-title`}>Milestone title</label><input id={`${prefix}-title`} value={title} required maxLength={300} onChange={(e) => setTitle(e.target.value)} />
      <label htmlFor={`${prefix}-description`}>Description</label><textarea id={`${prefix}-description`} value={description} maxLength={20000} onChange={(e) => setDescription(e.target.value)} />
      <label htmlFor={`${prefix}-due`}>Milestone date and time</label><input id={`${prefix}-due`} type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
      <button type="submit" disabled={command.conflict || !title.trim()}>{initial ? 'Save milestone' : 'Add milestone'}</button>
      {command.error && <p role="alert">{command.error} Your draft is kept.</p>}
      {command.conflict && initial && <button type="button" onClick={() => void review()}>Review latest milestone</button>}
      {latest && <div><p>Latest saved milestone: {latest.title} · {latest.description} · {latest.dueAt ? new Date(latest.dueAt).toLocaleString() : 'No target date'}</p>
        <button type="button" onClick={() => { setVersion(latest.version); setLatest(null); command.clear(); }}>Use latest version and keep draft</button></div>}
      {message && <p role="status">{message}</p>}
    </fieldset>
  </form>;
}

function TaskLinks({ workspaceId, entity, path, taskIds, tasks, onSaved, onOpen, canLink = true }: {
  workspaceId: string; entity: Entity; path: string; taskIds: string[]; tasks: Detail['linkedTasks']; onSaved: () => void; onOpen: (id: string) => void; canLink?: boolean;
}) {
  const command = useGoalCommand(), [search, setSearch] = useState<string | null>(null), [term, setTerm] = useState('');
  async function link(taskId: string, linked: boolean) { if (await command.send(path + '/tasks', { taskId, linked, version: entity.version })) onSaved(); }
  return <section aria-label={`Linked tasks for ${entity.identifier}`}>
    <ul>{taskIds.map((id) => { const task = tasks.find((t) => t.id === id); return task && <li key={id}>
      {task.status === 'DELETED' ? <span>Deleted task</span> : <button disabled={command.busy} onClick={() => onOpen(id)}>{task.title}</button>} · {task.status.toLowerCase()}
      <button disabled={command.busy} aria-label={`Unlink ${task.title} from ${entity.identifier}`} onClick={() => void link(id, false)}>Unlink</button>
    </li>; })}</ul>
    {!taskIds.length && <p>No linked tasks.</p>}
    {canLink && entity.status === 'ACTIVE' && <form className="row" onSubmit={(e) => { e.preventDefault(); setSearch(term.trim()); }}>
      <label htmlFor={`search-${entity.id}`}>Find tasks to link</label><input id={`search-${entity.id}`} value={term} maxLength={200} onChange={(e) => setTerm(e.target.value)} />
      <button disabled={command.busy} type="submit">Search tasks</button>
    </form>}
    {search !== null && canLink && entity.status === 'ACTIVE' && <TaskSearch workspaceId={workspaceId} term={search} linkedIds={taskIds} busy={command.busy} onLink={(id) => void link(id, true)} />}
    {command.error && <p role="alert">{command.error} {command.conflict && <button onClick={() => { command.clear(); onSaved(); }}>Reload links</button>}</p>}
  </section>;
}

function TaskSearch({ workspaceId, term, linkedIds, busy, onLink }: { workspaceId: string; term: string; linkedIds: string[]; busy: boolean; onLink: (id: string) => void }) {
  const page = useTaskPages(workspaceId, `includeArchived=true&q=${encodeURIComponent(term)}`);
  return <div>{page.loading && <p role="status">Searching tasks…</p>}{page.error && <p role="alert">{page.error}</p>}
    <ul>{page.tasks.filter((t) => !linkedIds.includes(t.id)).map((t) => <li key={t.id}>{t.title} · {t.status.toLowerCase()} <button disabled={busy} onClick={() => onLink(t.id)} aria-label={`Link ${t.title}`}>Link task</button></li>)}</ul>
    {!page.loading && !page.error && !page.tasks.length && <p>No matching tasks. Create a task in Inbox, then link it here.</p>}
    <TaskPagination {...page} count={page.tasks.length} onMore={page.loadMore} onRetry={page.reload} />
  </div>;
}
