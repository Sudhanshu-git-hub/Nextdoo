'use client';
import { useRef, useState } from 'react';
import { api, ApiError, type Task } from '@/lib/api';
type Action = 'archive' | 'delete' | 'restore';
const labels: Record<Action, string> = { archive: 'Archive task', delete: 'Move to Trash', restore: 'Restore task' };
export function TaskLifecycleActions({ task, disabled = false, onBusyChange, onDone, onReload, reloadLabel = 'Reload task' }: {
 task: Pick<Task, 'id' | 'title' | 'version' | 'status'>; disabled?: boolean;
 onBusyChange?: (busy: boolean) => void; onDone: (action: Action) => void;
 onReload: () => Promise<void>; reloadLabel?: string;
}) {
 const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
 const locked = useRef(false), attempt = useRef<{ identity: string; key: string } | null>(null);
 async function act(action: Action) {
  if (disabled || locked.current) return;
  const message = action === 'delete' ? `Move "${task.title}" to Trash? You can restore it for 30 days. Pending reminders will be canceled. Related tasks will not be deleted.`
   : action === 'archive' ? `Archive "${task.title}"? It will leave active views but remain in Task history. Related tasks will stay unchanged.`
   : `Restore "${task.title}" as an active task in its existing project? Canceled reminders will not be reactivated. Your active-task limit still applies.`;
  if (!window.confirm(message)) return;
  locked.current = true; setBusy(true); onBusyChange?.(true); setError(null);
  const path = `/tasks/${task.id}${action === 'delete' ? '' : `/${action}`}`;
  const body = JSON.stringify({ version: task.version }), identity = `${action}:${path}:${body}`;
  if (attempt.current?.identity !== identity) attempt.current = { identity, key: crypto.randomUUID() };
  try {
   await api(path, { method: action === 'delete' ? 'DELETE' : 'POST', headers: { 'Idempotency-Key': attempt.current.key }, body });
   attempt.current = null; onDone(action);
  } catch (caught) {
   setError(caught instanceof ApiError && caught.isConflict ? 'This task changed elsewhere. Reload and review it before trying again.'
    : caught instanceof ApiError ? caught.problem.detail : 'Could not update the task. It stays here until the request is acknowledged; retry checks the same request.');
  } finally { locked.current = false; setBusy(false); onBusyChange?.(false); }
 }
 async function reload() {
  if (disabled || locked.current) return;
  locked.current = true; setBusy(true); onBusyChange?.(true);
  try { await onReload(); setError(null); }
  catch (caught) { setError(caught instanceof ApiError ? caught.problem.detail : 'Could not reload the task. Please retry.'); }
  finally { locked.current = false; setBusy(false); onBusyChange?.(false); }
 }
 const actions: Action[] = task.status === 'DELETED' ? ['restore'] : task.status === 'ARCHIVED' ? ['restore', 'delete'] : ['archive', 'delete'];
 return <section className="task-lifecycle" aria-label={`Lifecycle actions for ${task.title}`}>
  {disabled && <p className="muted">Save or discard unsaved task and subtask drafts before changing task state.</p>}
  {error && <div role="alert" className="banner banner-error">{error} <button type="button" disabled={busy || disabled} onClick={() => void reload()}>{reloadLabel}</button></div>}
  <div className="row">{actions.map((action) => <button type="button" key={action} disabled={disabled || busy} onClick={() => void act(action)}>{labels[action]}</button>)}</div>
  {busy && <p role="status">Updating task…</p>}
 </section>;
}
