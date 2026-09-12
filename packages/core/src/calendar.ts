import { localParts, zonedTimeToUtc } from './recurrence';
function midnight(day: Date, zone: string) { return zonedTimeToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), 0, 0, zone); }
export function localDayBounds(now: Date, zone: string) {
 const p = localParts(now, zone), date = new Date(Date.UTC(p.year, p.month - 1, p.day));
 const start = midnight(date, zone); date.setUTCDate(date.getUTCDate() + 1);
 return { start, end: new Date(midnight(date, zone).getTime() - 1) };
}
export function workspaceWeek(now: Date, zone: string, weekStart: number, offset = 0) {
 const p = localParts(now, zone), date = new Date(Date.UTC(p.year, p.month - 1, p.day));
 date.setUTCDate(date.getUTCDate() - (p.weekday - weekStart + 7) % 7 + offset * 7);
 const at = (i: number) => { const d = new Date(date); d.setUTCDate(d.getUTCDate() + i); return midnight(d, zone); };
 const days: [Date, Date, Date, Date, Date, Date, Date] = [at(0), at(1), at(2), at(3), at(4), at(5), at(6)];
 return { days, end: new Date(at(7).getTime() - 1) };
}
/**
 * 42-cell (6 weeks) month grid in the workspace zone: local midnights of each
 * cell starting at the week-start weekday of the displayed month. `monthOffset`
 * shifts the displayed month. `end` is the last instant of the 42nd cell.
 */
export function workspaceMonthGrid(now: Date, zone: string, weekStart: number, monthOffset = 0) {
 const p = localParts(now, zone);
 const shifted = new Date(Date.UTC(p.year, p.month - 1 + monthOffset, 1));
 const year = shifted.getUTCFullYear(), month = shifted.getUTCMonth() + 1;
 const firstMidnight = midnight(new Date(Date.UTC(year, month - 1, 1)), zone);
 const firstWeekday = localParts(firstMidnight, zone).weekday;
 const start = new Date(Date.UTC(year, month - 1, 1));
 start.setUTCDate(start.getUTCDate() - (firstWeekday - weekStart + 7) % 7);
 const at = (i: number) => { const d = new Date(start); d.setUTCDate(d.getUTCDate() + i); return midnight(d, zone); };
 const first = at(0);
 const cells: Date[] = Array.from({ length: 42 }, (_, i) => at(i));
 return { cells, start: first, end: new Date(at(42).getTime() - 1) };
}
export const minuteTime = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
export function workdayDescription(start: number, end: number) { return `${minuteTime(start)}–${minuteTime(end)}${end < start ? ' (next day)' : ''}`; }
export { localParts, localDateKey, zonedTimeToUtc } from './recurrence';

/** Nominal wall-clock preference, not elapsed DST-day capacity. */
export const workdayMinutes = (start: number, end: number) => (end - start + 1440) % 1440;
