import type { TrackingSummaryFreshness } from '@nextdoo/contracts';

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function TrackingFreshnessNotice({ freshness, windowInfo }: { freshness: TrackingSummaryFreshness; windowInfo: { timeZone: string; weekStart: number } }) {
 return <div className={freshness.staleCount?'banner':'muted'} role="note" aria-label="Tracking freshness" aria-live="polite" data-tracking-summary-state={freshness.staleCount?'STALE':'FRESH'}>
  {freshness.staleCount?<><strong>Tracking is not up to date for {freshness.staleCount} task(s) in this reporting window.</strong>
   <p>Stored scores may be outdated or incomplete: {freshness.pendingCount} pending, {freshness.retryingCount} retrying, {freshness.failedCount} need attention. Current task counts and recorded time are still shown. Open Analytics → Tracking status and evidence to review or request evaluation.</p></>:<p>Tracking results are up to date for this reporting window.</p>}
  <small>Checked {new Date(freshness.observedAt).toLocaleString()}. Summary days use the workspace time zone ({windowInfo.timeZone}); “This week” starts on {WEEKDAY_NAMES[windowInfo.weekStart]}.</small>
 </div>;
}
