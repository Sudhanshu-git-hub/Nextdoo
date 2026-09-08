'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type Task } from '@/lib/api';
import { QuickCapture } from '@/components/QuickCapture';
import { TaskList } from '@/components/TaskList';

/** Inbox (PRD §8.3): everything captured but not yet assigned a project. */
export function InboxView({ workspaceId }: { workspaceId: string }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await api<{ data: Task[] }>(
        `/tasks?workspaceId=${workspaceId}&status=ACTIVE&limit=100`,
      );
      setTasks(response.data.filter((t) => t.projectId === null));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.problem.detail : 'Could not load your inbox.');
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { void load(); }, [load]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Inbox</h1>
          <p className="subtitle">Captured work that has not been filed into a project yet.</p>
        </div>
      </div>

      <QuickCapture workspaceId={workspaceId} onCreated={load} />

      <TaskList
        tasks={tasks}
        loading={loading}
        error={error}
        emptyTitle="Inbox zero"
        emptyBody="Everything you have captured has a home. Capture new work with the box above."
        onChanged={load}
      />
    </>
  );
}
