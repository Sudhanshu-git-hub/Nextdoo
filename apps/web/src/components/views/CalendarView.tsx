'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError, type Task } from '@/lib/api';

/**
 * Calendar (PRD §8.3) — a week grid of scheduled work.
 *
 * Drag-and-drop is deliberately not the only way to move a task: each day is a
 * drop target *and* a keyboard-reachable button, satisfying the accessible
 * alternative requirement (PRD §8.8).
 */
type Week = [Date, Date, Date, Date, Date, Date, Date];

export function CalendarView({ workspaceId }: { workspaceId: string }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [weekOffset, setWeekOffset] = useState(0);
  const [selected, setSelected] = useState<Task | null>(null);
  const [status, setStatus] = useState('');

  /** Exactly seven days, typed as a tuple so first/last access is provably safe. */
  const days = useMemo<Week>(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - start.getDay() + weekOffset * 7);
    const at = (i: number) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return d;
    };
    return [at(0), at(1), at(2), at(3), at(4), at(5), at(6)];
  }, [weekOffset]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const from = days[0];
      const to = new Date(days[6]);
      to.setHours(23, 59, 59, 999);
      const response = await api<{ data: Task[] }>(
        `/tasks?workspaceId=${workspaceId}&dueAfter=${encodeURIComponent(from.toISOString())}&dueBefore=${encodeURIComponent(to.toISOString())}&limit=100`,
      );
      setTasks(response.data);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.problem.detail : 'Could not load the calendar.');
    } finally {
      setLoading(false);
    }
  }, [workspaceId, days]);

  useEffect(() => { void load(); }, [load]);

  async function moveTo(task: Task, day: Date) {
    const target = new Date(day);
    const original = task.dueAt ? new Date(task.dueAt) : null;
    target.setHours(original?.getHours() ?? 9, original?.getMinutes() ?? 0, 0, 0);
    try {
      await api(`/tasks/${task.id}/reschedule`, {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ version: task.version, dueAt: target.toISOString(), reason: 'Moved on calendar' }),
      });
      setStatus(`Moved "${task.title}" to ${day.toLocaleDateString(undefined, { weekday: 'long' })}`);
      setSelected(null);
      void load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.problem.detail : 'Could not move the task.');
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Calendar</h1>
          <p className="subtitle">
            {days[0].toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} –{' '}
            {days[6].toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
          </p>
        </div>
        <div className="row">
          <button onClick={() => setWeekOffset((w) => w - 1)}>← Previous week</button>
          <button onClick={() => setWeekOffset(0)} disabled={weekOffset === 0}>This week</button>
          <button onClick={() => setWeekOffset((w) => w + 1)}>Next week →</button>
        </div>
      </div>

      {error && <div className="banner banner-error" role="alert">{error}</div>}

      {selected && (
        <div className="banner banner-info" role="group" aria-label="Move task">
          Moving <strong>{selected.title}</strong> — choose a day below, or{' '}
          <button className="btn-ghost btn-sm" onClick={() => setSelected(null)}>cancel</button>.
        </div>
      )}

      <div className="grid" style={{ gridTemplateColumns: 'repeat(7, minmax(0,1fr))' }} role="list">
        {days.map((day) => {
          const isToday = day.toDateString() === new Date().toDateString();
          const dayTasks = tasks.filter((t) => t.dueAt && new Date(t.dueAt).toDateString() === day.toDateString());
          return (
            <div
              key={day.toISOString()}
              className="card"
              role="listitem"
              style={{ minHeight: 170, padding: 10, borderColor: isToday ? 'var(--accent)' : undefined }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const id = e.dataTransfer.getData('text/plain');
                const task = tasks.find((t) => t.id === id);
                if (task) void moveTo(task, day);
              }}
            >
              <div className="spread" style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                  {day.toLocaleDateString(undefined, { weekday: 'short' })}
                </div>
                <div style={{ fontWeight: isToday ? 700 : 400, fontSize: 13 }}>{day.getDate()}</div>
              </div>

              {selected && (
                <button
                  className="btn-sm"
                  style={{ width: '100%', marginBottom: 8 }}
                  onClick={() => void moveTo(selected, day)}
                >
                  Move here
                </button>
              )}

              {loading && <div className="skeleton" style={{ height: 30 }} />}

              {dayTasks.map((task) => (
                <button
                  key={task.id}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData('text/plain', task.id)}
                  onClick={() => setSelected(task)}
                  className="btn-sm"
                  style={{ width: '100%', textAlign: 'left', marginBottom: 5, whiteSpace: 'normal' }}
                  aria-label={`${task.title}. Press to move to another day.`}
                >
                  {task.title}
                </button>
              ))}

              {!loading && !dayTasks.length && !selected && (
                <p className="muted" style={{ fontSize: 12 }}>—</p>
              )}
            </div>
          );
        })}
      </div>

      <div aria-live="polite" className="sr-only">{status}</div>
    </>
  );
}
