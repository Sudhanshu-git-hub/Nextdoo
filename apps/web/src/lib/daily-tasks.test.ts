import { expect, it } from 'vitest';
import { dailyFilters, dailyWindow } from './daily-tasks';
it('uses the next workspace calendar date across spring and autumn DST changes', () => {
  const spring = dailyWindow(new Date('2026-03-07T18:00:00Z'), 'America/New_York', 1);
  expect(spring.start.toISOString()).toBe('2026-03-08T05:00:00.000Z');
  expect(spring.end.getTime()+1-spring.start.getTime()).toBe(23*3600000);
  const autumn = dailyWindow(new Date('2026-10-31T18:00:00Z'), 'America/New_York', 1);
  expect(autumn.end.getTime()+1-autumn.start.getTime()).toBe(25*3600000);
});
it('separates overdue from unscheduled and excludes today from the 3/7/14 day horizon', () => {
  const now=new Date('2026-09-25T20:00:00Z');
  expect(dailyFilters('backlog',now,'Asia/Kolkata').get('hasDueDate')).toBe('false');
  expect(dailyFilters('overdue',now,'Asia/Kolkata').get('dueBefore')).toBe('2026-09-25T18:29:59.999999Z');
  for(const horizon of [3,7,14]) {
    const range=dailyFilters('upcoming',now,'Asia/Kolkata',horizon);
    expect(range.get('dueAfter')).toBe('2026-09-26T18:30:00.000Z');
    expect(Date.parse(range.get('dueBefore')!)+1-Date.parse(range.get('dueAfter')!)).toBe(horizon*86400000);
  }
});
