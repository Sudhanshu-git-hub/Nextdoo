import type { RecurrenceRuleInput } from '@nextdoo/contracts';

/**
 * Recurrence generation (PRD §6.5).
 *
 * Design decision: occurrences are keyed by *local wall-clock date* in the rule's
 * time zone, not by UTC instant. This is what makes the two hard requirements work:
 *  - DST transitions preserve local time ("every day at 09:00" stays 09:00).
 *  - Re-running the generator is idempotent, because the key is stable.
 */

/** Formats an instant as YYYY-MM-DD in the given IANA zone. */
export function localDateKey(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Local wall-clock fields of an instant in a zone. */
export function localParts(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    weekday: 'short',
  }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: weekdayMap[get('weekday')] ?? 0,
  };
}

/**
 * Resolves a local wall-clock time in `timeZone` to a UTC instant.
 * Uses a two-pass offset correction, which is stable across DST boundaries.
 */
export function zonedTimeToUtc(
  y: number,
  m: number,
  d: number,
  hh: number,
  mm: number,
  timeZone: string,
): Date {
  const clampedDay = Math.min(d, daysInMonth(y, m));
  let guess = Date.UTC(y, m - 1, clampedDay, hh, mm, 0);
  for (let i = 0; i < 2; i += 1) {
    const p = localParts(new Date(guess), timeZone);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const target = Date.UTC(y, m - 1, clampedDay, hh, mm, 0);
    const drift = target - asUtc;
    if (drift === 0) break;
    guess += drift;
  }
  return new Date(guess);
}

export function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

export interface Occurrence {
  /** Stable idempotency key: `${ruleId}:${localDate}`. */
  occurrenceKey: string;
  /** UTC instant of the occurrence's due time. */
  dueAt: Date;
  localDate: string;
}

export interface GenerateOptions {
  ruleId: string;
  rule: RecurrenceRuleInput;
  /** Anchor: the first due instant of the series. */
  seriesStart: Date;
  /** Generate occurrences strictly after this instant. */
  after: Date;
  /** Do not generate past this instant (look-ahead window, PRD §6.5 failure modes). */
  horizon: Date;
  /** Hard cap to avoid unbounded generation. */
  maxCount?: number;
  /** Occurrences already generated, so re-runs stay idempotent. */
  existingKeys?: ReadonlySet<string>;
}

const DAY_MS = 86_400_000;

/**
 * Produces the next occurrences for a rule. Pure and deterministic:
 * given identical inputs it always returns identical keys.
 */
export function generateOccurrences(opts: GenerateOptions): Occurrence[] {
  const { ruleId, rule, seriesStart, after, horizon } = opts;
  const maxCount = opts.maxCount ?? 50;
  const existing = opts.existingKeys ?? new Set<string>();
  const tz = rule.timeZone;
  const out: Occurrence[] = [];

  const anchor = localParts(seriesStart, tz);
  const untilMs = rule.until ? new Date(rule.until).getTime() : Number.POSITIVE_INFINITY;
  const limitMs = Math.min(horizon.getTime(), untilMs);

  let emitted = 0;
  // `count` caps the whole series, so we must count from the series start.
  let seriesIndex = 0;

  const push = (dueAt: Date): boolean => {
    if (dueAt.getTime() <= after.getTime()) return true;
    if (dueAt.getTime() > limitMs) return false;
    const localDate = localDateKey(dueAt, tz);
    const occurrenceKey = `${ruleId}:${localDate}`;
    if (!existing.has(occurrenceKey)) {
      out.push({ occurrenceKey, dueAt, localDate });
      emitted += 1;
    }
    return emitted < maxCount;
  };

  if (rule.freq === 'DAILY') {
    for (let i = 0; ; i += 1) {
      seriesIndex += 1;
      if (rule.count && seriesIndex > rule.count) break;
      const base = new Date(seriesStart.getTime() + i * rule.interval * DAY_MS);
      const p = localParts(base, tz);
      const due = zonedTimeToUtc(p.year, p.month, p.day, anchor.hour, anchor.minute, tz);
      if (due.getTime() > limitMs) break;
      if (!push(due)) break;
      if (i > 5000) break;
    }
    return out;
  }

  if (rule.freq === 'WEEKLY') {
    const weekdays = rule.byWeekday?.length ? [...rule.byWeekday].sort((a, b) => a - b) : [anchor.weekday];
    // Walk day by day; interval counts weeks since the anchor week.
    const startOfAnchorWeek = Math.floor((seriesStart.getTime() - anchor.weekday * DAY_MS) / DAY_MS) * DAY_MS;
    for (let dayOffset = 0; dayOffset < 366 * 3; dayOffset += 1) {
      const cursor = new Date(seriesStart.getTime() + dayOffset * DAY_MS);
      if (cursor.getTime() > limitMs + DAY_MS) break;
      const p = localParts(cursor, tz);
      if (!weekdays.includes(p.weekday)) continue;
      const weeksSince = Math.floor((cursor.getTime() - startOfAnchorWeek) / (7 * DAY_MS));
      if (weeksSince % rule.interval !== 0) continue;
      seriesIndex += 1;
      if (rule.count && seriesIndex > rule.count) break;
      const due = zonedTimeToUtc(p.year, p.month, p.day, anchor.hour, anchor.minute, tz);
      if (due.getTime() > limitMs) break;
      if (!push(due)) break;
    }
    return out;
  }

  // MONTHLY
  const targetDay = rule.byMonthDay ?? anchor.day;
  for (let i = 0; i < 400; i += 1) {
    const monthsAhead = i * rule.interval;
    const y = anchor.year + Math.floor((anchor.month - 1 + monthsAhead) / 12);
    const m = ((anchor.month - 1 + monthsAhead) % 12) + 1;
    seriesIndex += 1;
    if (rule.count && seriesIndex > rule.count) break;
    // Clamp to the last day of short months (Jan 31 -> Feb 28/29).
    const due = zonedTimeToUtc(y, m, Math.min(targetDay, daysInMonth(y, m)), anchor.hour, anchor.minute, tz);
    if (due.getTime() > limitMs) break;
    if (!push(due)) break;
  }
  return out;
}
