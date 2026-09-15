import { AppError } from '@nextdoo/contracts';
const SCALE = 10n ** 10n, STEP = 1024n * SCALE, MAX = 10n ** 30n - 1n;
function units(value: string): bigint {
  if (!/^-?\d{1,20}(\.\d{1,10})?$/.test(value)) throw new AppError('VALIDATION_FAILED', 'Invalid section position.');
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = value.replace('-', '').split('.');
  return (negative ? -1n : 1n) * (BigInt(whole!) * SCALE + BigInt(fraction.padEnd(10, '0')));
}
/** Exact numeric(30,10) fractional positions, without lossy floating point math. */
export function sectionPositionBetween(left: string | null, right: string | null): string {
  const a = left === null ? null : units(left), b = right === null ? null : units(right);
  if (a !== null && b !== null && b - a <= 1n) throw new AppError('RESOURCE_VERSION_CONFLICT', 'Section positions are too close. Refresh and choose another position.');
  const value = a === null ? (b === null ? 0n : b - STEP) : b === null ? a + STEP : a + (b - a) / 2n;
  if (value < -MAX || value > MAX) throw new AppError('VALIDATION_FAILED', 'Section position limit reached.');
  const n = value < 0n ? -value : value;
  return `${value < 0n ? '-' : ''}${n / SCALE}.${String(n % SCALE).padStart(10, '0')}`;
}
