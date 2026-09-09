'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { RecurrenceRuleFields, parseRule, ruleDraft } from './RecurrenceRuleFields';
export function TaskRecurrenceActions({ taskId, version, recurrenceId, disabled, onBusyChange, onDraftChange, onReload, onSaved }: {
 taskId: string; version: number; recurrenceId?: string | null; disabled: boolean; onBusyChange: (busy: boolean) => void; onDraftChange: (dirty: boolean) => void; onReload: () => Promise<void>; onSaved: () => void;
}) {
 const [initial] = useState(() => ruleDraft()); const [draft, setDraft] = useState(initial), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
 const attempt = useRef<{ body: string; key: string } | null>(null), locked = useRef(false);
 useEffect(() => { onDraftChange(!recurrenceId && JSON.stringify(draft) !== JSON.stringify(initial)); }, [draft, initial, recurrenceId, onDraftChange]);
 async function start(e: React.FormEvent) {
  e.preventDefault(); if (disabled || locked.current) return;
  let body: string;
  try { body = JSON.stringify({ version, rule: parseRule(draft) }); } catch { setError('Check the frequency, interval, time zone and end condition.'); return; }
  if (!window.confirm('Start this recurring series? The current task is its first occurrence. New tasks copy this task’s saved metadata and tags, but not reminders, subtasks or prerequisites. Up to 50 future occurrences are generated within 60 days, subject to your task limit.')) return;
  if (attempt.current?.body !== body) attempt.current = { body, key: crypto.randomUUID() };
  locked.current = true; setBusy(true); onBusyChange(true); setError(null);
  try { await api(`/tasks/${taskId}/recurrence`, { method: 'POST', headers: { 'Idempotency-Key': attempt.current.key }, body }); await onReload(); onSaved(); onDraftChange(false); }
  catch (caught) { setError(caught instanceof ApiError ? caught.problem.detail : 'The request was not acknowledged. Your recurrence draft is kept; retry uses the same request identity.'); }
  finally { locked.current = false; setBusy(false); onBusyChange(false); }
 }
 return <details className="task-recurrence" style={{ marginTop: 20 }}><summary>Recurrence</summary>
  {recurrenceId ? <p><Link className="history-link" href={`/recurrences/${recurrenceId}`} aria-disabled={disabled || busy} onClick={(event) => { if (disabled || busy) event.preventDefault(); }}>Manage recurrence</Link> — pausing stops generation, not existing tasks. {disabled && <span>Save or discard other changes before opening recurrence.</span>}</p> : <form onSubmit={start}>
   <p className="muted">Save an active task with its first due date before starting recurrence. The saved first date anchors the local time in your chosen zone.</p>
   {disabled && <p className="muted">Finish other task edits before starting recurrence.</p>}
   <fieldset disabled={disabled || busy} style={{ border: 0, padding: 0 }}><RecurrenceRuleFields prefix="task-series" draft={draft} onChange={setDraft} /><button type="submit">{busy ? 'Starting…' : 'Start recurrence'}</button></fieldset>
  </form>}
  {error && <div className="banner banner-error" role="alert">{error} <button type="button" disabled={disabled || busy} onClick={() => { void onReload().then(() => setError(null)).catch(() => setError('Could not reload the task. Retry when connected.')); }}>Reload recurrence task</button></div>}
 </details>;
}
