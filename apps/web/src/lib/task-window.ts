/**
 * Window computation for large task lists (PRD §6.9: virtualization above
 * 200 rows). Pure and deterministic so the math is unit-testable; the React
 * layer feeds it measured row heights and the list's viewport position.
 */

/** Lists at or below this many loaded rows render every row (current behavior). */
export const VIRTUALIZATION_THRESHOLD = 200;
/** Rows rendered beyond the visible window on each side. */
export const VIRTUALIZATION_OVERSCAN = 12;
/** Height assumed for rows that have not been measured yet. */
export const ESTIMATED_ROW_HEIGHT = 80;

export interface TaskWindowInput {
  /** Total number of loaded rows, in display order. */
  total: number;
  /** Measured (or estimated) height per row index. Missing entries use the estimate. */
  heights: ReadonlyArray<number | undefined>;
  /** Distance from the top of the list to the top of the viewport (negative = viewport starts below the list top). */
  viewportTop: number;
  viewportHeight: number;
  /** Row that currently holds keyboard focus (index), if any. It stays rendered. */
  focusedIndex?: number | null;
  overscan?: number;
}

export interface TaskWindow {
  /** First fully rendered row index (inclusive). */
  start: number;
  /** Last fully rendered row index (exclusive). */
  end: number;
  /** Sum of all row heights — the list's stable scroll height. */
  totalHeight: number;
  virtualized: boolean;
}

export function computeTaskWindow(input: TaskWindowInput): TaskWindow {
  const { total } = input;
  if (total === 0) return { start: 0, end: 0, totalHeight: 0, virtualized: false };
  if (total <= VIRTUALIZATION_THRESHOLD) {
    return { start: 0, end: total, totalHeight: prefixTotal(input.heights, total), virtualized: false };
  }

  const overscan = input.overscan ?? VIRTUALIZATION_OVERSCAN;
  const prefix = prefixSums(input.heights, total);
  const top = Math.max(0, input.viewportTop);
  const bottom = input.viewportTop + input.viewportHeight;

  let start = Math.max(0, firstRowAt(prefix, top) - overscan);
  let end = Math.min(total, lastRowAt(prefix, bottom) + 1 + overscan);
  if (end < start + 1) end = start + 1;

  // Keyboard focus wins: a focused row must never be culled out from under the user.
  const focused = input.focusedIndex;
  if (focused !== null && focused !== undefined && focused >= 0 && focused < total) {
    start = Math.min(start, Math.max(0, focused - overscan));
    end = Math.max(end, Math.min(total, focused + 1 + overscan));
  }

  return { start, end, totalHeight: prefix[total]!, virtualized: true };
}

function heightAt(heights: ReadonlyArray<number | undefined>, index: number): number {
  const h = heights[index];
  return typeof h === 'number' && h > 0 ? h : ESTIMATED_ROW_HEIGHT;
}

function prefixSums(heights: ReadonlyArray<number | undefined>, total: number): Float64Array {
  const prefix = new Float64Array(total + 1);
  for (let i = 0; i < total; i += 1) prefix[i + 1] = prefix[i]! + heightAt(heights, i);
  return prefix;
}

function prefixTotal(heights: ReadonlyArray<number | undefined>, total: number): number {
  let sum = 0;
  for (let i = 0; i < total; i += 1) sum += heightAt(heights, i);
  return sum;
}

/** Smallest row index whose bottom edge is below `value`, clamped to the last row. */
function firstRowAt(prefix: Float64Array, value: number): number {
  const total = prefix.length - 1;
  let lo = 0;
  let hi = total;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (prefix[mid + 1]! > value) hi = mid;
    else lo = mid + 1;
  }
  return Math.min(Math.max(lo, 0), total - 1);
}

/** Largest row index whose top edge is above `value`, clamped to the first row. */
function lastRowAt(prefix: Float64Array, value: number): number {
  const total = prefix.length - 1;
  let lo = 0;
  let hi = total;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (prefix[mid]! < value) lo = mid;
    else hi = mid - 1;
  }
  return Math.min(Math.max(lo, 0), total - 1);
}
