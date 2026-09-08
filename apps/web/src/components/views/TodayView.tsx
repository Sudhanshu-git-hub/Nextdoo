'use client';

import { useEffect, useMemo } from 'react';
import { useTaskPages } from '@/lib/use-task-pages';
import { TaskPagination } from '@/components/TaskPagination';
import { flushQueue, getDeviceId } from '@/lib/offline-queue';
import { QuickCapture } from '@/components/QuickCapture';
import { TaskList } from '@/components/TaskList';

/**
 * Today (PRD §8.3) — the default landing view.
 *
 * Shows what is due today plus anything overdue, because hiding overdue work
 * is how a planner starts lying to its user.
 */
export function TodayView({ workspaceId }: { workspaceId: string }) {
  const filters = useMemo(() => {
    const end = new Date(); end.setHours(23, 59, 59, 999);
    return `status=ACTIVE&dueBefore=${encodeURIComponent(end.toISOString())}`;
  }, []);
  const page = useTaskPages(workspaceId, filters, true);
  const { tasks, loading, stale, reload: load } = page;
  // Drain the offline queue whenever connectivity returns.
  useEffect(() => {
    const onOnline = async () => {
      await flushQueue(workspaceId, getDeviceId());
      void load();
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [workspaceId, load]);

  const now = new Date();
  const overdue = tasks.filter((t) => t.dueAt && new Date(t.dueAt) < startOfToday());
  const today = tasks.filter((t) => !t.dueAt || new Date(t.dueAt) >= startOfToday());
  const plannedMinutes = tasks.reduce((sum, t) => sum + (t.estimateMinutes ?? 0), 0);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Today</h1>
          <p className="subtitle">
            {now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
            {plannedMinutes > 0 && ` · ${formatMinutes(plannedMinutes)} planned in loaded tasks`}
          </p>
        </div>
      </div>

      {stale && (
        <div className="banner banner-warn" role="status">
          Showing your last saved copy — you appear to be offline. This is a read-only cached view; reload when connected.
        </div>
      )}

      <QuickCapture workspaceId={workspaceId} onCreated={load} />

      {plannedMinutes > 480 && (
        <div className="banner banner-warn" role="status">
          You have planned {formatMinutes(plannedMinutes)} of work in the loaded tasks. That is more than a typical working day —
          consider moving something.
        </div>
      )}

      {overdue.length > 0 && (
        <section aria-labelledby="overdue-heading" style={{ marginBottom: 22 }}>
          <h2 id="overdue-heading" style={{ color: 'var(--danger)' }}>
            Overdue ({overdue.length})
          </h2>
          <TaskList
            tasks={overdue}
            loading={false}
            error={page.tasks.length ? null : page.error}
            emptyTitle=""
            emptyBody=""
            onChanged={load}
          />
        </section>
      )}

      <section aria-labelledby="today-heading">
        <h2 id="today-heading">Due today</h2>
        <TaskList
          tasks={today}
          loading={loading && !tasks.length}
          error={page.tasks.length ? null : page.error}
          emptyTitle="Nothing scheduled for today"
          emptyBody="Add a task above, or check the Inbox for unscheduled work waiting for a date."
          onChanged={load}
        />
      </section>
      <TaskPagination {...page} error={page.tasks.length ? page.error : null} count={tasks.length} onMore={page.loadMore} onRetry={tasks.length ? page.loadMore : load} />
    </>
  );
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}
