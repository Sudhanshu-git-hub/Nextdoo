'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTaskPages } from '@/lib/use-task-pages';
import { TaskPagination } from '@/components/TaskPagination';
import { api, ApiError } from '@/lib/api';
import { getDeviceId } from '@/lib/offline-queue';

interface ActiveTimer {
  id: string;
  taskId: string;
  startedAt: string;
  status: 'RUNNING' | 'PAUSED' | 'STOPPED' | 'OVERLAPPED';
  elapsedSeconds: number;
}

/**
 * Focus timer (PRD §8.5).
 *
 * The elapsed value is derived from server timestamps rather than counting
 * ticks locally, so a backgrounded tab or a sleeping laptop cannot drift.
 */
export function FocusView({ workspaceId }: { workspaceId: string }) {
  const page = useTaskPages(workspaceId, 'status=ACTIVE');
  const { tasks } = page;
  const [timer, setTimer] = useState<ActiveTimer | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [busy, setBusy] = useState(false);
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const timerResponse = await api<{ timer: ActiveTimer | null }>('/timers');
      setTimer(timerResponse.timer);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.problem.detail : 'Could not load the focus session.');
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (tick.current) clearInterval(tick.current);
    if (timer?.status !== 'RUNNING') {
      setElapsed(timer?.elapsedSeconds ?? 0);
      return;
    }
    const receivedAt = Date.now();
    const compute = () =>
      setElapsed(timer.elapsedSeconds + Math.max(0, Math.floor((Date.now() - receivedAt) / 1000)));
    compute();
    tick.current = setInterval(compute, 1000);
    return () => {
      if (tick.current) clearInterval(tick.current);
    };
  }, [timer]);

  async function start(taskId: string) {
    setBusy(true);
    setError(null);
    try {
      const result = await api<ActiveTimer>('/timers', {
        method: 'POST',
        body: JSON.stringify({ taskId, deviceId: getDeviceId() }),
      });
      setTimer(result);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.problem.detail : 'Could not start the timer.');
    } finally {
      setBusy(false);
    }
  }

  async function act(action: 'pause' | 'resume' | 'stop') {
    if (!timer) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<ActiveTimer>(`/timers/${timer.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ action }),
      });
      setTimer(action === 'stop' ? null : result);
      if (action === 'stop') { void load(); void page.reload(); }
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.problem.detail : 'Could not update the timer.');
    } finally {
      setBusy(false);
    }
  }

  const activeTask = timer ? tasks.find((t) => t.id === timer.taskId) : null;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Focus</h1>
          <p className="subtitle">One task, one timer. Time is credited to the task even if you stop early.</p>
        </div>
      </div>

      {error && <div className="banner banner-error" role="alert">{error}</div>}

      <div className="card" style={{ textAlign: 'center', padding: 34, marginBottom: 22 }}>
        <div
          style={{ fontSize: 54, fontVariantNumeric: 'tabular-nums', fontWeight: 300, letterSpacing: '-.02em' }}
          role="timer"
          aria-live="off"
        >
          {formatClock(elapsed)}
        </div>
        <p className="subtitle" style={{ marginTop: 6 }}>
          {timer
            ? `${timer.status === 'RUNNING' ? 'Running' : 'Paused'} · ${activeTask?.title ?? 'Task'}`
            : 'No timer running'}
        </p>

        <div className="row" style={{ justifyContent: 'center', marginTop: 18 }}>
          {timer?.status === 'RUNNING' && (
            <button onClick={() => act('pause')} disabled={busy}>Pause</button>
          )}
          {timer?.status === 'PAUSED' && (
            <button className="btn-primary" onClick={() => act('resume')} disabled={busy}>Resume</button>
          )}
          {timer && (
            <button onClick={() => act('stop')} disabled={busy}>Stop and save</button>
          )}
        </div>
        <div aria-live="polite" className="sr-only">
          {timer ? `Timer ${timer.status.toLowerCase()} at ${formatClock(elapsed)}` : 'Timer stopped'}
        </div>
      </div>

      <h2>Start a session</h2>
      {(loading || page.loading) && <div className="skeleton" style={{ height: 56 }} />}
      {!loading && !page.loading && !page.error && !tasks.length && (
        <div className="empty">
          <div className="empty-title">No active tasks</div>
          <p>Add something to work on from Today, then come back to focus on it.</p>
        </div>
      )}
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {tasks.map((task) => (
          <li key={task.id}>
            <div className="task-row">
              <div className="task-main">
                <div className="task-title">{task.title}</div>
                <div className="task-meta">
                  {task.estimateMinutes != null && <span>est {task.estimateMinutes}m</span>}
                  {task.actualMinutes > 0 && <span>logged {task.actualMinutes}m</span>}
                </div>
              </div>
              <button
                className="btn-sm"
                onClick={() => start(task.id)}
                disabled={busy || timer?.taskId === task.id}
                aria-label={`Start a focus timer for ${task.title}`}
              >
                {timer?.taskId === task.id ? 'Active' : 'Start'}
              </button>
            </div>
          </li>
        ))}
      </ul>
      <TaskPagination {...page} count={tasks.length} onMore={page.loadMore} onRetry={tasks.length ? page.loadMore : page.reload} />
    </>
  );
}

function formatClock(totalSeconds: number): string {
  const s = Math.max(0, totalSeconds);
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}
