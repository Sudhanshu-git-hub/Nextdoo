/**
 * Provider-aware daily capacity planning (PRD §5.2, §8.3).
 *
 * The PRD rule this module enforces (§5.2): "The system must not claim a
 * schedule is feasible unless it has enough information to calculate
 * capacity." Capacity is therefore only reported when it is fully known:
 *
 *  - no active provider (calendar) connections → capacity is the configured
 *    workday window (known from workspace settings);
 *  - active connections whose event data has been synced through the whole
 *    day → capacity is the workday window minus provider busy time;
 *  - an active connection that has not synced through the day → capacity is
 *    UNKNOWN and no feasibility/overload claim is made (PRD §8.6 degraded
 *    state: "Calendar sync delayed").
 *
 * The function is pure and timezone-free: the caller converts the requested
 * day and provider events into UTC millisecond bounds in the workspace
 * time zone before calling.
 */

export type DayCapacityStatus = 'OK' | 'OVERLOADED' | 'CAPACITY_UNKNOWN';

export interface BusyInterval {
  /** UTC ms, inclusive. */
  startMs: number;
  /** UTC ms, exclusive. */
  endMs: number;
}

export interface DayCapacityInput {
  /** 0..1439, start of the configured workday. */
  workdayStartMinute: number;
  /** 0..1439, end of the configured workday (earlier end means next day). */
  workdayEndMinute: number;
  /** UTC ms of local midnight of the planned day in the workspace zone. */
  dayStartUtcMs: number;
  /** Sum of estimates of the ACTIVE tasks due on the planned day, minutes. */
  workloadMinutes: number;
  /** True only when available capacity is fully determined (see file note). */
  capacityKnown: boolean;
  /** Provider busy intervals in UTC; meaningful only when capacityKnown. */
  busyIntervals: BusyInterval[];
}

export interface DayCapacityResult {
  /** Configured workday length in minutes (overnight-aware). */
  workdayMinutes: number;
  workloadMinutes: number;
  /** Null while capacity is unknown. */
  busyMinutes: number | null;
  /** Null while capacity is unknown. */
  capacityMinutes: number | null;
  /** Positive minutes when overloaded, else 0; null while capacity is unknown. */
  overByMinutes: number | null;
  status: DayCapacityStatus;
}

const MINUTE_MS = 60_000;

function assertMinute(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 1439) {
    throw new Error(`${name} must be an integer minute between 0 and 1439`);
  }
}

/**
 * Plans one day. An exact fit (workload == capacity) is OK: the PRD warns
 * about work planned *beyond* available time, not about using all of it.
 */
export function planDayCapacity(input: DayCapacityInput): DayCapacityResult {
  const { workdayStartMinute, workdayEndMinute, dayStartUtcMs, workloadMinutes, capacityKnown, busyIntervals } = input;
  assertMinute(workdayStartMinute, 'workdayStartMinute');
  assertMinute(workdayEndMinute, 'workdayEndMinute');
  if (workdayStartMinute === workdayEndMinute) throw new Error('workday start and end must differ');
  if (!Number.isFinite(dayStartUtcMs)) throw new Error('dayStartUtcMs must be finite');
  if (!Number.isFinite(workloadMinutes) || workloadMinutes < 0) throw new Error('workloadMinutes must be a non-negative number');

  const windowMinutes = (workdayEndMinute - workdayStartMinute + 1440) % 1440;
  const windowStart = dayStartUtcMs + workdayStartMinute * MINUTE_MS;
  const windowEnd = windowStart + windowMinutes * MINUTE_MS;

  if (!capacityKnown) {
    return {
      workdayMinutes: windowMinutes,
      workloadMinutes,
      busyMinutes: null,
      capacityMinutes: null,
      overByMinutes: null,
      status: 'CAPACITY_UNKNOWN',
    };
  }

  // Clip busy intervals to the workday window, then merge overlaps.
  const clipped: Array<[number, number]> = [];
  for (const interval of busyIntervals) {
    const start = Math.max(windowStart, interval.startMs);
    const end = Math.min(windowEnd, interval.endMs);
    if (end > start) clipped.push([start, end]);
  }
  clipped.sort((a, b) => a[0] - b[0]);

  let busyMs = 0;
  let cursor = Number.NEGATIVE_INFINITY;
  for (const [start, end] of clipped) {
    if (start > cursor) {
      busyMs += end - start;
      cursor = end;
    } else if (end > cursor) {
      busyMs += end - cursor;
      cursor = end;
    }
  }

  // Round busy time up: a fractional minute of provider time may never be
  // presented as free capacity (PRD §5.2: no feasibility claim without the
  // information to calculate it).
  const busyMinutes = Math.ceil(busyMs / MINUTE_MS);
  const capacityMinutes = windowMinutes - busyMinutes;
  const over = workloadMinutes - capacityMinutes;
  return {
    workdayMinutes: windowMinutes,
    workloadMinutes,
    busyMinutes,
    capacityMinutes,
    overByMinutes: over > 0 ? over : 0,
    status: over > 0 ? 'OVERLOADED' : 'OK',
  };
}
