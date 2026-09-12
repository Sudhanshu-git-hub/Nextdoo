'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';

/**
 * Optional review-flow note (PRD §8.5): one short, owner-authored note per
 * local day. Never judgemental, never graded — just the person's own words
 * for the day they reviewed.
 */
export function ReviewNote({ workspaceId, dayKey, dayLabel }: { workspaceId: string; dayKey: string; dayLabel: string }) {
  const query = `workspaceId=${workspaceId}&day=${dayKey}`;
  const [body, setBody] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const pending = useRef<{ key: string; body: string } | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const note = await api<{ day: string; body: string } | null>(`/tracking/review-notes?${query}`);
      if (!note) setBody('');
      else setBody(note.body);
    } catch {
      setError('Could not load your review note.');
    }
  }, [query]);
  useEffect(() => { void load(); }, [load]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const value = (body ?? '').trim();
    if (!value || busy) return;
    pending.current ??= { key: crypto.randomUUID(), body: JSON.stringify({ body: value }) };
    setBusy(true); setError(null); setSaved(false);
    try {
      await api(`/tracking/review-notes?${query}`, { method: 'PUT', headers: { 'Idempotency-Key': pending.current.key }, body: pending.current.body });
      pending.current = null;
      setBody(value);
      setSaved(true);
    } catch (caught) {
      if (caught instanceof ApiError && caught.problem.status < 500) {
        pending.current = null;
        setError(caught.problem.detail);
      } else {
        setError('The note was not saved. Retry to send it again.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    if (busy) return;
    setBusy(true); setError(null); setSaved(false);
    try {
      await api(`/tracking/review-notes?${query}`, { method: 'DELETE' });
      setBody('');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.problem.detail : 'The note could not be cleared. Retry to try again.');
    } finally {
      setBusy(false);
    }
  }

  const hasNote = (body ?? '').length > 0;

  return (
    <div className="card" style={{ marginTop: 18 }} data-review-note>
      <h2>Review note for {dayLabel}</h2>
      {body === null && <p className="muted" role="status">Loading your note…</p>}
      {body !== null && (
        <>
          <form onSubmit={save} data-review-note-form>
            <label htmlFor="review-note-body" className="muted">
              Optional — a few lines in your own words about how this day went.
            </label>
            <textarea
              id="review-note-body"
              rows={3}
              maxLength={500}
              value={body}
              onChange={(e) => { setBody(e.target.value); setSaved(false); }}
              disabled={busy}
              style={{ width: '100%', marginTop: 6 }}
            />
            <div className="row" style={{ marginTop: 8, gap: 10 }}>
              <button type="submit" disabled={busy || !(body ?? '').trim()} data-review-note-save>
                {busy ? 'Working…' : pending.current ? 'Retry same note' : 'Save note'}
              </button>
              {hasNote && (
                <button type="button" className="btn-ghost" onClick={() => void clear()} disabled={busy} data-review-note-clear>
                  Clear note
                </button>
              )}
              <span className="muted" style={{ fontSize: 12 }}>{(body ?? '').length}/500</span>
            </div>
          </form>
          {error && (
            <p role="alert" style={{ marginTop: 10 }}>
              {error} <button className="btn-sm" onClick={() => void load()} style={{ marginLeft: 6 }}>Retry</button>
            </p>
          )}
          {saved && !error && <p role="status" className="muted" style={{ marginTop: 10 }}>Saved for this day.</p>}
        </>
      )}
    </div>
  );
}
