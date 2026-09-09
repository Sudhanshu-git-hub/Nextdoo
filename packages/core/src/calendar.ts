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
export const minuteTime = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
export function workdayDescription(start: number, end: number) { return `${minuteTime(start)}–${minuteTime(end)}${end < start ? ' (next day)' : ''}`; }
export { localParts, localDateKey, zonedTimeToUtc } from './recurrence';

/** Nominal wall-clock preference, not elapsed DST-day capacity. */
export const workdayMinutes = (start: number, end: number) => (end - start + 1440) % 1440;
