'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type Task } from '@/lib/api';
import { cacheTasks, flushQueue, getDeviceId, readCachedTasks } from '@/lib/offline-queue';
import { QuickCapture } from '@/components/QuickCapture';
import { TaskList } from '@/components/TaskList';

/**
 * Today (PRD §8.3) — the default landing view.
 *
 * Shows what is due today plus anything overdue, because hiding overdue work
 * is how a planner starts lying to its user.
 */
export function TodayView({ workspaceId }: { workspaceId: string }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const endOfToday = new Date();
      endOfToday.setHours(23, 59, 59, 999);
      const response = await api<{ data: Task[] }>(
        `/tasks?workspaceId=${workspaceId}&status=ACTIVE&dueBefore=${encodeURIComponent(endOfToday.toISOString())}&limit=100`,
      );
      setTasks(response.data);
      setStale(false);
      void cacheTasks(workspaceId, response.data);
    } catch (caught) {
      // Fall back to the local cache so the view still works offline.
      const cached = await readCachedTasks<Task>(workspaceId);
      if (cached.length) {
        setTasks(cached.filter((t) => t.status === 'ACTIVE'));
        setStale(true);
      } else {
        setError(caught instanceof ApiError ? caught.problem.detail : 'Could not load your tasks.');
      }
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

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
            {plannedMinutes > 0 && ` · ${formatMinutes(plannedMinutes)} planned`}
          </p>
        </div>
      </div>

      {stale && (
        <div className="banner banner-warn" role="status">
          Showing your last saved copy — you appear to be offline. Changes will sync when you reconnect.
        </div>
      )}

      <QuickCapture workspaceId={workspaceId} onCreated={load} />

      {plannedMinutes > 480 && (
        <div className="banner banner-warn" role="status">
          You have planned {formatMinutes(plannedMinutes)} of work today. That is more than a typical working day —
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
            error={null}
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
          loading={loading}
          error={error}
          emptyTitle="Nothing scheduled for today"
          emptyBody="Add a task above, or check the Inbox for unscheduled work waiting for a date."
          onChanged={load}
        />
      </section>
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
