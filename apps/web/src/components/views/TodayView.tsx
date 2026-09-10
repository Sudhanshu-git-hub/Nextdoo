'use client';
import { localDayBounds, localDateKey } from '@nextdoo/core/calendar';
import { useWorkspace } from '@/components/WorkspaceContext';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTaskPages } from '@/lib/use-task-pages';
import { api } from '@/lib/api';

/** PRD §8.3 — server-computed day capacity (full-collection workload). */
interface DayCapacityData {
  workdayMinutes: number;
  workloadMinutes: number;
  capacityMinutes: number | null;
  overByMinutes: number | null;
  status: 'OK' | 'OVERLOADED' | 'CAPACITY_UNKNOWN';
  providerConnected: boolean;
}
import { TaskPagination } from '@/components/TaskPagination';
import { QuickCapture } from '@/components/QuickCapture';
import { TaskList } from '@/components/TaskList';

/**
 * Today (PRD §8.3) — the default landing view.
 *
 * Shows what is due today plus anything overdue, because hiding overdue work
 * is how a planner starts lying to its user.
 */
export function TodayView({ workspaceId }: { workspaceId: string }) {
  const { timeZone } = useWorkspace();
  const filters = useMemo(() => {
    const { end } = localDayBounds(new Date(), timeZone);
    return `status=ACTIVE&dueBefore=${encodeURIComponent(end.toISOString())}`;
  }, [timeZone]);
  const page = useTaskPages(workspaceId, filters, true);
  const { tasks, loading, stale, reload: load } = page;
  const [capacity, setCapacity] = useState<DayCapacityData | null>(null);

  const loadCapacity = useCallback(async () => {
    try {
      const date = localDateKey(new Date(), timeZone);
      setCapacity(await api<DayCapacityData>(`/calendar/capacity?workspaceId=${workspaceId}&date=${date}`));
    } catch {
      // Best-effort planning aid: a failed capacity fetch never blocks the list.
      setCapacity(null);
    }
  }, [workspaceId, timeZone]);

  useEffect(() => {
    void loadCapacity();
  }, [loadCapacity]);

  const reload = useCallback(() => {
    void load();
    void loadCapacity();
  }, [load, loadCapacity]);
  // The app-global reconcile loop (OfflineBadge in the shell) drains the
  // queue; refresh this view whenever it has applied mutations or pulled
  // changes, so the list reflects the server instead of a stale cache.
  useEffect(() => {
    const onSynced = () => { void reload(); };
    window.addEventListener('nextdoo-synced', onSynced);
    return () => window.removeEventListener('nextdoo-synced', onSynced);
  }, [reload]);

  const now = new Date();
  const overdue = tasks.filter((t) => t.dueAt && new Date(t.dueAt) < localDayBounds(now, timeZone).start);
  const today = tasks.filter((t) => !t.dueAt || new Date(t.dueAt) >= localDayBounds(now, timeZone).start);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Today</h1>
          <p className="subtitle">
            {now.toLocaleDateString(undefined, { timeZone, weekday: 'long', month: 'long', day: 'numeric' })}
            {capacity && capacity.workloadMinutes > 0 && ` · ${formatMinutes(capacity.workloadMinutes)} planned today`}
          </p>
        </div>
      </div>

      {stale && (
        <div className="banner banner-warn" role="status">
          Showing your last saved copy — you appear to be offline. This is a read-only cached view; reload when connected.
        </div>
      )}

      <QuickCapture workspaceId={workspaceId} onCreated={reload} />

      {capacity?.status === 'OVERLOADED' && (
        <div className="banner banner-warn" role="status">
          You have planned {formatMinutes(capacity.workloadMinutes)} of work in tasks due today. Your configured workday is {formatMinutes(capacity.workdayMinutes)}
          {capacity.overByMinutes ? ` — ${formatMinutes(capacity.overByMinutes)} over` : ''}. This is a planning guideline, not a guarantee of available time; consider moving something.
        </div>
      )}

      {capacity?.status === 'CAPACITY_UNKNOWN' && (
        <div className="banner banner-warn" role="status">
          A calendar is connected but its sync data hasn&#39;t caught up (calendar sync delayed), so available work capacity can&#39;t be confirmed yet.
          You have planned {formatMinutes(capacity.workloadMinutes)} in tasks due today.
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
            onChanged={reload}
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
          onChanged={reload}
        />
      </section>
      <TaskPagination {...page} error={page.tasks.length ? page.error : null} count={tasks.length} onMore={page.loadMore} onRetry={tasks.length ? page.loadMore : load} />
    </>
  );
}



function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}
