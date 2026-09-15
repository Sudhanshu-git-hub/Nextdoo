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

/** Calendar arithmetic must not turn years 0..99 into 1900..1999. */
function calendarTime(y: number, m: number, d: number, hh = 0, mm = 0): number {
  const date = new Date(0); date.setUTCFullYear(y, m - 1, d); date.setUTCHours(hh, mm, 0, 0); return date.getTime();
}
/** Compatible DST policy: earlier instant in folds; shift forward by the gap. */
export function zonedTimeToUtc(y: number, m: number, d: number, hh: number, mm: number, timeZone: string): Date {
  const target = calendarTime(y, m, Math.min(d, daysInMonth(y, m)), hh, mm);
  const offsets = new Set<number>();
  for (const delta of [-48, -24, 0, 24, 48]) {
    const instant = target + delta * 3600000, p = localParts(new Date(instant), timeZone);
    offsets.add(calendarTime(p.year, p.month, p.day, p.hour, p.minute) - instant);
  }
  const candidates = [...offsets].map((offset) => {
    const instant = target - offset, p = localParts(new Date(instant), timeZone);
    return { instant, wall: calendarTime(p.year, p.month, p.day, p.hour, p.minute) };
  }).sort((a, b) => a.instant - b.instant);
  const exact = candidates.find((c) => c.wall === target);
  if (exact) return new Date(exact.instant);
  const later = candidates.filter((c) => c.wall > target).sort((a, b) => a.wall - b.wall)[0];
  if (!later) throw new RangeError('Could not resolve local recurrence time');
  return new Date(later.instant);
}

export function daysInMonth(year: number, month1: number): number {
  return new Date(calendarTime(year, month1 + 1, 0)).getUTCDate();
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
  const cap = Math.max(0, Math.min(opts.maxCount ?? 50, 50));
  if (!cap || horizon < seriesStart) return [];
  const tz = rule.timeZone, anchor = localParts(seriesStart, tz);
  const firstDay = calendarTime(anchor.year, anchor.month, anchor.day);
  const end = localParts(horizon, tz), afterLocal = localParts(after, tz);
  const lastDay = calendarTime(end.year, end.month, end.day) + DAY_MS;
  const scanFrom = calendarTime(afterLocal.year, afterLocal.month, afterLocal.day) - 2 * DAY_MS;
  const until = rule.until ? new Date(rule.until).getTime() : Infinity;
  const output: Occurrence[] = []; let ordinal = 0;
  for (let day = firstDay, offset = 0; day <= lastDay; day += DAY_MS, offset++) {
    const date = new Date(day), year = date.getUTCFullYear(), month = date.getUTCMonth() + 1, dom = date.getUTCDate();
    const months = (year - anchor.year) * 12 + month - anchor.month;
    const matches = rule.freq === 'DAILY' ? offset % rule.interval === 0
      : rule.freq === 'WEEKLY' ? Math.floor((offset + anchor.weekday) / 7) % rule.interval === 0 && (rule.byWeekday ?? [anchor.weekday]).includes(date.getUTCDay())
      : months % rule.interval === 0 && dom === Math.min(rule.byMonthDay ?? anchor.day, daysInMonth(year, month));
    if (!matches) continue;
    ordinal++;
    if (rule.count && ordinal > rule.count) break;
    // Count the entire segment, but avoid expensive zone conversion for old history.
    if (day < scanFrom) continue;
    const dueAt = day === firstDay ? new Date(seriesStart) : new Date(zonedTimeToUtc(year, month, dom, anchor.hour, anchor.minute, tz).getTime() + anchor.second * 1000 + seriesStart.getUTCMilliseconds());
    if (dueAt < seriesStart) { ordinal--; continue; }
    if (dueAt.getTime() > until || dueAt > horizon) break;
    if (dueAt <= after) continue;
    const localDate = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(dom).padStart(2, '0')}`;
    const occurrenceKey = `${ruleId}:${localDate}`;
    if (!opts.existingKeys?.has(occurrenceKey)) output.push({ occurrenceKey, localDate, dueAt });
    if (output.length >= cap) break;
  }
  return output;
}
