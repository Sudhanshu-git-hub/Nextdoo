'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectAnalytics as Report } from '@nextdoo/contracts';
import { api, ApiError } from '@/lib/api';
import { TrackingFreshnessNotice } from './TrackingFreshnessNotice';
import { formatTrackedDuration } from '@/lib/format-duration';

type Query = { period: 'day' | 'week'; date: string };
const percent = (value: number | null) => value === null ? 'Unmeasured' : `${Math.round(value * 100)}%`;

export function ProjectAnalytics({ projectId }: { projectId: string }) {
  const [query, setQuery] = useState<Query>(() => ({ period: 'week', date: new Date().toISOString().slice(0, 10) }));
  const [period, setPeriod] = useState(query.period), [date, setDate] = useState(query.date);
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const load = useCallback(async (background = false) => {
    if (background && request.current) return;
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    if (!background) { setLoading(true); setReport(null); }
    try {
      const result = await api<Report>(`/projects/${projectId}/analytics?${new URLSearchParams(query)}`, { signal: controller.signal });
      if (!controller.signal.aborted) { setReport(result); setError(null); }
    } catch (caught) {
      if (!controller.signal.aborted) setError(caught instanceof ApiError ? `${caught.problem.detail} Request ID: ${caught.problem.request_id ?? 'unavailable'}` : 'Could not load your project analytics. Please retry.');
    } finally { if (!controller.signal.aborted) setLoading(false); if (request.current === controller) request.current = null; }
  }, [projectId, query]);
  useEffect(() => { void load(); const interval = setInterval(() => { if (!document.hidden) void load(true); }, 5000); return () => { clearInterval(interval); request.current?.abort(); }; }, [load]);

  return <section aria-label="Project execution analytics" className="project-analytics">
    <h2>Execution analytics</h2>
    <p className="subtitle">Review planning and tracked work without judging productivity.</p>
    <form className="row" onSubmit={(event) => { event.preventDefault(); setQuery({ period, date }); }}>
      <div><label htmlFor="project-report-period">Reporting period</label>
        <select id="project-report-period" value={period} onChange={(e) => setPeriod(e.target.value as Query['period'])}>
          <option value="day">Selected day</option><option value="week">Week containing the date</option>
        </select></div>
      <div><label htmlFor="project-report-date">Report date</label><input id="project-report-date" type="date" required min="0001-01-01" max="9999-12-31" value={date} onChange={(e) => setDate(e.target.value)} /></div>
      <button type="submit" className="btn-primary">Update report</button>
    </form>
    <p className="muted">All non-deleted tasks with a due date in this window and a current project assignment here are included—not just the loaded task pages. Unscheduled tasks are excluded.</p>
    {loading && <p role="status">Loading project report…</p>}
    {error && <div className="banner banner-error" role="alert">{error} <button onClick={() => void load()}>Retry report</button></div>}
    {!loading && report && <>
      <TrackingFreshnessNotice freshness={report.freshness} windowInfo={{ timeZone: report.timeZone, weekStart: report.weekStart }} />
      <p role="status">
        Report window: {new Intl.DateTimeFormat('en-CA', { timeZone: report.timeZone }).format(new Date(report.from))} through {new Intl.DateTimeFormat('en-CA', { timeZone: report.timeZone }).format(new Date(report.to))}, inclusive ({report.timeZone}).
      </p>
      {report.plannedCount === 0 ? <div className="empty"><h3>No tasks due in this window</h3><p>Choose another date or add a due date to a project task. No score or rate can be measured for an empty window.</p></div> : <>
        <dl className="grid grid-3">
          <Metric id="plannedCount" label="Tasks due" value={String(report.plannedCount)} note="Current non-deleted tasks due in the selected window" />
          <Metric id="completionRate" label="Completion rate" value={percent(report.completionRate)} note={`${report.completedCount} currently completed of ${report.plannedCount} due`} />
          <Metric id="onTimeRate" label="On-time rate" value={percent(report.onTimeRate)} note={`${report.onTimeCount} on time of ${report.completedCount} completed; ${report.lateCount} late`} />
          <Metric id="plannedMinutes" label="Estimated time" value={formatTrackedDuration(report.plannedMinutes)} note="Sum of recorded estimates; missing estimates contribute no time" />
          <Metric id="actualMinutes" label="Tracked time" value={report.actualMeasuredCount ? formatTrackedDuration(report.actualMinutes) : 'Unmeasured'} note={`${report.actualMeasuredCount} tasks have tracked time; running time is not included until recorded`} />
          <Metric id="estimateVariancePct" label="Estimate variance" value={report.estimateVariancePct === null ? 'Unmeasured' : `${report.estimateVariancePct > 0 ? '+' : ''}${report.estimateVariancePct}%`} note={`Average relative difference for ${report.estimateMeasuredCount} tasks with both a positive estimate and tracked time; positive means longer than estimated`} />
          <Metric id="rescheduledCount" label="Tasks rescheduled" value={String(report.rescheduledCount)} note="Tasks in this window whose due date has changed at least once, at any time" />
          {report.scoresEnabled && <Metric id="averageScore" label="Stored execution score" value={report.averageScore == null ? 'Unmeasured' : String(report.averageScore)} note={`Average of ${report.scoredCount} measured stored scores; not recalculated by this report`} />}
        </dl>
        {!report.scoresEnabled && <p>Numeric scores are hidden by your stored preference.</p>}
        <p className="muted">Measurement coverage: {report.storedResultCount} stored results for {report.plannedCount} tasks; {report.missingResultCount} have no result yet and {report.unmeasuredCount} have an Unmeasured outcome. Missing results are not zero scores.</p>
        <div className="card"><h3>Planning observations</h3><ul>{report.insights.map((insight) => <li key={insight}>{insight}</li>)}</ul></div>
      </>}
    </>}
    <details style={{ marginTop: 18 }}><summary>How this report is calculated</summary>
      <ul>
        <li>A day is midnight through the end of that day in UTC. Seven days includes the selected date and six preceding dates; it is not a calendar week or a local-time window.</li>
        <li>This is a current-state view of tasks due in the window, not a historical snapshot. Moving projects or dates, reopening, archiving tasks, or deleting tasks can change past reports. Completion can occur outside the selected window.</li>
        <li>On-time completion compares completion time with the current due date. Tracked time includes recorded seconds. Estimate variance averages the relative difference per measured task, not the ratio of total durations.</li>
        <li>Scores use existing stored calculations, not a new scoring model. Some results may be missing or outdated, particularly when time passes without a task change. This read does not recalculate or modify history.</li>
      </ul>
    </details>
  </section>;
}
function Metric({ id, label, value, note }: { id: string; label: string; value: string; note: string }) {
  return <div className="card"><dt className="stat-label">{label}</dt><dd style={{ margin: 0 }}><div className="stat-value" data-testid={id}>{value}</div><div className="stat-sub">{note}</div></dd></div>;
}
