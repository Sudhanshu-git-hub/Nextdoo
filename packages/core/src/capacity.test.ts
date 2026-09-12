import { describe, expect, it } from 'vitest';
import { planDayCapacity, type DayCapacityInput } from './capacity';

const DAY_START = Date.UTC(2026, 8, 10); // local midnight of the planned day (UTC zone here)
const MIN = 60_000;

function input(overrides: Partial<DayCapacityInput> = {}): DayCapacityInput {
  return {
    workdayStartMinute: 540, // 09:00
    workdayEndMinute: 1020, // 17:00
    dayStartUtcMs: DAY_START,
    workloadMinutes: 0,
    capacityKnown: true,
    busyIntervals: [],
    ...overrides,
  };
}

describe('planDayCapacity', () => {
  it('reports the configured workday as capacity when nothing is busy', () => {
    const r = planDayCapacity(input({ workloadMinutes: 240 }));
    expect(r.workdayMinutes).toBe(480);
    expect(r.busyMinutes).toBe(0);
    expect(r.capacityMinutes).toBe(480);
    expect(r.overByMinutes).toBe(0);
    expect(r.status).toBe('OK');
  });

  it('treats an exact fit as OK, not overloaded', () => {
    expect(planDayCapacity(input({ workloadMinutes: 480 })).status).toBe('OK');
    expect(planDayCapacity(input({ workloadMinutes: 481 })).status).toBe('OVERLOADED');
    expect(planDayCapacity(input({ workloadMinutes: 481 })).overByMinutes).toBe(1);
  });

  it('handles an overnight workday across UTC midnight', () => {
    const r = planDayCapacity(
      input({
        workdayStartMinute: 1320, // 22:00
        workdayEndMinute: 360, // 06:00 next day
        busyIntervals: [{ startMs: DAY_START + 1440 * MIN, endMs: DAY_START + 1560 * MIN }], // next day 00:00-02:00
      }),
    );
    expect(r.workdayMinutes).toBe(480);
    expect(r.busyMinutes).toBe(120);
    expect(r.capacityMinutes).toBe(360);
  });

  it('never claims capacity while provider data is unknown', () => {
    const r = planDayCapacity(input({ capacityKnown: false, workloadMinutes: 10_000, busyIntervals: [{ startMs: 0, endMs: 0 }] }));
    expect(r.status).toBe('CAPACITY_UNKNOWN');
    expect(r.busyMinutes).toBeNull();
    expect(r.capacityMinutes).toBeNull();
    expect(r.overByMinutes).toBeNull();
    expect(r.workdayMinutes).toBe(480);
  });

  it('merges overlapping provider intervals and ignores out-of-window time', () => {
    const start = DAY_START + 540 * MIN; // 09:00
    const r = planDayCapacity(
      input({
        workloadMinutes: 300,
        busyIntervals: [
          { startMs: start + 1 * MIN, endMs: start + 3 * MIN }, // 09:01-09:03
          { startMs: start + 2 * MIN, endMs: start + 4 * MIN }, // overlaps → union 09:01-09:04 (3)
          { startMs: start - 6 * MIN, endMs: start + 1 * MIN }, // before the window → clipped to 1
          { startMs: start + 480 * MIN, endMs: start + 600 * MIN }, // after the window → 0
        ],
      }),
    );
    expect(r.busyMinutes).toBe(4);
    expect(r.capacityMinutes).toBe(476);
    expect(r.status).toBe('OK');
  });

  it('clips events that engulf the whole window (all-day provider events)', () => {
    const r = planDayCapacity(
      input({
        workloadMinutes: 0,
        busyIntervals: [{ startMs: DAY_START, endMs: DAY_START + 1440 * MIN }],
      }),
    );
    expect(r.busyMinutes).toBe(480);
    expect(r.capacityMinutes).toBe(0);
    expect(planDayCapacity(input({ workloadMinutes: 1, busyIntervals: [{ startMs: DAY_START, endMs: DAY_START + 1440 * MIN }] })).status).toBe('OVERLOADED');
  });

  it('ignores zero-length intervals', () => {
    expect(planDayCapacity(input({ busyIntervals: [{ startMs: DAY_START + MIN, endMs: DAY_START + MIN }] })).busyMinutes).toBe(0);
  });

  it('rounds sub-minute busy time up, never presenting partial minutes as free', () => {
    const start = DAY_START + 540 * MIN;
    const r = planDayCapacity(input({ busyIntervals: [{ startMs: start, endMs: start + 30_000 }] })); // 30 s
    expect(r.busyMinutes).toBe(1);
    const r2 = planDayCapacity(input({ busyIntervals: [{ startMs: start, endMs: start + 90_000 }] })); // 90 s
    expect(r2.busyMinutes).toBe(2);
  });

  it('rejects invalid workday configuration', () => {
    expect(() => planDayCapacity(input({ workdayStartMinute: 540, workdayEndMinute: 540 }))).toThrow();
    expect(() => planDayCapacity(input({ workdayStartMinute: -1 }))).toThrow();
    expect(() => planDayCapacity(input({ workdayEndMinute: 1440 }))).toThrow();
    expect(() => planDayCapacity(input({ workloadMinutes: -5 }))).toThrow();
  });
});
