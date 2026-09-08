import { randomUUID } from 'node:crypto';

/**
 * UUIDv7-style identifiers: a 48-bit big-endian timestamp prefix followed by
 * randomness. Time-ordered ids keep B-tree index inserts sequential, which
 * matters for the high-volume tracking_events table.
 */
export function newId(): string {
  const now = Date.now();
  const timeHex = now.toString(16).padStart(12, '0');
  const rand = randomUUID().replaceAll('-', '');
  const hex =
    timeHex +
    '7' + rand.slice(13, 16) +
    ((parseInt(rand.slice(16, 17), 16) & 0x3 | 0x8).toString(16)) + rand.slice(17, 20) +
    rand.slice(20, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
