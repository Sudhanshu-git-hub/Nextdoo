import { and, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import { AppError } from '@nextdoo/contracts';
import { planDayCapacity, zonedTimeToUtc, type DayCapacityResult } from '@nextdoo/core';
import { tasks } from '@nextdoo/db';
import { getDb } from '../db';
import { loadWorkspaceSettings } from './workspaces';
import { busyIntervalsForDay, capacityConnectionState } from './calendar-connections';

/**
 * Daily capacity planning (PRD §5.2, §8.3) — the server-side source of truth
 * for the Today view's "estimated workload, available work capacity,
 * overload warning".
 *
 * The workload is summed over the FULL collection (not the loaded pages), and
 * capacity is reported only when it is fully known: no active provider
 * connections, or all of them synced through the whole day. Otherwise the
 * result is CAPACITY_UNKNOWN and the UI must not claim feasibility (PRD §5.2).
 */

export interface DayCapacity {
  date: string;
  timeZone: string;
  workdayStartMinute: number;
  workdayEndMinute: number;
  providerConnected: boolean;
  /** Set while every active connection has synced; null while any is behind. */
  providerSyncedThrough: string | null;
  workdayMinutes: number;
  workloadMinutes: number;
  busyMinutes: number | null;
  capacityMinutes: number | null;
  overByMinutes: number | null;
  status: DayCapacityResult['status'];
}

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** Parses and validates a YYYY-MM-DD key; throws VALIDATION_FAILED otherwise. */
export function parseDateKey(raw: string): { year: number; month: number; day: number } {
  if (!DATE_KEY.test(raw)) throw new AppError('VALIDATION_FAILED', 'date must be YYYY-MM-DD.');
  const [year, month, day] = raw.split('-').map(Number) as [number, number, number];
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new AppError('VALIDATION_FAILED', 'date is not a real calendar date.');
  }
  return { year, month, day };
}

/** Local midnight of the given day in the workspace zone (UTC instant). */
function dayStartUtc(year: number, month: number, day: number, timeZone: string): Date {
  return zonedTimeToUtc(year, month, day, 0, 0, timeZone);
}

export async function getDayCapacity(userId: string, workspaceId: string, dateKey: string): Promise<DayCapacity> {
  const { year, month, day } = parseDateKey(dateKey);
  const workspace = await loadWorkspaceSettings(workspaceId, workspaceId);

  const start = dayStartUtc(year, month, day, workspace.timeZone);
  const next = new Date(start.getTime());
  next.setUTCDate(next.getUTCDate() + 1);
  const endExclusive = dayStartUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), workspace.timeZone);
  const dayEndInclusive = new Date(endExclusive.getTime() - 1);

  // Full-collection workload: ACTIVE, not-deleted tasks due on this day.
  const [workloadRow] = await getDb()
    .select({ total: sql<number>`coalesce(sum(${tasks.estimateMinutes}), 0)` })
    .from(tasks)
    .where(
      and(
        eq(tasks.workspaceId, workspaceId),
        eq(tasks.status, 'ACTIVE'),
        isNull(tasks.deletedAt),
        gte(tasks.dueAt, start),
        lt(tasks.dueAt, endExclusive),
      ),
    );

  const state = await capacityConnectionState(userId, workspaceId);
  const capacityKnown = !state.connected || state.syncedThrough !== null && state.syncedThrough >= dayEndInclusive;
  const busyIntervals = capacityKnown ? await busyIntervalsForDay(userId, workspaceId, start, dayEndInclusive) : [];

  const result = planDayCapacity({
    workdayStartMinute: workspace.workdayStartMinute,
    workdayEndMinute: workspace.workdayEndMinute,
    dayStartUtcMs: start.getTime(),
    workloadMinutes: Number(workloadRow?.total ?? 0),
    capacityKnown,
    busyIntervals,
  });

  return {
    date: dateKey,
    timeZone: workspace.timeZone,
    workdayStartMinute: workspace.workdayStartMinute,
    workdayEndMinute: workspace.workdayEndMinute,
    providerConnected: state.connected,
    providerSyncedThrough: state.syncedThrough ? state.syncedThrough.toISOString() : null,
    ...result,
  };
}
