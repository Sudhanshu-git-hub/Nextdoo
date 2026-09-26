import { localDateKey, localDayBounds, zonedTimeToUtc } from '@nextdoo/core/calendar';

export type DailyView = 'tomorrow' | 'upcoming' | 'overdue' | 'backlog' | 'completed';
/** Calendar arithmetic, never 24-hour offsets: DST days can be shorter/longer. */
export function dailyWindow(now: Date, timeZone: string, offset = 0, days = 1) {
  return dateWindow(localDateKey(now, timeZone), timeZone, offset, days);
}
export function dateWindow(key: string, timeZone: string, offset = 0, days = 1) {
  const day = new Date(key + 'T12:00:00Z');
  const midnight = (delta: number) => {
    const d = new Date(day); d.setUTCDate(d.getUTCDate() + delta);
    return zonedTimeToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 0, 0, timeZone);
  };
  return { start: midnight(offset), end: new Date(midnight(offset + days).getTime() - 1) };
}
export function dailyFilters(view: DailyView, now: Date, zone: string, horizon = 7, backlog = 'unscheduled') {
  const query = new URLSearchParams({ status: view === 'completed' ? 'COMPLETED' : 'ACTIVE', sortBy: 'dueAt', sortOrder: 'asc' });
  if (view === 'backlog' && backlog === 'unscheduled') query.set('hasDueDate', 'false');
  else if (view === 'overdue' || view === 'backlog') query.set('dueBefore', new Date(localDayBounds(now, zone).start.getTime() - 1).toISOString().replace('.999Z', '.999999Z'));
  else if (view !== 'completed') {
    const range = dailyWindow(now, zone, 1, view === 'upcoming' ? horizon : 1);
    query.set('dueAfter', range.start.toISOString()); query.set('dueBefore', range.end.toISOString().replace('.999Z', '.999999Z'));
  }
  return query;
}
