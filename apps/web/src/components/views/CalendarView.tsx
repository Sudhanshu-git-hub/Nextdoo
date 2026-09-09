'use client';
import { localParts, localDateKey, zonedTimeToUtc, workspaceWeek, workdayDescription } from '@nextdoo/core/calendar';
import { useWorkspace } from '@/components/WorkspaceContext';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError, type Task } from '@/lib/api';

/**
 * Calendar (PRD §8.3) — a week grid of scheduled work.
 *
 * Drag-and-drop is deliberately not the only way to move a task: each day is a
 * drop target *and* a keyboard-reachable button, satisfying the accessible
 * alternative requirement (PRD §8.8).
 */


export function CalendarView({ workspaceId }: { workspaceId: string }) {
  const workspace = useWorkspace();
  const { timeZone, weekStart } = workspace;
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [weekOffset, setWeekOffset] = useState(0);
  const [selected, setSelected] = useState<Task | null>(null);
  const [status, setStatus] = useState('');

  const { days, end } = useMemo(() => workspaceWeek(new Date(), timeZone, weekStart, weekOffset), [timeZone, weekStart, weekOffset]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const from = days[0];
      const to = end;
      const response = await api<{ data: Task[] }>(
        `/tasks?workspaceId=${workspaceId}&dueAfter=${encodeURIComponent(from.toISOString())}&dueBefore=${encodeURIComponent(to.toISOString())}&limit=100`,
      );
      setTasks(response.data);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.problem.detail : 'Could not load the calendar.');
    } finally {
      setLoading(false);
    }
  }, [workspaceId, days, end]);

  useEffect(() => { void load(); }, [load]);

  async function moveTo(task: Task, day: Date) {
    const date = localParts(day, timeZone), original = task.dueAt ? localParts(new Date(task.dueAt), timeZone) : null;
    const target = zonedTimeToUtc(date.year, date.month, date.day, original?.hour ?? Math.floor(workspace.workdayStartMinute / 60), original?.minute ?? workspace.workdayStartMinute % 60, timeZone);
    try {
      await api(`/tasks/${task.id}/reschedule`, {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ version: task.version, dueAt: target.toISOString(), reason: 'Moved on calendar' }),
      });
      setStatus(`Moved "${task.title}" to ${day.toLocaleDateString(undefined, { timeZone, weekday: 'long' })}`);
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
            {days[0].toLocaleDateString(undefined, { timeZone, month: 'short', day: 'numeric' })} –{' '}
            {days[6].toLocaleDateString(undefined, { timeZone, month: 'short', day: 'numeric' })}
          </p>
        </div>
        <div className="row">
          <button onClick={() => setWeekOffset((w) => w - 1)}>← Previous week</button>
          <button onClick={() => setWeekOffset(0)} disabled={weekOffset === 0}>This week</button>
          <button onClick={() => setWeekOffset((w) => w + 1)}>Next week →</button>
        </div>
      </div>

      <p>Calendar time zone: {timeZone}</p>
      <p>Configured workday: {workdayDescription(workspace.workdayStartMinute, workspace.workdayEndMinute)}</p>
      {error && <div className="banner banner-error" role="alert">{error}</div>}

      {selected && (
        <div className="banner banner-info" role="group" aria-label="Move task">
          Moving <strong>{selected.title}</strong> — choose a day below, or{' '}
          <button className="btn-ghost btn-sm" onClick={() => setSelected(null)}>cancel</button>.
        </div>
      )}

      <div className="grid" style={{ gridTemplateColumns: 'repeat(7, minmax(0,1fr))' }} role="list">
        {days.map((day) => {
          const isToday = localDateKey(day, timeZone) === localDateKey(new Date(), timeZone);
          const dayTasks = tasks.filter((t) => t.dueAt && localDateKey(new Date(t.dueAt), timeZone) === localDateKey(day, timeZone));
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
                  {day.toLocaleDateString(undefined, { timeZone, weekday: 'short' })}
                </div>
                <div style={{ fontWeight: isToday ? 700 : 400, fontSize: 13 }}>{localParts(day, timeZone).day}</div>
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
