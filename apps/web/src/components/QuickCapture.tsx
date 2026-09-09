'use client';

import { useEffect, useRef, useState } from 'react';
import type { ParseResult } from '@nextdoo/core';
import { api, ApiError } from '@/lib/api';

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

  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const value = text.trim();
    if (!value || busy) return;

    setBusy(true);
    setError(null);
    try {
      const result = await api<ParseResult>('/natural-language/parse', {
        method: 'POST',
        body: JSON.stringify({ text: value, timeZone }),
      });

      if (result.recurrence || result.requiresConfirmation || result.tags?.value.length || result.project) {
        setParsed(result);
        setAnnouncement('Please confirm the interpreted details before saving.');
        return;
      }
      await create(result);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.problem.detail : 'Could not save the task.');
    } finally {
      setBusy(false);
    }
  }

  async function create(result: ParseResult) {
    setBusy(true);
    setError(null);
    try {
      const body = JSON.stringify({
          workspaceId,
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
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.problem.detail
          : 'Could not save the task. It has been kept in the box.',
      );
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
                  Due {new Date(parsed.dueAt.value).toLocaleString()}{' '}
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
            <button type="button" className="btn-primary btn-sm" onClick={() => create(parsed)} disabled={busy}>
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
