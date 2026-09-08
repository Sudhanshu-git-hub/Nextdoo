'use client';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { TaskList } from '@/components/TaskList';
import { TaskPagination } from '@/components/TaskPagination';
import { useTaskPages } from '@/lib/use-task-pages';

type Option = { id: string; name: string };
const defaults = { q: '', status: 'ACTIVE', project: '', tagId: '', priority: '', hasDueDate: '', from: '', through: '', sortBy: 'createdAt', sortOrder: 'desc' };
/** Explicitly applied, online-only workspace search. Inbox/Today retain their fixed semantics. */
export function TaskBrowserView({ workspaceId, projects, tags }: { workspaceId: string; projects: Option[]; tags: Option[] }) {
  const [draft, setDraft] = useState(defaults);
  const [applied, setApplied] = useState(defaults);
  const [filters, setFilters] = useState('status=ACTIVE&sortBy=createdAt&sortOrder=desc');
  const [error, setError] = useState<string | null>(null);
  const page = useTaskPages(workspaceId, filters);
  function field(key: keyof typeof defaults, value: string) { setDraft((d) => ({ ...d, [key]: value })); setError(null); }
  function apply(event: FormEvent) {
    event.preventDefault();
    if (draft.from && draft.through && draft.from > draft.through) { setError('Due range start must not be after its end.'); return; }
    const query = new URLSearchParams({ sortBy: draft.sortBy, sortOrder: draft.sortOrder });
    for (const key of ['status', 'tagId', 'priority', 'hasDueDate'] as const) if (draft[key]) query.set(key, draft[key]);
    if (draft.q.trim()) query.set('q', draft.q.trim());
    if (draft.project === 'unfiled') query.set('unfiled', 'true'); else if (draft.project) query.set('projectId', draft.project);
    // Calendar-day boundaries in the browser's timezone; retain the last DB microsecond.
    for (const [date, key, time] of [[draft.from, 'dueAfter', 'T00:00:00.000'], [draft.through, 'dueBefore', 'T23:59:59.999']] as const) {
      if (!date) continue;
      const boundary = new Date(`${date}${time}`);
      if (!Number.isFinite(boundary.getTime())) { setError('Choose a valid due date.'); return; }
      query.set(key, boundary.toISOString().replace('.999Z', '.999999Z'));
    }
    setError(null); setApplied(draft);
    const next = query.toString(); if (next === filters) void page.reload(); else setFilters(next);
  }
  function reset() {
    setDraft(defaults); setApplied(defaults); setError(null);
    const next = 'status=ACTIVE&sortBy=createdAt&sortOrder=desc';
    if (next === filters) void page.reload(); else setFilters(next);
  }
  return <div className="task-browser">
    <Link className="history-link" href="/inbox">Back to Inbox</Link>
    <h1>Browse tasks</h1>
    <p className="subtitle">Search across your workspace. Filters combine; apply them to start a fresh result list. This view requires a connection.</p>
    <p><Link className="history-link" href="/task-history">Task history</Link> includes recently deleted tasks and recovery controls.</p>
    <form className="card" aria-label="Task filters" onSubmit={apply} style={{ marginBottom: 20 }}>
      <div className="task-filter-grid">
        <div><label htmlFor="filter-search-words">Search words</label><input id="filter-search-words" type="search" maxLength={200} value={draft.q} onChange={(e) => field('q', e.target.value)} aria-describedby="task-search-help" /></div>
        <div><label htmlFor="filter-status">Status</label><select id="filter-status" value={draft.status} onChange={(e) => field('status', e.target.value)}><option value="ACTIVE">Active</option><option value="COMPLETED">Completed</option><option value="ARCHIVED">Archived</option><option value="">Active and completed</option></select></div>
        <div><label htmlFor="filter-project">Project</label><select id="filter-project" value={draft.project} onChange={(e) => field('project', e.target.value)}><option value="">All projects and unfiled</option><option value="unfiled">Unfiled only</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
        <div><label htmlFor="filter-tag">Tag</label><select id="filter-tag" value={draft.tagId} onChange={(e) => field('tagId', e.target.value)}><option value="">Any tag</option>{tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></div>
        <div><label htmlFor="filter-priority">Priority</label><select id="filter-priority" value={draft.priority} onChange={(e) => field('priority', e.target.value)}><option value="">Any priority</option><option value="HIGH">High</option><option value="MEDIUM">Medium</option><option value="LOW">Low</option><option value="NONE">None</option></select></div>
        <div><label htmlFor="filter-due-date">Due date</label><select id="filter-due-date" value={draft.hasDueDate} onChange={(e) => { const value = e.target.value; setDraft((d) => ({ ...d, hasDueDate: value, ...(value === 'false' ? { from: '', through: '' } : {}) })); setError(null); }}><option value="">With or without a due date</option><option value="true">Has a due date</option><option value="false">No due date</option></select></div>
        <div><label htmlFor="filter-due-from">Due from</label><input id="filter-due-from" type="date" disabled={draft.hasDueDate === 'false'} value={draft.from} onChange={(e) => field('from', e.target.value)} aria-describedby="task-date-help" /></div>
        <div><label htmlFor="filter-due-through">Due through</label><input id="filter-due-through" type="date" disabled={draft.hasDueDate === 'false'} value={draft.through} onChange={(e) => field('through', e.target.value)} aria-describedby="task-date-help" /></div>
        <div><label htmlFor="filter-sort-by">Sort by</label><select id="filter-sort-by" value={draft.sortBy} onChange={(e) => field('sortBy', e.target.value)}><option value="createdAt">Created date</option><option value="dueAt">Due date</option><option value="priority">Priority</option><option value="estimateMinutes">Estimate</option><option value="project">Project name</option><option value="position">Custom position</option></select></div>
        <div><label htmlFor="filter-direction">Direction</label><select id="filter-direction" value={draft.sortOrder} onChange={(e) => field('sortOrder', e.target.value)}><option value="asc">Ascending</option><option value="desc">Descending</option></select></div>
      </div>
      <p id="task-search-help" className="muted">Search matches whole words in titles and descriptions, not partial words.</p>
      <p id="task-date-help" className="muted">Dates include the whole day in this browser’s timezone. Choosing “No due date” clears the range.</p>
      <p className="muted">Ascending: earliest, lowest priority, shortest estimate, A–Z or smallest position first. Missing values stay last in both directions. Custom position reads the stored order; it does not reorder tasks.</p>
      {error && <div role="alert" className="banner banner-error">{error}</div>}
      <div className="row"><button className="btn-primary" type="submit">Apply filters</button><button type="button" onClick={reset}>Reset filters</button></div>
      <p role="status">{JSON.stringify(draft) !== JSON.stringify(applied) ? 'Unapplied changes — results still use the previous filters.' : 'Filters applied.'}</p>
    </form>
    {/* Key a concrete results boundary so changing queries also removes old list/editor fragments. */}
    <section key={`${workspaceId}:${filters}`} aria-label="Task results">
    <TaskList tasks={page.tasks} loading={page.loading && !page.tasks.length} error={page.tasks.length ? null : page.error} emptyTitle="No matching tasks" emptyBody="Try fewer filters or reset to active tasks across the workspace." onChanged={page.reload} />
    <TaskPagination {...page} error={page.tasks.length ? page.error : null} count={page.tasks.length} onMore={page.loadMore} onRetry={page.tasks.length ? page.loadMore : page.reload} />
    </section>
  </div>;
}
