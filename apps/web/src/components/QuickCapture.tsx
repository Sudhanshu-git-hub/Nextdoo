'use client';
import { useWorkspace } from './WorkspaceContext';

import { useEffect, useRef, useState } from 'react';
import { parseTaskText, type ParseResult } from '@nextdoo/core/nl-parse';
import { api, ApiError } from '@/lib/api';
import { cacheTask, enqueue } from '@/lib/offline-queue';

/**
 * Quick capture (PRD §8.2).
 *
 * Saves immediately when the parse is unambiguous; shows a confirmation strip
 * when confidence is low, so we never silently guess a date the user did not mean.
 */
export function QuickCapture({ workspaceId, onCreated }: { workspaceId: string; onCreated: () => void }) {
  const [text, setText] = useState('');
  const [parsed, setParsed] = useState<ParseResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const mutation = useRef<{ body: string; key: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // PRD §20.3: capture latency = time from capture UI open (first focus) to save.
  const openedAt = useRef<number | null>(null);

  function markOpened() {
    if (openedAt.current === null) openedAt.current = performance.now();
  }

  /** Best-effort, content-free telemetry (schema-strict on the server). */
  function reportCapture(success: boolean, confirmed: boolean) {
    if (openedAt.current === null) return;
    const latencyMs = Math.max(0, Math.round(performance.now() - openedAt.current));
    openedAt.current = null;
    void api('/telemetry/capture', { method: 'POST', body: JSON.stringify({ latencyMs, success, confirmed }) }).catch(() => undefined);
  }

  // `N` focuses capture from anywhere, unless the user is already typing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
      if (event.key === 'n' && !typing && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        inputRef.current?.focus();
      }
      if (event.key === 'Escape' && parsed) setParsed(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [parsed]);

  const { timeZone } = useWorkspace();

  /** True when the request died without a server answer (network failure). */
  function isNetworkFailure(caught: unknown): boolean {
    if (!(caught instanceof ApiError)) return true;
    return caught.problem.status >= 500 || !navigator.onLine;
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const value = text.trim();
    if (!value || busy) return;

    setBusy(true);
    setError(null);
    let result: ParseResult;
    try {
      result = await api<ParseResult>('/natural-language/parse', {
        method: 'POST',
        body: JSON.stringify({ text: value, timeZone }),
      });
    } catch (caught) {
      if (isNetworkFailure(caught)) {
        // The deterministic parser (PRD §6.10) is the same grammar the server
        // route wraps, so capture keeps working with no connection — no model.
        result = parseTaskText(value, timeZone);
      } else {
        setError(caught instanceof ApiError ? caught.problem.detail : 'Could not save the task.');
        reportCapture(false, false);
        setBusy(false);
        return;
      }
    }

    try {
      if (result.recurrence || result.requiresConfirmation || result.tags?.value.length || result.project) {
        setParsed(result);
        setAnnouncement('Please confirm the interpreted details before saving.');
        return;
      }
      await create(result, false);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Offline capture (PRD §10.3, M5 "offline capture"): enqueue the create with
   * a client-generated entity ID and cache the row locally. The same ID goes
   * into the online request as `clientMutationId`, so a create whose response
   * was lost dedupes to `duplicate` on the later push — never a twin task.
   */
  async function tryEnqueueOffline(taskId: string, result: ParseResult): Promise<boolean> {
    const now = new Date().toISOString();
    const payload: Record<string, unknown> = {
      title: result.title,
      dueAt: result.dueAt?.value ?? null,
      estimateMinutes: result.estimateMinutes?.value ?? null,
      priority: result.priority?.value ?? 'NONE',
      timeZone,
      tagIds: [],
      tagNames: result.tags?.value ?? [],
      projectName: result.project?.value,
    };
    try {
      await enqueue({
        workspaceId,
        mutationId: crypto.randomUUID(),
        entityType: 'task',
        entityId: taskId,
        operation: 'create',
        baseVersion: null,
        payload,
      });
      await cacheTask(workspaceId, {
        id: taskId,
        workspaceId,
        projectId: null,
        sectionId: null,
        parentTaskId: null,
        recurrenceRuleId: null,
        title: result.title,
        description: null,
        location: null,
        status: 'ACTIVE',
        priority: result.priority?.value ?? 'NONE',
        dueAt: result.dueAt?.value ?? null,
        timeZone,
        estimateMinutes: result.estimateMinutes?.value ?? null,
        actualMinutes: 0,
        actualSeconds: 0,
        rescheduleCount: 0,
        version: 1,
        completedAt: null,
        deletedAt: null,
        restoreUntil: null,
        createdAt: now,
      });
      return true;
    } catch {
      return false;
    }
  }

  async function create(result: ParseResult, confirmed: boolean) {
    setBusy(true);
    setError(null);
    const taskId = crypto.randomUUID();
    try {
      const body = JSON.stringify({
          workspaceId,
          clientMutationId: taskId,
          title: result.title,
          dueAt: result.dueAt?.value ?? null,
          estimateMinutes: result.estimateMinutes?.value ?? null,
          priority: result.priority?.value ?? 'NONE',
          timeZone,
          tagIds: [],
          tagNames: result.tags?.value ?? [],
          projectName: result.project?.value,
          recurrenceRule: result.recurrence ? { ...result.recurrence.value, timeZone } : null,
        });
      if (mutation.current?.body !== body) mutation.current = { body, key: crypto.randomUUID() };
      await api('/tasks', { method: 'POST', headers: { 'Idempotency-Key': mutation.current.key }, body });
      mutation.current = null;
      setText('');
      setParsed(null);
      setAnnouncement(`Task added: ${result.title}`);
      onCreated();
      reportCapture(true, confirmed);
    } catch (caught) {
      if (isNetworkFailure(caught) && !result.recurrence) {
        const queued = await tryEnqueueOffline(taskId, result);
        if (queued) {
          setText('');
          setParsed(null);
          setAnnouncement(`Saved offline: "${result.title}" will sync when you're back online.`);
          onCreated();
          reportCapture(true, confirmed);
          setBusy(false);
          return;
        }
        setError('Could not save the task, and offline storage is unavailable. Check your connection and try again.');
      } else if (isNetworkFailure(caught)) {
        // Recurrence commands can only be applied online; keep the user's
        // text in the box rather than enqueuing something that can never apply.
        setError('Recurring tasks need a connection. Your text is still in the box — nothing was lost.');
      } else {
        // 4xx: a server answer; enqueuing would only resurface the same error.
        setError(caught instanceof ApiError ? caught.problem.detail : 'Could not save the task.');
      }
      reportCapture(false, confirmed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginBottom: 18 }}>
      <form onSubmit={submit} role="search">
        <label htmlFor="capture" className="sr-only">
          Add a task. You can write natural language, for example: report tomorrow at 2pm for 90 minutes
        </label>
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          <input
            id="capture"
            ref={inputRef}
            value={text}
            onFocus={markOpened}
            onKeyUp={markOpened}
            onBlur={() => { if (text === '') openedAt.current = null; }}
            onChange={(e) => { setText(e.target.value); setParsed(null); }}
            placeholder="Add a task…  e.g. Prepare Q3 report tomorrow at 2pm for 90 minutes"
            aria-describedby="capture-hint"
            autoComplete="off"
            disabled={busy}
          />
          <button type="submit" className="btn-primary" disabled={busy || !text.trim()}>
            {busy ? 'Saving…' : 'Add'}
          </button>
        </div>
        <p id="capture-hint" className="muted" style={{ marginTop: 6 }}>
          Press <span className="kbd">N</span> to focus. Dates, durations and <span className="kbd">!p1</span> are supported.
          Use #tags and +existing-project with confirmation. Recurring capture needs a first date and confirmation.
        </p>
      </form>

      {error && (
        <div className="banner banner-error" role="alert">{error}</div>
      )}

      {parsed && (
        <div className="banner banner-warn" role="group" aria-label="Confirm interpreted task details">
          <strong>Please confirm</strong>
          <div style={{ marginTop: 8 }}>
            <div><strong>{parsed.title}</strong></div>
            <div className="muted" style={{ marginTop: 4 }}>
              {parsed.dueAt && (
                <span>
                  Due {new Date(parsed.dueAt.value).toLocaleString(undefined, { timeZone })}{' '}
                  ({Math.round(parsed.dueAt.confidence * 100)}% confident)
                </span>
              )}
              {parsed.tags && <p>Tags: {parsed.tags.value.join(", ")}</p>}
              {parsed.recurrence && <p>Repeats {parsed.recurrence.value.freq.toLowerCase()}, interval {parsed.recurrence.value.interval ?? 1}, in {timeZone}. This creates a series with up to 50 future tasks within 60 days, subject to your task limit. A first due date is required; reminders and relationships are not copied.</p>}
              {parsed.project && <p>Project: {parsed.project.value} (must already exist)</p>}
              {parsed.estimateMinutes && <span> · Estimate {parsed.estimateMinutes.value} min</span>}
            </div>
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <button type="button" className="btn-primary btn-sm" onClick={() => void create(parsed, true)} disabled={busy}>
              Save as shown
            </button>
            <button type="button" className="btn-sm" onClick={() => setParsed(null)}>
              Edit text
            </button>
          </div>
        </div>
      )}

      <div aria-live="polite" className="sr-only">{announcement}</div>
    </div>
  );
}
