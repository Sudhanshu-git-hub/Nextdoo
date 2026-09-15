import { expect, it } from 'vitest';
import { formatTrackedDuration as format } from './format-duration';
it('formats whole and sub-minute tracked durations without decimal tails', () => {
 expect(format(0)).toBe('0m'); expect(format(0.5)).toBe('0m 30s');
 expect(format(1 / 60)).toBe('0m 1s'); expect(format(61 + 59 / 60)).toBe('1h 1m 59s');
 expect(format(60)).toBe('1h 0m'); expect(format(-1)).toBe('0m');
});
