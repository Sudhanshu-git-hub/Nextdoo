'use client';
import { useRef, useState, type ComponentProps } from 'react';
import { MAX_BULK_TASKS, type BulkTaskInput } from '@nextdoo/contracts';
import { api, ApiError, type Task } from '@/lib/api';
import { TaskList } from './TaskList';
type Selected = Pick<Task, 'id' | 'version' | 'title' | 'status'>;
type Attempt = { body: string; key: string; operation: BulkTaskInput['operation']; count: number };

/** Selection captures reviewed versions. Never silently upgrade a selected version after a refresh. */
export function TaskBulkList({ onPendingChange, ...list }: ComponentProps<typeof TaskList> & { onPendingChange: (pending: boolean) => void }) {
  const [selected, setSelected] = useState<Map<string, Selected>>(new Map());
  const [due, setDue] = useState(''), [removeDue, setRemoveDue] = useState(false), [reason, setReason] = useState('');
  const [attempt, setAttempt] = useState<Attempt | null>(null), [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null), [canRetry, setCanRetry] = useState(false), [announcement, setAnnouncement] = useState('');
  const inFlight = useRef(false);
  const locked = busy || attempt !== null;
  const selection = [...selected.values()];
  function clear() { setSelected(new Map()); setAnnouncement(''); setError(null); }
  async function send(request: Attempt) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(null); setAttempt(request); onPendingChange(true);
    try {
      await api('/tasks/bulk', { method: 'POST', headers: { 'Idempotency-Key': request.key }, body: request.body });
      setSelected(new Map()); setAttempt(null); setCanRetry(false); onPendingChange(false);
      setAnnouncement(`${request.count} tasks ${request.operation === 'complete' ? 'completed' : request.operation === 'archive' ? 'archived' : 'rescheduled'}. 0 tasks selected.`);
      list.onChanged();
    } catch (caught) {
      const uncertain = !(caught instanceof ApiError) || caught.problem.status >= 500 || caught.problem.status === 429;
      setCanRetry(uncertain);
      setError(uncertain ? 'The batch was not acknowledged and may already have committed. Stay on this page and retry the same batch; do not submit a new selection.'
        : `No tasks changed by this request. ${caught instanceof ApiError ? caught.problem.detail : ''} Reload and review tasks before selecting again.`);
    } finally { inFlight.current = false; setBusy(false); }
  }
  async function start(operation: BulkTaskInput['operation']) {
    if (locked || inFlight.current || !selection.length) return;
    let date: string | null = null;
    if (operation === 'reschedule' && !removeDue) {
      const parsed = new Date(due);
      if (!due || !Number.isFinite(parsed.getTime())) { setError('Choose a new due date and time, or explicitly remove due dates.'); return; }
      date = parsed.toISOString();
    }
    const effect = operation === 'complete' ? 'Pending reminders will be canceled.' : operation === 'archive' ? 'Tasks will leave active views. Related tasks remain unchanged.' : `${removeDue ? 'Remove due dates' : `Set every due date to ${new Date(date!).toLocaleString()}`}. Relative reminders and reschedule counts will update.`;
    if (!window.confirm(`${operation === 'complete' ? 'Complete' : operation === 'archive' ? 'Archive' : 'Reschedule'} exactly ${selection.length} selected tasks? ${effect} All tasks change together, or none do. Review the selected titles before confirming.`)) return;
    const common = { workspaceId: list.tasks[0]!.workspaceId, operation, tasks: selection.map(({ id, version }) => ({ id, version })).sort((a, b) => a.id.localeCompare(b.id)) };
    await send({ body: JSON.stringify({ ...common, ...(operation === 'reschedule' ? { dueAt: date, reason } : {}) }), key: crypto.randomUUID(), operation, count: selection.length });
  }
  function review() {
    if (inFlight.current) return;
    if (canRetry && !window.confirm('This batch may already have committed. Reloading does not undo it. Discard this retry identity and review current task states before making a new selection?')) return;
    setAttempt(null); setCanRetry(false); onPendingChange(false); clear(); list.onChanged();
  }
  return <>
    <section className="card bulk-task-actions" aria-label="Bulk task actions" style={{ marginBottom: 16 }}>
      <h2>Selected tasks</h2>
      <p role="status">{busy ? 'Updating selected tasks…' : announcement || `${selection.length} tasks selected (maximum ${MAX_BULK_TASKS}).`}</p>
      <p className="muted">Only explicitly selected, loaded tasks change — never hidden pages or all search matches. Each batch is all-or-nothing. Changing filters clears selection.</p>
      <fieldset disabled={locked} style={{ border: 0, padding: 0, margin: 0 }}>
        <div className="row"><button type="button" disabled={list.loading || !!list.error || !list.tasks.length || list.tasks.length > MAX_BULK_TASKS} onClick={() => { setSelected(new Map(list.tasks.map((t) => [t.id, t]))); setAnnouncement(''); setError(null); }}>Select loaded tasks</button><button type="button" disabled={!selection.length} onClick={clear}>Clear selection</button></div>
        {list.tasks.length > MAX_BULK_TASKS && <p className="muted">More than {MAX_BULK_TASKS} tasks are loaded. Select up to {MAX_BULK_TASKS} individually.</p>}
        {!!selection.length && <details><summary>Review selected tasks ({selection.length})</summary><ul>{selection.map((t) => <li key={t.id}>{t.title} — version {t.version}</li>)}</ul></details>}
        <div className="row" style={{ marginTop: 12 }}>
          <button type="button" disabled={!selection.length || selection.some((t) => t.status !== 'ACTIVE')} onClick={() => void start('complete')}>Complete selected</button>
          <button type="button" disabled={!selection.length || selection.some((t) => !['ACTIVE', 'COMPLETED'].includes(t.status))} onClick={() => void start('archive')}>Archive selected</button>
        </div>
        <p className="muted">Complete requires every selected task to be Active. Archive requires Active or Completed. Reschedule preserves the current task state.</p>
        <div className="task-filter-grid" style={{ marginTop: 12 }}>
          <div><label htmlFor="bulk-due">New due date and time</label><input id="bulk-due" type="datetime-local" disabled={removeDue} value={due} onChange={(e) => setDue(e.target.value)} /></div>
          <div><label htmlFor="bulk-reason">Reschedule reason (optional)</label><input id="bulk-reason" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
        </div>
        <label className="bulk-selection"><input type="checkbox" checked={removeDue} onChange={(e) => setRemoveDue(e.target.checked)} />Remove due dates</label>
        <p className="muted">New dates use this browser’s timezone. Removing a due date cancels its pending relative reminders.</p>
        <button type="button" disabled={!selection.length} onClick={() => void start('reschedule')}>Reschedule selected</button>
      </fieldset>
      {error && <div role="alert" className="banner banner-error" style={{ marginTop: 12 }}>{error}
        {attempt && <div className="row">{canRetry && <button type="button" disabled={busy} onClick={() => void send(attempt)}>Retry same batch</button>}<button type="button" disabled={busy} onClick={review}>Reload and review tasks</button></div>}
      </div>}
    </section>
    <fieldset disabled={locked} style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className="sr-only">Task selection and editing</legend>
      <TaskList {...list} onChanged={() => { clear(); list.onChanged(); }} taskActions={(task) => <label className="bulk-selection"><input type="checkbox" aria-label={`Select "${task.title}"`} checked={selected.has(task.id)} disabled={!selected.has(task.id) && selected.size >= MAX_BULK_TASKS} onChange={(e) => { const checked = e.target.checked; setSelected((current) => { const next = new Map(current); if (checked && next.size < MAX_BULK_TASKS) next.set(task.id, task); else next.delete(task.id); return next; }); setAnnouncement(''); setError(null); }} />Select for bulk action</label>} />
    </fieldset>
  </>;
}
