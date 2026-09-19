'use client';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { useTaskPages } from '@/lib/use-task-pages';
import { TaskList } from '@/components/TaskList';
import { TaskPagination } from '@/components/TaskPagination';
import { TaskLifecycleActions } from '@/components/TaskLifecycleActions';
type HistoryStatus = 'COMPLETED' | 'ARCHIVED' | 'DELETED';
export function TaskHistoryView({ workspaceId }: { workspaceId: string }) {
 const [filter, setFilter] = useState<HistoryStatus>('ARCHIVED');
 return <div className="task-history">
  <Link className="history-link" href="/inbox">Back to Inbox</Link>
  <h1>Task history</h1>
  <p className="subtitle">Completed and archived tasks, plus tasks still inside the 30-day recovery window. This view includes every project in your workspace.</p>
  <div className="row" role="group" aria-label="Task history filter" style={{ marginBottom: 18 }}>
   {(['COMPLETED', 'ARCHIVED', 'DELETED'] as const).map((status) => <button key={status} aria-pressed={filter === status} onClick={() => setFilter(status)}>{status === 'DELETED' ? 'Trash' : status === 'ARCHIVED' ? 'Archived' : 'Completed'}</button>)}
  </div>
  <HistoryTasks key={filter} workspaceId={workspaceId} filter={filter} />
 </div>;
}
function HistoryTasks({ workspaceId, filter }: { workspaceId: string; filter: HistoryStatus }) {
 const page = useTaskPages(workspaceId, `status=${filter}`);
 const [announcement, setAnnouncement] = useState('');
 const status = useRef<HTMLParagraphElement>(null);
 return <>
  <p role="status" ref={status} tabIndex={-1}>{announcement}</p>
  {filter === 'DELETED' ? <>
   <p className="muted">Trash is read-only. Restore returns a task to Active without changing its project or related tasks. Canceled reminders stay canceled. Expired items are not shown here; retained tracking history is separate. There is no permanent-delete control.</p>
   {page.loading && !page.tasks.length && <p role="status">Loading Trash…</p>}
   {!page.loading && !page.error && !page.tasks.length && <div className="empty"><h2>No recoverable tasks</h2><p>Deleted tasks appear here only during their recovery window.</p></div>}
   {page.tasks.map((task) => <article key={task.id} className="card" aria-label={`Deleted task "${task.title}"`} style={{ marginBottom: 12 }}>
    <h2>{task.title}</h2>
    <p className="muted">Deleted: {task.deletedAt ? new Date(task.deletedAt).toLocaleString() : 'Unavailable'}<br />Restore before: {task.restoreUntil ? new Date(task.restoreUntil).toLocaleString() : 'Unavailable'}</p>
    <TaskLifecycleActions task={task} onReload={page.reload} reloadLabel="Refresh task list" onDone={() => {
     setAnnouncement(`Restored "${task.title}" as an active task.`); void page.reload(); status.current?.focus();
    }} />
   </article>)}
  </> : <TaskList tasks={page.tasks} loading={page.loading && !page.tasks.length} error={page.tasks.length ? null : page.error} emptyTitle={filter === 'ARCHIVED' ? 'No archived tasks' : 'No completed tasks'} emptyBody="Tasks from all your projects appear here when they enter this state." onChanged={page.reload} />}
  <TaskPagination {...page} error={filter !== 'DELETED' && !page.tasks.length ? null : page.error} count={page.tasks.length} onMore={page.loadMore} onRetry={page.tasks.length ? page.loadMore : page.reload} />
 </>;
}
