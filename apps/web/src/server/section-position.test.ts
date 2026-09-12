import { expect, it } from 'vitest';
import { sectionPositionBetween as between } from './section-position';
it('uses exact decimal midpoints including negatives and values above JS integer precision', () => {
 expect(between(null, null)).toBe('0.0000000000');
 expect(between(null, '0')).toBe('-1024.0000000000');
 expect(between('0', null)).toBe('1024.0000000000');
 expect(between('-1', '0')).toBe('-0.5000000000');
 expect(between('9007199254740993', '9007199254740994')).toBe('9007199254740993.5000000000');
});
it('rejects invalid, exhausted or overflowing positions instead of silently rounding/reordering', () => {
 expect(() => between('0.0000000000', '0.0000000001')).toThrow(/too close/);
 expect(() => between('1', '0')).toThrow(/too close/);
 expect(() => between('NaN', null)).toThrow(/Invalid/);
 expect(() => between('0.00000000001', null)).toThrow(/Invalid/);
 expect(() => between(null, '-99999999999999999999.9999999999')).toThrow(/limit/);
 expect(() => between('99999999999999999999.9999999999', null)).toThrow(/limit/);
});
