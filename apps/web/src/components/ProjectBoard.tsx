'use client';

import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { api, ApiError, type Task } from '@/lib/api';
import type { Project } from './ProjectSettings';
import { TaskList } from './TaskList';

interface Section { id: string; name: string; version: number; position: string }
const DRAG_TYPE = 'application/x-nextdoo-task';

/** A board of the loaded active-task pages, not unbounded column totals or card ordering. */
export function ProjectBoard({ project, tasks, loading, error: taskError, onChanged }: {
  project: Project; tasks: Task[]; loading: boolean; error: string | null; onChanged: () => Promise<void>;
}) {
  const [sections, setSections] = useState<Section[]>([]);
  const [sectionsLoading, setSectionsLoading] = useState(true);
  const [sectionError, setSectionError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingMove, setPendingMove] = useState<{ task: Task; baseline: Task[] } | null>(null);
  const [destinations, setDestinations] = useState<Record<string, string>>({});
  const [announcement, setAnnouncement] = useState('');
  const status = useRef<HTMLParagraphElement>(null);
  const locked = useRef(false);
  const request = useRef<AbortController | null>(null);
  // Keep uncertain-response retries idempotent while this board remains mounted.
  const attempt = useRef<{ identity: string; key: string } | null>(null);
  const archived = project.status === 'ARCHIVED';
  const load = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setSectionsLoading(true); setSectionError(null);
    try {
      const result = await api<{ data: Section[] }>(`/sections?projectId=${project.id}`, { signal: controller.signal });
      if (!controller.signal.aborted) setSections(result.data);
    } catch (caught) {
      if (!controller.signal.aborted) setSectionError(caught instanceof ApiError ? caught.problem.detail : 'Could not load sections.');
    } finally { if (!controller.signal.aborted) setSectionsLoading(false); }
  }, [project.id]);
  useEffect(() => { void load(); return () => request.current?.abort(); }, [load]);

  async function mutate(path: string, body: object, method = 'PATCH') {
    const json = JSON.stringify(body), identity = `${method}:${path}:${json}`;
    if (attempt.current?.identity !== identity) attempt.current = { identity, key: crypto.randomUUID() };
    const result = await api(path, { method, headers: { 'Idempotency-Key': attempt.current.key }, body: json });
    attempt.current = null;
    return result;
  }
  async function changeSection(section: Section | null, fields: { name?: string; beforeId?: string | null }) {
    if (locked.current || archived) return false;
    locked.current = true; setBusy(true); setError(null);
    try {
      await mutate(section ? `/sections/${section.id}` : '/sections', section ? { version: section.version, ...fields } : { projectId: project.id, ...fields }, section ? 'PATCH' : 'POST');
      await load();
      setAnnouncement(section ? 'Section updated.' : 'Section added.');
      return true;
    } catch (caught) {
      if (caught instanceof ApiError && caught.isConflict) {
        setError(`This section changed or its requested position is unavailable. ${caught.problem.detail} The latest name and order are shown; your draft is retained. Review it before saving again.`);
        await load();
      } else setError(caught instanceof ApiError ? caught.problem.detail : 'Could not save the section. Retry to check the same request.');
      return false;
    } finally { locked.current = false; setBusy(false); }
  }
  async function move(task: Task, sectionId: string | null) {
    if (locked.current || archived || (task.sectionId ?? null) === sectionId) return;
    locked.current = true; setBusy(true); setError(null);
    setPendingMove({ task: { ...task, sectionId }, baseline: tasks });
    setDestinations((values) => ({ ...values, [task.id]: sectionId ?? '' }));
    setAnnouncement(`Moving "${task.title}"; waiting for confirmation.`); status.current?.focus();
    try {
      await mutate(`/tasks/${task.id}`, { version: task.version, sectionId });
      await onChanged();
      setDestinations((values) => { const { [task.id]: _removed, ...rest } = values; return rest; });
      setAnnouncement(`Moved "${task.title}" to ${sections.find((s) => s.id === sectionId)?.name ?? 'Unsectioned'}.`);
      status.current?.focus();
    } catch (caught) {
      setPendingMove(null);
      setAnnouncement('Move not confirmed. Review the error before retrying.'); status.current?.focus();
      if (caught instanceof ApiError && caught.isConflict) {
        setError('This task changed elsewhere. Refreshing tasks; your move was not applied. Review the latest task before trying again.');
        await onChanged();
      } else setError(caught instanceof ApiError ? caught.problem.detail : 'Could not move the task. Retry to check the same request.');
    } finally { setPendingMove(null); locked.current = false; setBusy(false); }
  }
  function drop(event: DragEvent, sectionId: string | null) {
    event.preventDefault();
    if (busy || archived || loading || sectionError || sectionsLoading) return;
    try {
      const item: { id?: string; version?: number } = JSON.parse(event.dataTransfer.getData(DRAG_TYPE));
      const task = tasks.find((t) => t.id === item.id && t.version === item.version);
      if (task) void move(task, sectionId);
    } catch { /* Ignore foreign drag formats; the server revalidates all references. */ }
  }
  const disabled = busy || archived || loading || sectionsLoading || !!sectionError;
  const baseRows = pendingMove && !tasks.length ? pendingMove.baseline : tasks;
  const displayedTasks = baseRows.map((t) => pendingMove?.task.id === t.id ? pendingMove.task : t);
  if (pendingMove && !baseRows.some((t) => t.id === pendingMove.task.id)) displayedTasks.push(pendingMove.task);
  const known = new Set(sections.map((s) => s.id));
  const columns = [...sections, { id: '', name: 'Unsectioned', version: 0, position: '' }];
  return <div className="project-board">
    <p id="board-help" className="muted">Loaded active tasks only; counts are not project totals. Load more below. Drag a task to a section, or choose its destination and press Move. Open a task to move it to another project.</p>
    <p role="status" tabIndex={-1} ref={status}>{announcement}</p>
    {error && <div className="banner banner-error" role="alert">{error}</div>}
    {sectionError && <div className="banner banner-error" role="alert">{sectionError} <button onClick={() => void load()}>Retry sections</button></div>}
    {taskError && <div className="banner banner-error" role="alert">{taskError} <button onClick={() => void onChanged()}>Retry tasks</button></div>}
    <form className="row" onSubmit={async (event) => { event.preventDefault(); if (name.trim() && await changeSection(null, { name: name.trim() })) setName(''); }}>
      <label htmlFor="new-section">New section</label>
      <input id="new-section" maxLength={200} value={name} disabled={disabled} onChange={(event) => setName(event.target.value)} />
      <button disabled={disabled || !name.trim()} type="submit">Add section</button>
    </form>
    {sectionsLoading && <p role="status">Loading sections…</p>}
    <fieldset disabled={!!pendingMove} style={{ border: 0, padding: 0, minWidth: 0 }} aria-label="Board task movement"><div className="board-columns" aria-busy={loading || sectionsLoading || !!pendingMove}>
      {columns.map((section, index) => {
        const rows = displayedTasks.filter((task) => section.id ? task.sectionId === section.id : !task.sectionId || !known.has(task.sectionId));
        return <section key={section.id} className="card board-column" data-section-id={section.id || undefined} aria-label={`${section.name} section`}
          onDragOver={(event) => { if (!disabled && event.dataTransfer.types.includes(DRAG_TYPE)) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } }} onDrop={(event) => drop(event, section.id || null)}>
          {section.id ? <SectionHeading section={section} disabled={disabled} first={index === 0} last={index === sections.length - 1}
            rename={(name) => changeSection(section, { name })}
            reorder={(earlier) => changeSection(section, { beforeId: earlier ? sections[index - 1]!.id : sections[index + 2]?.id ?? null })} /> : <h2>Unsectioned</h2>}
          <p className="muted">{rows.length} loaded</p>
          <TaskList tasks={rows} loading={loading && !tasks.length} error={null} emptyTitle="No loaded tasks" emptyBody="Move a task here, or load more tasks below." onChanged={onChanged}
            onTaskDrag={disabled ? undefined : (task, event) => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ id: task.id, version: task.version })); }}
            taskActions={(task) => <TaskDestination key={`${task.id}:${task.version}`} task={task} sections={sections} disabled={disabled} move={move} target={destinations[task.id] ?? task.sectionId ?? ''} setTarget={(value) => setDestinations((values) => ({ ...values, [task.id]: value }))} />} />
        </section>;
      })}
    </div></fieldset>
  </div>;
}

function SectionHeading({ section, disabled, first, last, rename, reorder }: {
  section: Section; disabled: boolean; first: boolean; last: boolean;
  rename: (name: string) => Promise<boolean>; reorder: (earlier: boolean) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState(section.name);
  const trigger = useRef<HTMLButtonElement>(null), input = useRef<HTMLInputElement>(null), heading = useRef<HTMLHeadingElement>(null);
  const [focusTarget, setFocusTarget] = useState<'trigger' | 'heading' | null>(null);
  useEffect(() => { if (editing) input.current?.focus(); }, [editing]);
  useEffect(() => {
    if (disabled || !focusTarget) return;
    (focusTarget === 'trigger' ? trigger.current : heading.current)?.focus();
    setFocusTarget(null);
  }, [disabled, focusTarget]);
  function close() { setEditing(false); setFocusTarget('trigger'); }
  async function moveHeading(earlier: boolean) { await reorder(earlier); setFocusTarget('heading'); }
  return <>
    <h2 ref={heading} tabIndex={-1}>{section.name}</h2>
    <div className="row">
      <button ref={trigger} className="btn-sm" disabled={disabled || editing} onClick={() => { setDraft(section.name); setEditing(true); }}>Rename section</button>
      <button className="btn-sm" disabled={disabled || first} onClick={() => void moveHeading(true)}>Move section earlier</button>
      <button className="btn-sm" disabled={disabled || last} onClick={() => void moveHeading(false)}>Move section later</button>
    </div>
    {editing && <form onSubmit={async (event) => { event.preventDefault(); if (await rename(draft.trim())) close(); }}>
      <label htmlFor={`section-name-${section.id}`}>Section name</label>
      <input id={`section-name-${section.id}`} ref={input} value={draft} maxLength={200} disabled={disabled} onChange={(e) => setDraft(e.target.value)} />
      <button type="submit" disabled={disabled || !draft.trim()}>Save section name</button>
      <button type="button" disabled={disabled} onClick={close}>Cancel rename</button>
    </form>}
  </>;
}
function TaskDestination({ task, sections, disabled, move, target, setTarget }: { target: string; setTarget: (value: string) => void; task: Task; sections: Section[]; disabled: boolean; move: (task: Task, id: string | null) => Promise<void> }) {
  const current = task.sectionId ?? '';
  return <div className="row board-movement">
    <label className="sr-only" htmlFor={`destination-${task.id}`}>Destination for "{task.title}"</label>
    <select id={`destination-${task.id}`} value={target} disabled={disabled} onChange={(e) => setTarget(e.target.value)} aria-describedby="board-help">
      <option value="">Unsectioned</option>
      {current && !sections.some((s) => s.id === current) && <option value={current}>Unavailable section</option>}
      {sections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
    </select>
    <button className="btn-sm" aria-label={`Move "${task.title}"`} disabled={disabled || target === current} onClick={() => void move(task, target || null)}>Move</button>
  </div>;
}
