import { expect, it } from 'vitest';
import { localDateKey, localDayBounds, localParts, workspaceMonthGrid, workspaceWeek, workdayDescription, workdayMinutes } from './calendar';
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
it('builds a 42-cell month grid aligned to the week start with exact local day bounds', () => {
 // 2026-09-06 is a Sunday; September 2026 starts on a Tuesday.
 const now = new Date('2026-09-06T20:00:00Z');
 const monday = workspaceMonthGrid(now, 'Asia/Kolkata', 1);
 expect(monday.cells).toHaveLength(42);
 expect(localDateKey(monday.cells[0]!, 'Asia/Kolkata')).toBe('2026-08-31');
 expect(localDateKey(monday.cells[6]!, 'Asia/Kolkata')).toBe('2026-09-06');
 expect(localDateKey(monday.cells[7]!, 'Asia/Kolkata')).toBe('2026-09-07');
 expect(localDateKey(monday.cells[41]!, 'Asia/Kolkata')).toBe('2026-10-11');
 expect(localDateKey(monday.end, 'Asia/Kolkata')).toBe('2026-10-11');
 expect(monday.start.getTime()).toBe(monday.cells[0]!.getTime());
 const sunday = workspaceMonthGrid(now, 'Asia/Kolkata', 0);
 expect(localDateKey(sunday.cells[0]!, 'Asia/Kolkata')).toBe('2026-08-30');
 expect(localDateKey(sunday.cells[41]!, 'Asia/Kolkata')).toBe('2026-10-10');
});
it('shifts the displayed month by monthOffset, including across year boundaries', () => {
 const now = new Date('2026-09-06T20:00:00Z');
 expect(localDateKey(workspaceMonthGrid(now, 'UTC', 1, 1).cells[0]!, 'UTC')).toBe('2026-09-28'); // October 2026 starts Thursday
 expect(localDateKey(workspaceMonthGrid(now, 'UTC', 1, -1).cells[0]!, 'UTC')).toBe('2026-07-27'); // August 2026 starts Saturday
 expect(localDateKey(workspaceMonthGrid(now, 'UTC', 1, 4).cells[0]!, 'UTC')).toBe('2026-12-28'); // January 2027 starts Friday; grid starts the containing Monday
 expect(localDateKey(workspaceMonthGrid(now, 'UTC', 0, -11).cells[0]!, 'UTC')).toBe('2025-09-28'); // October 2025, Sunday start
});
it('keeps consecutive local days across a DST transition inside the grid', () => {
 // The February 2026 grid in America/New_York runs Jan 26 – Mar 8, ending on
 // the 2026-03-08 spring-forward day itself.
 const grid = workspaceMonthGrid(new Date('2026-02-15T12:00:00Z'), 'America/New_York', 1);
 expect(localDateKey(grid.cells[0]!, 'America/New_York')).toBe('2026-01-26');
 expect(localDateKey(grid.cells[41]!, 'America/New_York')).toBe('2026-03-08');
 for (let i = 1; i < 42; i++) {
  const p = localParts(grid.cells[i - 1]!, 'America/New_York');
  const next = new Date(Date.UTC(p.year, p.month - 1, p.day) + 86400000);
  const expected = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
  expect(localDateKey(grid.cells[i]!, 'America/New_York')).toBe(expected);
 }
});
