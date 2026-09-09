'use client';
import { useWorkspace } from './WorkspaceContext';

import Link from 'next/link';
import { TaskEditor } from './TaskEditor';
import { useState, type DragEvent, type ReactNode } from 'react';
import { api, ApiError, type Task } from '@/lib/api';

/**
 * Task list with acknowledged completion (PRD §6.9).
 *
 * On failure the existing task stays visible and the reason is surfaced —
 * a version conflict tells the user the task changed elsewhere rather than
 * silently discarding their click.
 */
export function TaskList({
  tasks,
  loading,
  error,
  emptyTitle,
  emptyBody,
  onChanged,
  onTaskDrag,
  taskActions,
}: {
  tasks: Task[];
  loading: boolean;
  error: string | null;
  emptyTitle: string;
  emptyBody: string;
  onChanged: () => void;
  onTaskDrag?: (task: Task, event: DragEvent<HTMLLIElement>) => void;
  taskActions?: (task: Task) => ReactNode;
}) {
  const { timeZone } = useWorkspace();
  const [editing, setEditing] = useState<Task | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [announcement, setAnnouncement] = useState('');

  async function toggle(task: Task) {
    setBusyId(task.id);
    setRowError(null);
    const completing = task.status !== 'COMPLETED';
    try {
      await api(`/tasks/${task.id}/${completing ? 'complete' : 'reopen'}`, {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ version: task.version }),
      });
      setAnnouncement(completing ? `Completed: ${task.title}` : `Reopened: ${task.title}`);
      onChanged();
    } catch (caught) {
      const message =
        caught instanceof ApiError && caught.isConflict
          ? 'This task changed on another device. Refreshing.'
          : caught instanceof ApiError
            ? caught.problem.detail
            : 'Could not update the task.';
      setRowError({ id: task.id, message });
      if (caught instanceof ApiError && caught.isConflict) onChanged();
    } finally {
      setBusyId(null);
    }
  }

  if (loading) {
    return (
      <div aria-busy="true" aria-label="Loading tasks">
        {[0, 1, 2].map((i) => (
          <div key={i} className="skeleton" style={{ height: 56, marginBottom: 7 }} />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="banner banner-error" role="alert">
        {error}{' '}
        <button className="btn-sm" onClick={onChanged} style={{ marginLeft: 8 }}>Retry</button>
      </div>
    );
  }

  if (!tasks.length) {
    return (
      <div className="empty">
        <div className="empty-title">{emptyTitle}</div>
        <p style={{ maxWidth: 380, margin: '0 auto' }}>{emptyBody}</p>
      </div>
    );
  }

  return (
    <>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {tasks.map((task) => {
          const done = task.status === 'COMPLETED';
          const overdue = task.status === 'ACTIVE' && task.dueAt && new Date(task.dueAt) < new Date();
          return (
            <li key={task.id} data-task-id={task.id} draggable={!!onTaskDrag} onDragStart={onTaskDrag ? (event) => onTaskDrag(task, event) : undefined}>
              <div className={`task-row${done ? ' done' : ''}`}>
                {(task.status === 'ACTIVE' || done) && <button
                  className="check"
                  aria-pressed={done}
                  aria-label={done ? `Mark "${task.title}" as not done` : `Complete "${task.title}"`}
                  onClick={() => toggle(task)}
                  disabled={busyId === task.id}
                >
                  {done ? '✓' : ''}
                </button>}
                <div className="task-main">
                  <button type="button" className="task-title task-edit-button" aria-label={`Edit "${task.title}"`} onClick={() => setEditing(task)}>{task.title}</button>
                  <div className="task-meta">
                    {task.dueAt && (
                      <span className={overdue ? 'pill pill-late' : 'pill'}>
                        {overdue ? 'Overdue · ' : ''}
                        {new Date(task.dueAt).toLocaleString(undefined, {
                          timeZone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
                        })}
                      </span>
                    )}
                    {task.status !== 'DELETED' && <Link href={`/analytics?taskId=${task.id}`} className="history-link">Tracking</Link>}
                    {task.status !== 'DELETED' && <Link href={`/notifications?taskId=${task.id}`} className="history-link">Reminders</Link>}
                    {task.priority !== 'NONE' && (
                      <span className={`pill pill-${task.priority.toLowerCase()}`}>{task.priority.toLowerCase()}</span>
                    )}
                    {task.estimateMinutes != null && <span>est {task.estimateMinutes}m</span>}
                    {task.actualMinutes > 0 && <span>actual {task.actualMinutes}m</span>}
                    {task.rescheduleCount > 0 && (
                      <span title="Times this task moved date">moved {task.rescheduleCount}×</span>
                    )}
                  </div>
                  {task.recurrenceRuleId && <Link className="history-link" href={`/recurrences/${task.recurrenceRuleId}`}>Manage recurrence</Link>}
                  {taskActions?.(task)}
                  {rowError?.id === task.id && (
                    <div className="banner banner-error" role="alert" style={{ marginTop: 8, marginBottom: 0 }}>
                      {rowError.message}
                    </div>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      {editing && <TaskEditor key={editing.id} task={editing} onClose={() => setEditing(null)} onSaved={onChanged} />}
      <div aria-live="polite" className="sr-only">{announcement}</div>
    </>
  );
}
