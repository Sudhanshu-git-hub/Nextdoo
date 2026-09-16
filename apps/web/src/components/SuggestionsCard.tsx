'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { Suggestion, SuggestionsResponse } from '@nextdoo/contracts';
import { api, ApiError, type Task } from '@/lib/api';
import { TaskEditor } from './TaskEditor';

/**
 * Advisory suggestions (PRD §5.5/§8.5, M8-i2).
 *
 * Advisory invariant in the UI: the card states that nothing changes until
 * the user confirms, only S1 offers a confirm button, and confirming applies
 * the single permitted mutation (a versioned estimate raise) through the
 * normal task PATCH. Every other suggestion offers navigation only.
 */
export function SuggestionsCard({ period }: { period: 'day' | 'week' }) {
  const [data, setData] = useState<SuggestionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [openTask, setOpenTask] = useState<Task | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api<SuggestionsResponse>('/ai/suggestions', {
        method: 'POST',
        body: JSON.stringify({ period }),
      });
      setData(res);
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.problem.detail : 'Could not load suggestions right now.');
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    void load();
  }, [load]);

  async function confirmRaise(suggestion: Suggestion) {
    if (suggestion.action.kind !== 'raise_estimate') return;
    setConfirming(suggestion.id);
    setNotice(null);
    try {
      await api(`/tasks/${suggestion.action.taskId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          estimateMinutes: suggestion.action.suggestedMinutes,
          version: suggestion.action.taskVersion,
        }),
      });
      setNotice(`“${suggestion.target.label}” now has a ${suggestion.action.suggestedMinutes} min estimate.`);
      await load();
    } catch (caught) {
      setNotice(
        caught instanceof ApiError ? `Could not update the estimate: ${caught.problem.detail}` : 'Could not update the estimate. Try again.',
      );
    } finally {
      setConfirming(null);
    }
  }

  async function openTaskFor(taskId: string) {
    try {
      setOpenTask(await api<Task>(`/tasks/${taskId}`));
    } catch (caught) {
      setNotice(caught instanceof ApiError ? `Could not open the task: ${caught.problem.detail}` : 'Could not open the task.');
    }
  }

  function actionFor(suggestion: Suggestion) {
    switch (suggestion.action.kind) {
      case 'raise_estimate':
        return (
          <button
            type="button"
            className="btn"
            data-testid={`suggestion-confirm-${suggestion.id}`}
            disabled={confirming === suggestion.id}
            onClick={() => void confirmRaise(suggestion)}
          >
            {confirming === suggestion.id ? 'Saving…' : `Raise estimate to ${suggestion.action.suggestedMinutes} min`}
          </button>
        );
      case 'open_day':
        return (
          <Link className="history-link" href="/calendar" data-testid={`suggestion-link-${suggestion.id}`}>
            View calendar
          </Link>
        );
      case 'open_recurrence':
        return (
          <Link className="history-link" href="/recurrences" data-testid={`suggestion-link-${suggestion.id}`}>
            Open recurrence
          </Link>
        );
      case 'open_task': {
        const taskId = suggestion.action.taskId;
        return (
          <button
            type="button"
            className="btn"
            data-testid={`suggestion-open-${suggestion.id}`}
            onClick={() => void openTaskFor(taskId)}
          >
            Open task
          </button>
        );
      }
    }
  }

  return (
    <div className="card" data-testid="suggestions-card" style={{ marginTop: 14 }}>
      <h2>Suggested adjustments</h2>
      <p className="muted" style={{ marginTop: -6, marginBottom: 10 }}>
        Advisory only — nothing changes until you confirm a suggestion.
      </p>
      {loading ? (
        <p className="muted" role="status">Loading suggestions…</p>
      ) : error ? (
        <p className="muted" role="status">
          {error}
        </p>
      ) : data && data.suggestions.length === 0 ? (
        <p className="muted">No adjustments worth suggesting for this period yet.</p>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }}>
          {data?.suggestions.map((s) => (
            <li key={s.id} data-suggestion={s.type} data-testid={`suggestion-${s.id}`} style={{ marginBottom: 10, display: 'flex', gap: 10, alignItems: 'baseline' }}>
              <span style={{ flex: 1, fontSize: 14 }}>{s.message}</span>
              <span>{actionFor(s)}</span>
            </li>
          ))}
        </ul>
      )}
      {notice && (
        <p role="status" style={{ marginTop: 8, fontSize: 13 }}>
          {notice}
        </p>
      )}
      {openTask && <TaskEditor task={openTask} onClose={() => setOpenTask(null)} onSaved={() => void load()} />}
    </div>
  );
}
