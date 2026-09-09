'use client';
import { useWorkspace } from './WorkspaceContext';

import Link from 'next/link';
import { TaskEditor } from './TaskEditor';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type FocusEvent, type ReactNode } from 'react';
import { api, ApiError, type Task } from '@/lib/api';
import { computeTaskWindow, ESTIMATED_ROW_HEIGHT, VIRTUALIZATION_OVERSCAN, VIRTUALIZATION_THRESHOLD } from '@/lib/task-window';

interface TaskRowProps {
  task: Task;
  timeZone: string;
  busy: boolean;
  rowError: string | null;
  onToggle: (task: Task) => void;
  onOpen: (task: Task) => void;
  onTaskDrag?: (task: Task, event: DragEvent<HTMLLIElement>) => void;
  taskActions?: (task: Task) => ReactNode;
  /** Virtualization only: attach a ref to the li for height measurement. */
  rowRef?: (el: HTMLLIElement | null) => void;
}

function TaskRow({ task, timeZone, busy, rowError, onToggle, onOpen, onTaskDrag, taskActions, rowRef }: TaskRowProps) {
  const done = task.status === 'COMPLETED';
  const overdue = task.status === 'ACTIVE' && task.dueAt && new Date(task.dueAt) < new Date();
  return (
    <li
      ref={rowRef}
      data-task-id={task.id}
      draggable={!!onTaskDrag}
      onDragStart={onTaskDrag ? (event) => onTaskDrag(task, event) : undefined}
    >
      <div className={`task-row${done ? ' done' : ''}`}>
        {(task.status === 'ACTIVE' || done) && <button
          className="check"
          aria-pressed={done}
          aria-label={done ? `Mark "${task.title}" as not done` : `Complete "${task.title}"`}
          onClick={() => onToggle(task)}
          disabled={busy}
        >
          {done ? '✓' : ''}
        </button>}
        <div className="task-main">
          <button type="button" className="task-title task-edit-button" aria-label={`Edit "${task.title}"`} onClick={() => onOpen(task)}>{task.title}</button>
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
          {rowError && (
            <div className="banner banner-error" role="alert" style={{ marginTop: 8, marginBottom: 0 }}>
              {rowError}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

/**
 * Task list with acknowledged completion (PRD §6.9).
 *
 * On failure the existing task stays visible and the reason is surfaced —
 * a version conflict tells the user the task changed elsewhere rather than
 * silently discarding their click.
 *
 * Lists above VIRTUALIZATION_THRESHOLD loaded rows (PRD §6.9: virtualization
 * above 200 rows) render only the visible window of rows; the rest are
 * height-only placeholders so scroll height and ordering stay exact.
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

  if (tasks.length > VIRTUALIZATION_THRESHOLD) {
    return (
      <>
        <VirtualizedTaskList
          tasks={tasks}
          timeZone={timeZone}
          busyId={busyId}
          rowError={rowError}
          onToggle={toggle}
          onOpen={setEditing}
          onTaskDrag={onTaskDrag}
          taskActions={taskActions}
        />
        {editing && <TaskEditor key={editing.id} task={editing} onClose={() => setEditing(null)} onSaved={onChanged} />}
        <div aria-live="polite" className="sr-only">{announcement}</div>
      </>
    );
  }

  return (
    <>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {tasks.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            timeZone={timeZone}
            busy={busyId === task.id}
            rowError={rowError?.id === task.id ? rowError.message : null}
            onToggle={toggle}
            onOpen={setEditing}
            onTaskDrag={onTaskDrag}
            taskActions={taskActions}
          />
        ))}
      </ul>
      {editing && <TaskEditor key={editing.id} task={editing} onClose={() => setEditing(null)} onSaved={onChanged} />}
      <div aria-live="polite" className="sr-only">{announcement}</div>
    </>
  );
}

interface VirtualizedTaskListProps {
  tasks: Task[];
  timeZone: string;
  busyId: string | null;
  rowError: { id: string; message: string } | null;
  onToggle: (task: Task) => void;
  onOpen: (task: Task) => void;
  onTaskDrag?: (task: Task, event: DragEvent<HTMLLIElement>) => void;
  taskActions?: (task: Task) => ReactNode;
}

function VirtualizedTaskList({ tasks, timeZone, busyId, rowError, onToggle, onOpen, onTaskDrag, taskActions }: VirtualizedTaskListProps) {
  const listRef = useRef<HTMLUListElement | null>(null);
  const rowElsRef = useRef<Map<number, HTMLElement>>(new Map());
  const heightsRef = useRef<Map<number, number>>(new Map());
  const gutterRef = useRef(0);
  const observerRef = useRef<ResizeObserver | null>(null);
  const rafRef = useRef(0);
  const [viewport, setViewport] = useState({ top: 0, height: 640 });
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  const [version, setVersion] = useState(0); // bumped by rAF after measurement/scroll work
  const total = tasks.length;

  const invalidate = () => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      setVersion((v) => v + 1);
    });
  };

  /** Layout footprint of a row: its height plus the collapsed bottom gutter. */
  const footprintOf = (el: HTMLElement): number => {
    const height = el.getBoundingClientRect().height;
    return (height > 0 ? height : ESTIMATED_ROW_HEIGHT - gutterRef.current) + gutterRef.current;
  };

  /** Capture the inter-row gutter (collapsed .task-row bottom margin) once. */
  const captureGutter = (li: HTMLElement) => {
    if (gutterRef.current !== 0) return;
    const rowDiv = li.querySelector<HTMLElement>(':scope > .task-row');
    if (!rowDiv) return;
    const margin = parseFloat(getComputedStyle(rowDiv).marginBottom);
    if (Number.isFinite(margin) && margin > 0) {
      gutterRef.current = margin;
      heightsRef.current.forEach((value, index) => {
        if (value === ESTIMATED_ROW_HEIGHT) heightsRef.current.set(index, value + margin);
      });
    }
  };

  // One stable ref callback per index: React re-runs a ref callback on every render
  // when its identity changes, and re-observing a row re-fires the ResizeObserver —
  // that churn must not feed back into a re-render loop.
  const rowRefsRef = useRef<Map<number, (el: HTMLLIElement | null) => void>>(new Map());
  const rowRef = (index: number) => {
    let fn = rowRefsRef.current.get(index);
    if (!fn) {
      fn = (el: HTMLLIElement | null) => {
        const previous = rowElsRef.current.get(index);
        if (previous && previous !== el) observerRef.current?.unobserve(previous);
        if (!el) {
          rowElsRef.current.delete(index);
          return;
        }
        if (previous === el) return;
        rowElsRef.current.set(index, el);
        captureGutter(el);
        if (!heightsRef.current.has(index)) heightsRef.current.set(index, ESTIMATED_ROW_HEIGHT);
        invalidate();
        observerRef.current?.observe(el, { box: 'border-box' });
      };
      rowRefsRef.current.set(index, fn);
    }
    return fn;
  };

  const updateViewport = () => {
    const ul = listRef.current;
    if (!ul) return;
    const rect = ul.getBoundingClientRect();
    const viewHeight = typeof window === 'undefined' ? 640 : window.innerHeight;
    const visTop = Math.max(rect.top, 0);
    const visBottom = Math.min(rect.bottom, viewHeight);
    setViewport((prev) => {
      const next = {
        top: Math.max(visTop - rect.top, 0),
        height: Math.max(0, visBottom - visTop),
      };
      return prev.top === next.top && prev.height === next.height ? prev : next;
    });
  };

  useLayoutEffect(() => {
    updateViewport();
    const onScroll = () => updateViewport();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, []);

  useEffect(() => {
    const observer = new ResizeObserver(() => {
      let changed = false;
      rowElsRef.current.forEach((el, index) => {
        const next = footprintOf(el);
        if (heightsRef.current.get(index) !== next) {
          heightsRef.current.set(index, next);
          changed = true;
        }
      });
      if (changed) invalidate();
    });
    observerRef.current = observer;
    rowElsRef.current.forEach((el) => observer.observe(el, { box: 'border-box' }));
    return () => {
      observer.disconnect();
      observerRef.current = null;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // Forget measurements for rows that no longer exist.
  useEffect(() => {
    for (const index of Array.from(heightsRef.current.keys())) {
      if (index >= total) heightsRef.current.delete(index);
    }
  }, [total]);

  const heights = useMemo(
    () => Array.from({ length: total }, (_, i) => heightsRef.current.get(i)),
    [total, version],
  );

  const win = computeTaskWindow({
    total,
    heights,
    viewportTop: viewport.top,
    viewportHeight: viewport.height,
    focusedIndex,
    overscan: VIRTUALIZATION_OVERSCAN,
  });
  const listHeight = Math.max(0, win.totalHeight - (total > 0 ? gutterRef.current : 0));

  const handleFocusCapture = (event: FocusEvent<HTMLUListElement>) => {
    const li = (event.target as HTMLElement).closest('li[data-task-id]');
    if (!li) return;
    const index = tasks.findIndex((task) => task.id === (li as HTMLLIElement).dataset.taskId);
    if (index >= 0) setFocusedIndex(index);
  };

  const handleBlur = (event: FocusEvent<HTMLUListElement>) => {
    const next = event.relatedTarget as Node | null;
    if (!next || (listRef.current && !listRef.current.contains(next))) setFocusedIndex(null);
  };

  return (
    <ul
      ref={listRef}
      style={{ listStyle: 'none', padding: 0, margin: 0, height: listHeight }}
      data-virtualized="true"
      onFocusCapture={handleFocusCapture}
      onBlur={handleBlur}
    >
      {tasks.map((task, index) => {
        if (index < win.start || index >= win.end) {
          const footprint = heightsRef.current.get(index) ?? ESTIMATED_ROW_HEIGHT;
          return (
            <li
              key={task.id}
              className="task-list-placeholder"
              data-virtual-placeholder="true"
              data-task-index={index}
              aria-hidden="true"
              style={{ height: footprint }}
            />
          );
        }
        return (
          <TaskRow
            key={task.id}
            task={task}
            timeZone={timeZone}
            busy={busyId === task.id}
            rowError={rowError?.id === task.id ? rowError.message : null}
            onToggle={onToggle}
            onOpen={onOpen}
            onTaskDrag={onTaskDrag}
            taskActions={taskActions}
            rowRef={rowRef(index)}
          />
        );
      })}
    </ul>
  );
}
