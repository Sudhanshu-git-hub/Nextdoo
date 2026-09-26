'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { localDateKey } from '@nextdoo/core/calendar';
import { useWorkspace } from '../WorkspaceContext';
import { useTaskPages } from '@/lib/use-task-pages';
import { dailyFilters, type DailyView } from '@/lib/daily-tasks';
import { useWorkspaceDay } from '@/lib/use-workspace-day';
import { TaskList } from '../TaskList';
import { TaskPagination } from '../TaskPagination';

export function DailyTasksView({ workspaceId, view }: { workspaceId: string; view: DailyView }) {
  const { timeZone } = useWorkspace(), { now } = useWorkspaceDay(timeZone);
  const [horizon, setHorizon] = useState(7), [backlog, setBacklog] = useState('unscheduled');
  const [priority, setPriority] = useState(''), [sort, setSort] = useState('dueAt');
  const filters = dailyFilters(view, now, timeZone, horizon, backlog);
  if (priority) filters.set('priority', priority);
  filters.set('sortBy', sort);
  filters.set('sortOrder', sort === 'priority' || sort === 'createdAt' ? 'desc' : 'asc');
  const page = useTaskPages(workspaceId, filters.toString());
  useEffect(() => { const refresh = () => { void page.reload(); }; window.addEventListener('nextdoo-synced', refresh); return () => window.removeEventListener('nextdoo-synced', refresh); }, [page.reload]);
  const title = view[0]!.toUpperCase() + view.slice(1);
  const groups = new Map<string, typeof page.tasks>();
  for (const task of page.tasks) {
    const key = view === 'upcoming' && task.dueAt ? localDateKey(new Date(task.dueAt), timeZone) : '';
    groups.set(key, [...(groups.get(key) ?? []), task]);
  }
  return <><div className="page-head"><div><h1>{title}</h1><p className="subtitle">{view === 'backlog' ? 'Unscheduled tasks and overdue work are separate queues, across all projects.' : view === 'completed' ? 'Your completed work stays here. Reopen a task whenever you need to.' : `Task due dates in ${timeZone}. Overdue means before today.`}</p></div></div>
    <div className="row daily-controls">
      {view === 'upcoming' && <label>Upcoming horizon<select value={horizon} onChange={e => setHorizon(Number(e.target.value))}>{[3, 7, 14].map(n => <option key={n} value={n}>Next {n} days</option>)}</select></label>}
      {view === 'backlog' && <label>Backlog queue<select value={backlog} onChange={e => setBacklog(e.target.value)}><option value="unscheduled">Unscheduled / no date</option><option value="overdue">Overdue</option></select></label>}
      <label>Priority<select value={priority} onChange={e => setPriority(e.target.value)}><option value="">All priorities</option>{['HIGH', 'MEDIUM', 'LOW', 'NONE'].map(p => <option key={p}>{p}</option>)}</select></label>
      <label>Sort tasks<select value={sort} onChange={e => setSort(e.target.value)}>{[['dueAt','Due date'],['priority','Priority'],['estimateMinutes','Estimate'],['createdAt','Created']].map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <Link href="/tasks">More filters</Link><button onClick={page.reload}>Refresh tasks</button>
    </div>
    {!groups.size && <TaskList tasks={[]} loading={page.loading} error={page.error} emptyTitle={`No ${view === 'backlog' ? backlog : view} tasks`} emptyBody="Tasks matching this view will appear here." onChanged={page.reload}/>}
    {[...groups].sort(([a],[b])=>a.localeCompare(b)).map(([day, tasks]) => <section key={day} aria-label={day || title}>{day && <h2>{new Date(day+'T12:00:00Z').toLocaleDateString(undefined,{timeZone:'UTC',weekday:'long',month:'long',day:'numeric'})}</h2>}<TaskList tasks={tasks} loading={false} error={null} emptyTitle="" emptyBody="" onChanged={page.reload}/></section>)}
    <TaskPagination {...page} error={page.tasks.length ? page.error : null} count={page.tasks.length} onMore={page.loadMore} onRetry={page.tasks.length ? page.loadMore : page.reload}/>
    {view === 'completed' && <Link href="/task-history">Archived tasks and Trash</Link>}
  </>;
}
