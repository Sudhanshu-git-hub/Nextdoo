import { expect, it } from 'vitest';
import { localDayBounds, workspaceWeek, workdayDescription, workdayMinutes } from './calendar';
it('uses 23/25-hour local days across DST rather than adding 24 elapsed hours', () => {
 for (const [date, hours] of [['2026-03-08T12:00:00Z', 23], ['2026-11-01T12:00:00Z', 25]] as const) { const b = localDayBounds(new Date(date), 'America/New_York'); expect(b.end.getTime() + 1 - b.start.getTime()).toBe(hours * 3600000); }
});
it('honors workspace-local dates and either Sunday or Monday week starts', () => {
 const now = new Date('2026-09-06T20:00:00Z');
 expect(workspaceWeek(now, 'Asia/Kolkata', 1).days[0].toISOString()).toBe('2026-09-06T18:30:00.000Z');
 expect(workspaceWeek(now, 'Asia/Kolkata', 0).days[0].toISOString()).toBe('2026-09-05T18:30:00.000Z');
 expect(workspaceWeek(now, 'UTC', 1, 1).days[0].toISOString()).toBe('2026-09-07T00:00:00.000Z');
});
it('labels same-day, overnight and midnight end times without treating them as actual elapsed capacity', () => {
 expect(workdayMinutes(1320, 360)).toBe(480); expect(workdayMinutes(540, 780)).toBe(240);
 expect(workdayDescription(540, 1020)).toBe('09:00–17:00'); expect(workdayDescription(1320, 360)).toBe('22:00–06:00 (next day)'); expect(workdayDescription(540, 0)).toBe('09:00–00:00 (next day)');
});
