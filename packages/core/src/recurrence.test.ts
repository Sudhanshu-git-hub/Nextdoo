import { describe, expect, it } from 'vitest';
import type { RecurrenceRuleInput } from '@nextdoo/contracts';
import { daysInMonth, generateOccurrences, localDateKey, localParts, zonedTimeToUtc } from './recurrence';

const rule = (over: Partial<RecurrenceRuleInput> = {}): RecurrenceRuleInput => ({
  freq: 'DAILY',
  interval: 1,
  timeZone: 'UTC',
  ...over,
});

describe('zone helpers', () => {
  it('formats local date keys in the target zone, not UTC', () => {
    // 23:30 in New York on the 8th is 03:30 UTC on the 9th.
    const instant = new Date('2026-09-09T03:30:00Z');
    expect(localDateKey(instant, 'America/New_York')).toBe('2026-09-08');
    expect(localDateKey(instant, 'UTC')).toBe('2026-09-09');
  });

  it('round-trips wall-clock time through zonedTimeToUtc', () => {
    const utc = zonedTimeToUtc(2026, 9, 8, 14, 0, 'America/New_York');
    const back = localParts(utc, 'America/New_York');
    expect([back.year, back.month, back.day, back.hour, back.minute]).toEqual([2026, 9, 8, 14, 0]);
  });

  it('clamps day-of-month overflow', () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2028, 2)).toBe(29); // leap year
  });
});

describe('generateOccurrences — daily', () => {
  it('generates consecutive days at a stable local time', () => {
    const start = new Date('2026-09-08T09:00:00Z');
    const occ = generateOccurrences({
      ruleId: 'r1',
      rule: rule(),
      seriesStart: start,
      after: new Date('2026-09-08T00:00:00Z'),
      horizon: new Date('2026-09-12T00:00:00Z'),
    });
    expect(occ.map((o) => o.localDate)).toEqual(['2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11']);
  });

  it('honours the interval', () => {
    const occ = generateOccurrences({
      ruleId: 'r1',
      rule: rule({ interval: 3 }),
      seriesStart: new Date('2026-09-01T09:00:00Z'),
      after: new Date('2026-08-31T00:00:00Z'),
      horizon: new Date('2026-09-11T00:00:00Z'),
    });
    expect(occ.map((o) => o.localDate)).toEqual(['2026-09-01', '2026-09-04', '2026-09-07', '2026-09-10']);
  });

  it('stops at `count`', () => {
    const occ = generateOccurrences({
      ruleId: 'r1',
      rule: rule({ count: 3 }),
      seriesStart: new Date('2026-09-01T09:00:00Z'),
      after: new Date('2026-08-31T00:00:00Z'),
      horizon: new Date('2027-01-01T00:00:00Z'),
    });
    expect(occ).toHaveLength(3);
  });

  it('stops at `until`', () => {
    const occ = generateOccurrences({
      ruleId: 'r1',
      rule: rule({ until: '2026-09-03T23:59:00Z' }),
      seriesStart: new Date('2026-09-01T09:00:00Z'),
      after: new Date('2026-08-31T00:00:00Z'),
      horizon: new Date('2027-01-01T00:00:00Z'),
    });
    expect(occ.map((o) => o.localDate)).toEqual(['2026-09-01', '2026-09-02', '2026-09-03']);
  });

  it('preserves local wall-clock time across a DST spring-forward', () => {
    // US DST begins 2026-03-08. 09:00 local must stay 09:00 local either side.
    const start = zonedTimeToUtc(2026, 3, 6, 9, 0, 'America/New_York');
    const occ = generateOccurrences({
      ruleId: 'r1',
      rule: rule({ timeZone: 'America/New_York' }),
      seriesStart: start,
      after: new Date(start.getTime() - 1000),
      horizon: new Date('2026-03-12T00:00:00Z'),
    });
    for (const o of occ) {
      expect(localParts(o.dueAt, 'America/New_York').hour).toBe(9);
    }
    // No duplicate or missing local dates across the transition.
    expect(occ.map((o) => o.localDate)).toEqual(['2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10', '2026-03-11']);
  });

  it('preserves local time across a DST fall-back', () => {
    const start = zonedTimeToUtc(2026, 10, 30, 9, 0, 'America/New_York');
    const occ = generateOccurrences({
      ruleId: 'r1',
      rule: rule({ timeZone: 'America/New_York' }),
      seriesStart: start,
      after: new Date(start.getTime() - 1000),
      horizon: new Date('2026-11-05T00:00:00Z'),
    });
    for (const o of occ) expect(localParts(o.dueAt, 'America/New_York').hour).toBe(9);
    expect(new Set(occ.map((o) => o.localDate)).size).toBe(occ.length); // no duplicates
  });
});

describe('generateOccurrences — weekly', () => {
  it('emits only the selected weekdays', () => {
    const occ = generateOccurrences({
      ruleId: 'r1',
      rule: rule({ freq: 'WEEKLY', byWeekday: [1, 3, 5] }), // Mon, Wed, Fri
      seriesStart: new Date('2026-09-07T09:00:00Z'), // a Monday
      after: new Date('2026-09-06T00:00:00Z'),
      horizon: new Date('2026-09-14T00:00:00Z'),
    });
    expect(occ.map((o) => o.localDate)).toEqual(['2026-09-07', '2026-09-09', '2026-09-11']);
  });

  it('skips weeks according to the interval', () => {
    const occ = generateOccurrences({
      ruleId: 'r1',
      rule: rule({ freq: 'WEEKLY', interval: 2, byWeekday: [1] }),
      seriesStart: new Date('2026-09-07T09:00:00Z'),
      after: new Date('2026-09-06T00:00:00Z'),
      horizon: new Date('2026-10-06T00:00:00Z'),
    });
    expect(occ.map((o) => o.localDate)).toEqual(['2026-09-07', '2026-09-21', '2026-10-05']);
  });
});

describe('generateOccurrences — monthly', () => {
  it('clamps the 31st into short months instead of skipping or duplicating', () => {
    const occ = generateOccurrences({
      ruleId: 'r1',
      rule: rule({ freq: 'MONTHLY', byMonthDay: 31 }),
      seriesStart: new Date('2026-01-31T09:00:00Z'),
      after: new Date('2026-01-01T00:00:00Z'),
      horizon: new Date('2026-05-01T00:00:00Z'),
    });
    expect(occ.map((o) => o.localDate)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
  });
});

describe('idempotency', () => {
  it('never re-emits an occurrence that already exists', () => {
    const args = {
      ruleId: 'r1',
      rule: rule(),
      seriesStart: new Date('2026-09-08T09:00:00Z'),
      after: new Date('2026-09-07T00:00:00Z'),
      horizon: new Date('2026-09-12T00:00:00Z'),
    };
    const first = generateOccurrences(args);
    const second = generateOccurrences({ ...args, existingKeys: new Set(first.map((o) => o.occurrenceKey)) });
    expect(second).toHaveLength(0); // worker retry produces no duplicates
  });

  it('produces identical keys across repeated runs', () => {
    const args = {
      ruleId: 'r1',
      rule: rule({ freq: 'WEEKLY', byWeekday: [2] }),
      seriesStart: new Date('2026-09-08T09:00:00Z'),
      after: new Date('2026-09-07T00:00:00Z'),
      horizon: new Date('2026-10-08T00:00:00Z'),
    };
    expect(generateOccurrences(args).map((o) => o.occurrenceKey)).toEqual(
      generateOccurrences(args).map((o) => o.occurrenceKey),
    );
  });

  it('respects the look-ahead cap', () => {
    const occ = generateOccurrences({
      ruleId: 'r1',
      rule: rule(),
      seriesStart: new Date('2026-01-01T09:00:00Z'),
      after: new Date('2025-12-31T00:00:00Z'),
      horizon: new Date('2027-01-01T00:00:00Z'),
      maxCount: 10,
    });
    expect(occ).toHaveLength(10);
  });
});

describe('recurrence clock and calendar regressions', () => {
  it('shifts a nonexistent local time forward by the gap', () => {
    expect(zonedTimeToUtc(2026, 3, 8, 2, 30, 'America/New_York').toISOString()).toBe('2026-03-08T07:30:00.000Z');
  });
  it('chooses the first of repeated local times', () => {
    expect(zonedTimeToUtc(2026, 11, 1, 1, 30, 'America/New_York').toISOString()).toBe('2026-11-01T05:30:00.000Z');
  });
  it('handles a half-hour gap without assuming a sixty-minute offset', () => {
    expect(zonedTimeToUtc(2026, 10, 4, 2, 15, 'Australia/Lord_Howe').toISOString()).toBe('2026-10-03T15:45:00.000Z');
  });
  it('does not duplicate local dates when midnight crosses the fall-back', () => {
    const start = zonedTimeToUtc(2026, 10, 31, 0, 15, 'America/New_York');
    const rows = generateOccurrences({ ruleId: 'r', rule: rule({ timeZone: 'America/New_York', count: 4 }), seriesStart: start, after: new Date(start.getTime() - 1), horizon: new Date('2026-11-10T00:00:00Z') });
    expect(rows.map((r) => r.localDate)).toEqual(['2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03']);
    expect(rows.map((r) => localParts(r.dueAt, 'America/New_York').hour)).toEqual([0, 0, 0, 0]);
  });
  it('never generates monthly dates before the series starts', () => {
    const rows = generateOccurrences({ ruleId: 'r', rule: rule({ freq: 'MONTHLY', byMonthDay: 1, count: 2 }), seriesStart: new Date('2026-09-15T09:00:00Z'), after: new Date('2026-09-01T00:00:00Z'), horizon: new Date('2027-01-01T00:00:00Z') });
    expect(rows.map((r) => r.localDate)).toEqual(['2026-10-01', '2026-11-01']);
  });
  it('does not stop an ongoing daily series after an arbitrary 5000-day loop limit', () => {
    const rows = generateOccurrences({ ruleId: 'r', rule: rule(), seriesStart: new Date('2000-01-01T09:00:00Z'), after: new Date('2026-09-08T10:00:00Z'), horizon: new Date('2026-09-10T10:00:00Z') });
    expect(rows.map((r) => r.localDate)).toEqual(['2026-09-09', '2026-09-10']);
  });
});
it('counts the explicit first instant once, retaining seconds and milliseconds', () => {
 const start = new Date('2026-09-09T09:00:30.125Z');
 const rows = generateOccurrences({ ruleId: 'r', rule: rule({ count: 2 }), seriesStart: start, after: new Date(start.getTime() - 1), horizon: new Date('2026-09-20T00:00:00Z') });
 expect(rows.map((r) => r.dueAt.toISOString())).toEqual(['2026-09-09T09:00:30.125Z', '2026-09-10T09:00:30.125Z']);
});
