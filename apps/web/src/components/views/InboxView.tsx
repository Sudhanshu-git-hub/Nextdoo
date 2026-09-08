'use client';
import Link from 'next/link';
import { QuickCapture } from '@/components/QuickCapture';
import { TaskList } from '@/components/TaskList';
import { TaskPagination } from '@/components/TaskPagination';
import { useTaskPages } from '@/lib/use-task-pages';
export function InboxView({ workspaceId }: { workspaceId: string }) {
  const page = useTaskPages(workspaceId, 'status=ACTIVE&unfiled=true');
  return <>
    <div className="page-head"><div><h1>Inbox</h1><p className="subtitle">Captured work that has not been filed into a project yet.</p></div></div>
    <p><Link className="history-link" href="/task-history">Task history</Link> — completed, archived and recently deleted tasks from all projects.</p>
    <QuickCapture workspaceId={workspaceId} onCreated={page.reload} />
    <TaskList tasks={page.tasks} loading={page.loading && !page.tasks.length} error={page.tasks.length ? null : page.error} emptyTitle="Inbox zero" emptyBody="Everything you have captured has a home. Capture new work with the box above." onChanged={page.reload} />
    <TaskPagination {...page} error={page.tasks.length ? page.error : null} count={page.tasks.length} onMore={page.loadMore} onRetry={page.tasks.length ? page.loadMore : page.reload} />
  </>;
}
