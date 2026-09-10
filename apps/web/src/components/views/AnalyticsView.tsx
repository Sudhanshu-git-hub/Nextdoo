'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { formatTrackedDuration } from '@/lib/format-duration';
import { api, ApiError } from '@/lib/api';

import type { ExecutionSummary } from '@nextdoo/contracts';
import { TrackingPanel } from '@/components/TrackingPanel';
import { TrackingFreshnessNotice } from '@/components/TrackingFreshnessNotice';
type Summary = Omit<ExecutionSummary, 'averageScore'> & { averageScore?: number | null; scoresEnabled: boolean };

/**
 * Analytics / weekly review (PRD §7.8).
 *
 * Every number is paired with what it was computed from. Where nothing
 * measurable exists we say so instead of rendering a misleading zero.
 */
export function AnalyticsView({ workspaceId, taskId }: { workspaceId: string; taskId?: string }) {
  const [period, setPeriod] = useState<'day' | 'week'>('week');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const request = useRef<AbortController | null>(null);
  const load = useCallback(async (background = false) => {
    if (background && request.current) return;
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    if (!background) setLoading(true);
    try {
      const data = await api<Summary>(`/tracking/summary?workspaceId=${workspaceId}&period=${period}`, { signal: controller.signal });
      if (!controller.signal.aborted) { setSummary(data); setError(null); }
    } catch (caught) {
      if (!controller.signal.aborted) setError(caught instanceof ApiError ? `${caught.problem.detail} Request ID: ${caught.problem.request_id ?? 'unavailable'}` : 'Could not refresh analytics. Displayed data is the last loaded snapshot.');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
      if (request.current === controller) request.current = null;
    }
  }, [workspaceId, period]);
  useEffect(() => {
    setSummary(null); void load();
    const interval = setInterval(() => { if (!document.hidden) void load(true); }, 5000);
    return () => { clearInterval(interval); request.current?.abort(); };
  }, [load]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Analytics</h1>
          <p className="subtitle">Whether execution matched intention — not a productivity score to chase.</p>
        </div>
        <div className="row" role="group" aria-label="Reporting period">
          <button
            onClick={() => setPeriod('day')}
            className={period === 'day' ? 'btn-primary' : ''}
            aria-pressed={period === 'day'}
          >
            Today
          </button>
          <button
            onClick={() => setPeriod('week')}
            className={period === 'week' ? 'btn-primary' : ''}
            aria-pressed={period === 'week'}
          >
            This week
          </button>
        </div>
      </div>

      {summary && <TrackingFreshnessNotice freshness={summary.freshness} />}

      {error && (
        <div className="banner banner-error" role="alert">
          {error} <button className="btn-sm" onClick={() => void load()} style={{ marginLeft: 8 }}>Retry</button>
        </div>
      )}

      {loading && (
        <div className="grid grid-3" aria-busy="true">
          {[0, 1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: 96 }} />)}
        </div>
      )}

      {!loading && summary && summary.plannedCount === 0 && (
        <div className="empty">
          <div className="empty-title">Nothing to review yet</div>
          <p>Once you have planned and completed some work, this page will show how the two compared.</p>
        </div>
      )}

      {!loading && summary && summary.plannedCount > 0 && (
        <>
          <div className="grid grid-3" style={{ marginBottom: 18 }}>
            <Stat
              label="Completion"
              value={summary.completionRate == null ? '—' : `${Math.round(summary.completionRate * 100)}%`}
              sub={`${summary.completedCount} of ${summary.plannedCount} planned`}
            />
            <Stat
              label="On time"
              value={summary.onTimeRate == null ? '—' : `${Math.round(summary.onTimeRate * 100)}%`}
              sub={`${summary.lateCount} finished late`}
            />
            <Stat
              label="Estimate accuracy"
              value={
                summary.estimateVariancePct == null
                  ? 'Not measurable'
                  : `${summary.estimateVariancePct > 0 ? '+' : ''}${Math.round(summary.estimateVariancePct)}%`
              }
              sub={
                summary.estimateVariancePct == null
                  ? 'No estimates recorded'
                  : summary.estimateVariancePct > 0
                    ? 'Work took longer than estimated'
                    : 'Work finished faster than estimated'
              }
            />
            {summary.scoresEnabled && <Stat
              label="Execution score"
              value={summary.averageScore == null ? 'Not measurable' : String(Math.round(summary.averageScore))}
              sub={
                summary.unmeasuredCount > 0
                  ? `${summary.unmeasuredCount} task(s) had nothing measurable`
                  : 'Stored score across completion, timing, estimates and recurrence; see freshness above'
              }
            />}
            {!summary.scoresEnabled && <p>Numeric scores are hidden by your stored preference.</p>}
          </div>

          <div className="grid grid-2">
            <div className="card">
              <h2>Planned vs actual time</h2>
              <Bar label="Planned" minutes={summary.plannedMinutes} max={Math.max(summary.plannedMinutes, summary.actualMinutes, 1)} />
              <Bar label="Actual" minutes={summary.actualMinutes} max={Math.max(summary.plannedMinutes, summary.actualMinutes, 1)} />
              <p className="muted" style={{ marginTop: 10 }}>
                Actual time comes from focus sessions and manually logged time. Tasks with neither are excluded.
              </p>
            </div>

            <div className="card">
              <h2>What this suggests</h2>
              {summary.insights.length === 0 ? (
                <p className="muted">Not enough signal yet to say anything useful.</p>
              ) : (
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {summary.insights.map((insight) => (
                    <li key={insight} style={{ marginBottom: 7, fontSize: 14 }}>{insight}</li>
                  ))}
                </ul>
              )}
              {summary.rescheduledCount > 0 && (
                <p className="muted" style={{ marginTop: 10 }}>
                  {summary.rescheduledCount} task(s) were moved to a later date in this period.
                </p>
              )}
            </div>
          </div>
        </>
      )}
      {/* Renders even when every task in the window is excluded (plannedCount 0). */}
      {summary?.excludedCount ? (
        <p className="muted" role="status" style={{ marginTop: 12 }}>
          {summary.excludedCount} task(s) in this period are hidden by an “excluded from analytics” correction.
        </p>
      ) : null}
      <RecalculateRange />
      <TrackingPanel taskId={taskId} />
    </>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="card">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      <div className="stat-sub">{sub}</div>
    </div>
  );
}

function Bar({ label, minutes, max }: { label: string; minutes: number; max: number }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div className="spread" style={{ marginBottom: 5, fontSize: 13 }}>
        <span>{label}</span>
        <span className="muted">{formatTrackedDuration(minutes)}</span>
      </div>
      <div className="bar">
        <i style={{ width: `${Math.min(100, (minutes / max) * 100)}%` }} />
      </div>
    </div>
  );
}

const dayKey = (offsetDays: number) => new Date(Date.now() - offsetDays * 86_400_000).toISOString().slice(0, 10);
type BackfillProgress = { from: string; to: string; totalDays: number; processedDays: number; remainingDays: number; status: 'PENDING' | 'COMPLETED' };

/**
 * PRD §7.6: recalculate a date range (default: last 90 days). Bounded and
 * observable — the worker advances one day per run, history is superseded
 * never mutated, and 10 requests/hour/user are allowed (PRD §14.8).
 */
function RecalculateRange() {
  const [from, setFrom] = useState(() => dayKey(89));
  const [to, setTo] = useState(() => dayKey(0));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<BackfillProgress | null>(null);
  const pending = useRef<{ key: string; body: string } | null>(null);
  const loadProgress = useCallback(async () => {
    try {
      const res = await api<BackfillProgress | null>('/tracking/recalculate');
      setProgress(res);
    } catch {
      // Progress is a convenience; the request result is authoritative.
    }
  }, []);
  useEffect(() => {
    void loadProgress();
  }, [loadProgress]);
  useEffect(() => {
    if (!progress || progress.status !== 'PENDING') return;
    const interval = setInterval(() => { if (!document.hidden) void loadProgress(); }, 5000);
    return () => clearInterval(interval);
  }, [progress, loadProgress]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    pending.current ??= { key: crypto.randomUUID(), body: JSON.stringify({ from, to, reason: reason.trim() }) };
    setBusy(true); setError(null);
    try {
      await api('/tracking/recalculate', { method: 'POST', headers: { 'Idempotency-Key': pending.current.key }, body: pending.current.body });
      pending.current = null; setReason('');
      setError(null);
      await loadProgress();
    } catch (caught) {
      if (caught instanceof ApiError && caught.problem.status < 500) {
        pending.current = null;
        setError(caught.problem.detail);
      } else {
        setError('The request was not acknowledged. Retry to re-send the same recalculation.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginTop: 18 }} data-tracking-recalculate>
      <h2>Recalculate a date range</h2>
      <p className="muted">
        Re-evaluates every task whose due or completion date falls in the range (default: the last 90 days).
        Previous results are kept and marked superseded — never rewritten.
      </p>
      <form onSubmit={submit} data-tracking-recalc-form>
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            From
            <input type="date" aria-label="Recalculation range start" value={from} max={to} onChange={(e) => setFrom(e.target.value)} disabled={busy} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            To
            <input type="date" aria-label="Recalculation range end" value={to} min={from} max={dayKey(0)} onChange={(e) => setTo(e.target.value)} disabled={busy} />
          </label>
        </div>
        <label htmlFor="recalc-reason" style={{ display: 'block', marginTop: 10 }}>
          Reason for recalculation
        </label>
        <input
          id="recalc-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
          maxLength={500}
          disabled={busy || pending.current !== null}
        />
        <button type="submit" disabled={busy || !reason.trim()}>
          {busy ? 'Requesting…' : pending.current ? 'Retry same request' : 'Start recalculation'}
        </button>
      </form>
      {error && (
        <p role="alert" style={{ marginTop: 10 }}>
          {error}
        </p>
      )}
      {progress && (
        <p role="status" data-tracking-recalc-progress style={{ marginTop: 10 }}>
          {progress.status === 'COMPLETED'
            ? `Recalculation of ${progress.from} to ${progress.to} is complete (${progress.totalDays} day(s)).`
            : `Recalculation in progress: day ${Math.min(progress.processedDays + 1, progress.totalDays)} of ${progress.totalDays}. Previous results stay queryable while it runs.`}
        </p>
      )}
    </div>
  );
}
