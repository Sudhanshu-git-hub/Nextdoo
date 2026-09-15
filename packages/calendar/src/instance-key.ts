import { CALENDAR_INSTANCE_KEY_SEPARATOR } from '@nextdoo/contracts';

/**
 * Per-occurrence identity for expanded recurring events (M7-i2; PRD §16.3).
 *
 * Google's `events.list?singleEvents=true` returns every occurrence of a
 * recurring series under the shared series `id`. The normalized shape
 * carries no recurrence field, so each occurrence must be a distinct
 * event row — the identity is derived from the fields Google already
 * supplies per item:
 *
 *   `<recurringEventId><SEP><originalStartTime>`
 *
 * `originalStartTime` is the occurrence's original slot: it stays put when
 * the occurrence is rescheduled (`start`/`end` move, the key does not), so
 * updates to one occurrence keep landing on the same row while sibling
 * occurrences are untouched. Items without `recurringEventId` /
 * `originalStartTime` (non-recurring events, and series-level items such as
 * a cancelled whole series) keep their bare `id`.
 *
 * The separator is the whole-series deletion convention: deleting the bare
 * series id removes every key with the `<seriesId><SEP>` prefix and
 * nothing else (see CALENDAR_INSTANCE_KEY_SEPARATOR in @nextdoo/contracts).
 */
export interface RecurringItemLike {
  id?: string;
  recurringEventId?: string;
  originalStartTime?: { dateTime?: string; date?: string } | null;
}

/** Deterministic per-occurrence external id (see module docs). */
export function deriveExternalId(item: RecurringItemLike): string {
  const id = item.id;
  if (!id) throw new Error('Calendar item has no id.');
  const recurringEventId = item.recurringEventId;
  const original = item.originalStartTime?.dateTime ?? item.originalStartTime?.date;
  if (recurringEventId && original) {
    return `${recurringEventId}${CALENDAR_INSTANCE_KEY_SEPARATOR}${original}`;
  }
  return id;
}
