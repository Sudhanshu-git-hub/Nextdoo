import { describe, expect, it } from 'vitest';
import { ESTIMATED_ROW_HEIGHT, VIRTUALIZATION_OVERSCAN, VIRTUALIZATION_THRESHOLD, computeTaskWindow } from './task-window';

const uniform = (rows: number, height = 80) => Array.from({ length: rows }, () => height);

describe('computeTaskWindow', () => {
  it('renders everything for lists at or below the 200 row threshold', () => {
    for (const total of [0, 1, 50, VIRTUALIZATION_THRESHOLD]) {
      const window = computeTaskWindow({ total, heights: uniform(total), viewportTop: 0, viewportHeight: 800 });
      expect(window).toMatchObject({ start: 0, end: total, virtualized: false });
    }
    const empty = computeTaskWindow({ total: 0, heights: [], viewportTop: 0, viewportHeight: 800 });
    expect(empty.totalHeight).toBe(0);
  });

  it('bounds the rendered window at the top of a large list', () => {
    const window = computeTaskWindow({ total: 250, heights: uniform(250, 80), viewportTop: 0, viewportHeight: 800 });
    expect(window.virtualized).toBe(true);
    expect(window.totalHeight).toBe(250 * 80);
    expect(window.start).toBe(0);
    // 10 visible rows plus overscan on the bottom side only.
    expect(window.end).toBe(10 + VIRTUALIZATION_OVERSCAN);
    expect(window.end - window.start).toBeLessThan(250 / 3);
  });

  it('centers the window mid-list and reaches the exact last row at the bottom', () => {
    const total = 250;
    const heights = uniform(total, 80);
    const totalHeight = total * 80;

    const middle = computeTaskWindow({ total, heights, viewportTop: 8000, viewportHeight: 800 });
    expect(middle.start).toBeGreaterThan(0);
    expect(middle.end).toBeLessThan(total);
    expect(middle.start).toBe(Math.max(0, Math.floor(8000 / 80) - VIRTUALIZATION_OVERSCAN));
    expect(middle.end).toBe(Math.min(total, Math.floor((8000 + 800) / 80) + VIRTUALIZATION_OVERSCAN));

    const bottom = computeTaskWindow({ total, heights, viewportTop: totalHeight, viewportHeight: 800 });
    expect(bottom.end).toBe(total);
    expect(bottom.start).toBeLessThan(total);
    expect(bottom.start).toBeGreaterThanOrEqual(0);
  });

  it('honours measured variable heights and falls back to the estimate', () => {
    const total = 250;
    const heights: (number | undefined)[] = uniform(total, 80);
    heights[0] = 200; // a row with recurrence link and error banner
    const window = computeTaskWindow({ total, heights, viewportTop: 0, viewportHeight: 800 });
    // Rows 0-7 fill 760px; row 8 (top at 760) is partially visible to 800px;
    // overscan adds 12 more.
    expect(window.start).toBe(0);
    expect(window.end).toBe(9 + VIRTUALIZATION_OVERSCAN);
    expect(window.totalHeight).toBe(200 + (total - 1) * 80);

    const estimated = computeTaskWindow({ total, heights: [], viewportTop: 0, viewportHeight: 800 });
    expect(estimated.totalHeight).toBe(total * ESTIMATED_ROW_HEIGHT);
  });

  it('keeps a keyboard-focused row rendered even when it is off-viewport', () => {
    const total = 250;
    const heights = uniform(total, 80);
    const scrolled = computeTaskWindow({ total, heights, viewportTop: 8000, viewportHeight: 800, focusedIndex: 0 });
    // The window is the union of the scroll window and the focused row's window.
    expect(scrolled.start).toBe(0);
    expect(scrolled.end).toBe(Math.floor((8000 + 800) / 80) + VIRTUALIZATION_OVERSCAN);

    const focusedFar = computeTaskWindow({ total, heights, viewportTop: 0, viewportHeight: 800, focusedIndex: 249 });
    expect(focusedFar.start).toBe(0);
    expect(focusedFar.end).toBe(total);

    const ignored = computeTaskWindow({ total, heights, viewportTop: 0, viewportHeight: 800, focusedIndex: 5000 });
    expect(ignored.end - ignored.start).toBeLessThan(60);
  });

  it('stays within bounds when the viewport misses the list entirely', () => {
    const total = 250;
    const heights = uniform(total, 80);
    const below = computeTaskWindow({ total, heights, viewportTop: -1000, viewportHeight: 800 });
    expect(below.start).toBe(0);
    expect(below.end).toBeLessThanOrEqual(1 + VIRTUALIZATION_OVERSCAN);

    const far = computeTaskWindow({ total, heights, viewportTop: 1_000_000, viewportHeight: 800 });
    expect(far.end).toBe(total);
    expect(far.start).toBeGreaterThanOrEqual(total - 1 - VIRTUALIZATION_OVERSCAN);
  });

  it('supports a custom overscan and never inverts the range', () => {
    const total = 250;
    const window = computeTaskWindow({ total, heights: uniform(total, 80), viewportTop: 0, viewportHeight: 10, overscan: 0 });
    expect(window.start).toBe(0);
    expect(window.end).toBe(1);
    expect(window.end).toBeGreaterThanOrEqual(window.start + 1);
  });
});
