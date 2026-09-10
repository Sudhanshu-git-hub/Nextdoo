'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { formatTrackedDuration } from '@/lib/format-duration';
import { api, ApiError } from '@/lib/api';

import type { ExecutionSummary } from '@nextdoo/contracts';
import { TrackingPanel } from '@/components/TrackingPanel';
import { TrackingFreshnessNotice } from '@/components/TrackingFreshnessNotice';
import { ReviewNote } from '@/components/ReviewNote';
type Summary = Omit<ExecutionSummary, 'averageScore'> & { averageScore?: number | null; scoresEnabled: boolean };

/** An instant whose wall time in `timeZone` is noon on the local date key. */
function localNoon(key: string, timeZone: string): Date {
  let instant = new Date(`${key}T12:00:00Z`);
  const check = new Intl.DateTimeFormat('en-CA', { timeZone }).format(instant);
  if (check !== key) instant = new Date(instant.getTime() + (check < key ? 1 : -1) * 12 * 3600_000);
  return instant;
}
const dayName = (key: string, timeZone: string) =>
  new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone }).format(localNoon(key, timeZone));

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

      {summary && (
        <p className="muted" style={{ margin: '10px 0 0', fontSize: 13 }} data-summary-window>
          {(() => {
            const fmtDay = (iso: string) => new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: summary.timeZone }).format(new Date(iso));
            return `${summary.period === 'week' ? 'Week' : 'Day'} ${fmtDay(summary.from)} – ${fmtDay(summary.to)} · times in ${summary.timeZone}`;
          })()}
        </p>
      )}
      {summary && <TrackingFreshnessNotice freshness={summary.freshness} windowInfo={{ timeZone: summary.timeZone, weekStart: summary.weekStart }} />}

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
              sub={
                summary.lateCount > 0 && summary.lateAverageMinutes != null
                  ? `${summary.lateCount} finished late, average ${formatTrackedDuration(summary.lateAverageMinutes)} over`
                  : `${summary.lateCount} finished late`
              }
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
                <ul data-insights style={{ margin: 0, paddingLeft: 18 }}>
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

          <DayTable summary={summary} />
          {summary.period === 'week' && <WeeklyTrends summary={summary} />}
        </>
      )}
      {summary && (
        <ReviewNote
          workspaceId={workspaceId}
          dayKey={new Intl.DateTimeFormat('en-CA', { timeZone: summary.timeZone }).format(new Date())}
          dayLabel={new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: summary.timeZone }).format(new Date())}
        />
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

/** Per-day trend points (PRD §7.8): one row per local day in the window. */
function DayTable({ summary }: { summary: Summary }) {
  const workday = summary.days.find((d) => d.workdayMinutes != null)?.workdayMinutes ?? null;
  const th = { textAlign: 'left' as const, padding: '4px 10px 4px 0' };
  const td = { padding: '6px 10px 6px 0', borderBottom: '1px solid var(--border, rgba(128,128,128,0.18))' };
  return (
    <div className="card" style={{ marginTop: 18 }} data-day-table>
      <h2>{summary.period === 'week' ? 'Each day of this window' : 'Today in detail'}</h2>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr>
              <th scope="col" style={th}>Day</th>
              <th scope="col" style={th}>Planned</th>
              <th scope="col" style={th}>Completed</th>
              <th scope="col" style={th}>Focus time</th>
              {summary.scoresEnabled && <th scope="col" style={th}>Score</th>}
              <th scope="col" style={th}>Planned load</th>
            </tr>
          </thead>
          <tbody>
            {summary.days.map((d) => (
              <tr key={d.day}>
                <td style={td}>{dayName(d.day, summary.timeZone)}</td>
                <td style={td} data-day-planned>{d.plannedCount || '—'}</td>
                <td style={td} data-day-completed>{d.plannedCount ? `${d.completedCount} of ${d.plannedCount}` : '—'}</td>
                <td style={td} data-day-focus>{d.focusMinutes > 0 ? formatTrackedDuration(d.focusMinutes) : '—'}</td>
                {summary.scoresEnabled && <td style={td} data-day-score>{d.score == null ? '—' : Math.round(d.score)}</td>}
                <td style={td} data-day-load>
                  {d.plannedCount ? (
                    <>
                      {formatTrackedDuration(d.plannedMinutes)}
                      {d.overloaded && workday != null && (
                        <span role="note" data-day-overloaded style={{ marginLeft: 8, color: 'var(--warn, #b45309)' }}>
                          over the {formatTrackedDuration(workday)} workday
                        </span>
                      )}
                    </>
                  ) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted" style={{ marginTop: 10 }}>
        A day shows “—” where nothing measurable exists.
        {workday != null && ` Planned load is compared against your ${formatTrackedDuration(workday)} workday.`}
      </p>
    </div>
  );
}

/** The remaining §7.8 weekly trends: recurrence adherence, focus, reschedules,
 * and underestimated categories. Each says so plainly when unmeasured. */
function WeeklyTrends({ summary }: { summary: Summary }) {
  const totalFocus = summary.days.reduce((s, d) => s + d.focusMinutes, 0);
  const bestFocusDay = summary.days.filter((d) => d.focusMinutes > 0).sort((a, b) => b.focusMinutes - a.focusMinutes)[0];
  const { recurrence } = summary;
  const adherenceValue =
    recurrence.recurringCount === 0
      ? 'None planned'
      : recurrence.adherencePct == null
        ? 'Not measurable'
        : `${Math.round(recurrence.adherencePct)}%`;
  return (
    <div className="grid grid-2" style={{ marginTop: 18 }}>
      <div className="card" data-week-recurring>
        <h2>Recurring tasks</h2>
        <div className="stat-label">Adherence to the schedule</div>
        <div className="stat-value" data-recurrence-adherence>{adherenceValue}</div>
        <div className="stat-sub">
          {recurrence.recurringCount
            ? `${recurrence.measuredCount} of ${recurrence.recurringCount} recurring task(s) had measurable occurrences this window`
            : 'No recurring tasks were due in this window'}
        </div>
      </div>
      <div className="card" data-week-focus>
        <h2>Focus time</h2>
        <div className="stat-label">Tracked in this window</div>
        <div className="stat-value" data-week-focus-total>{formatTrackedDuration(totalFocus)}</div>
        <div className="stat-sub">
          {bestFocusDay
            ? `Most on ${dayName(bestFocusDay.day, summary.timeZone)} (${formatTrackedDuration(bestFocusDay.focusMinutes)})`
            : 'No focus sessions started in this window'}
        </div>
      </div>
      <div className="card" data-week-rescheduled>
        <h2>Most rescheduled</h2>
        {summary.mostRescheduled.length ? (
          <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
            {summary.mostRescheduled.map((t) => (
              <li key={t.taskId} data-rescheduled-task style={{ marginBottom: 6 }}>
                {t.title} — moved {t.count} {t.count === 1 ? 'time' : 'times'}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted" style={{ marginTop: 8 }}>No tasks changed date in this window.</p>
        )}
      </div>
      <div className="card" data-week-tags>
        <h2>Underestimated categories</h2>
        {summary.tagVariances.length ? (
          <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
            {summary.tagVariances.map((t) => (
              <li key={t.tagId} data-tag-variance style={{ marginBottom: 6 }}>
                {t.name} — about +{t.variancePct}% over estimate ({t.taskCount} task{t.taskCount === 1 ? '' : 's'})
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted" style={{ marginTop: 8 }}>No tagged category clearly came in above its estimates.</p>
        )}
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
