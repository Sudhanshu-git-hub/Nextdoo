import type { TaskPriority } from '@nextdoo/contracts';
import { localParts, zonedTimeToUtc } from './recurrence';

/**
 * Deterministic natural-language capture (PRD §6.10, §17.1).
 *
 * This is the *default* path — no model call, no network, works offline, and is
 * reproducible in tests. The LLM path is an opt-in fallback for text this fails to
 * parse, and must return the same shape.
 *
 * Every extracted field carries a confidence. When any consumed field is below the
 * confirmation threshold, `requiresConfirmation` is set and the UI must ask before saving.
 */

export const CONFIRMATION_THRESHOLD = 0.8;

export interface ParsedField<T> {
  value: T;
  confidence: number;
  /** The exact source substring, so the UI can highlight what it consumed. */
  source: string;
}

export interface ParseResult {
  title: string;
  dueAt: ParsedField<string> | null;
  estimateMinutes: ParsedField<number> | null;
  priority: ParsedField<TaskPriority> | null;
  tags: ParsedField<string[]> | null;
  project: ParsedField<string> | null;
  recurrence: ParsedField<{ freq: 'DAILY' | 'WEEKLY' | 'MONTHLY'; interval: number; byWeekday?: number[] }> | null;
  requiresConfirmation: boolean;
  /** Preserved verbatim for correction and debugging (PRD §6.10). */
  originalText: string;
}

interface Span {
  start: number;
  end: number;
}

const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

const MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
  september: 9, sep: 9, sept: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
};

function parseClock(raw: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(raw.trim());
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const mer = m[3]?.toLowerCase();
  if (hour > 23 || minute > 59) return null;
  if (mer === 'pm' && hour < 12) hour += 12;
  if (mer === 'am' && hour === 12) hour = 0;
  return { hour, minute };
}

/** Adds whole days to a wall-clock date in a zone, returning local Y/M/D. */
function addLocalDays(now: Date, timeZone: string, days: number) {
  const p = localParts(new Date(now.getTime() + days * 86_400_000), timeZone);
  return { year: p.year, month: p.month, day: p.day };
}

/**
 * Reads a capture group that the pattern guarantees will be present.
 * `noUncheckedIndexedAccess` cannot see that guarantee, and littering the parser
 * with `!` would hide the cases where a group really is optional.
 */
function group(match: RegExpMatchArray | RegExpExecArray, index: number): string {
  return match[index] ?? '';
}

export function parseTaskText(text: string, timeZone = 'UTC', nowInput?: Date): ParseResult {
  const now = nowInput ?? new Date();
  const original = text;
  const consumed: Span[] = [];
  const claim = (start: number, end: number) => consumed.push({ start, end });

  let dueAt: ParseResult['dueAt'] = null;
  let estimate: ParseResult['estimateMinutes'] = null;
  let priority: ParseResult['priority'] = null;
  let project: ParseResult['project'] = null;
  let recurrence: ParseResult['recurrence'] = null;
  const tagValues: string[] = [];
  let tagSpanSource = '';

  // ---- tags: #tag
  for (const m of text.matchAll(/(^|\s)#([\p{L}\p{N}_-]{1,60})/gu)) {
    const idx = (m.index ?? 0) + group(m, 1).length;
    const tag = group(m, 2);
    tagValues.push(tag.toLowerCase());
    tagSpanSource += (tagSpanSource ? ' ' : '') + `#${tag}`;
    claim(idx, idx + group(m, 0).length - group(m, 1).length);
  }

  // ---- project: +project or "for <Project>" is too ambiguous, so only the sigil form
  const projMatch = /(^|\s)\+([\p{L}\p{N}_-]{1,60})/u.exec(text);
  if (projMatch) {
    const idx = projMatch.index + group(projMatch, 1).length;
    const name = group(projMatch, 2);
    project = { value: name, confidence: 0.95, source: `+${name}` };
    claim(idx, idx + group(projMatch, 0).length - group(projMatch, 1).length);
  }

  // ---- priority: !p1..!p4 or the words high/medium/low priority
  const pri = /(^|\s)!(p[1-4]|high|med|medium|low)\b/i.exec(text);
  if (pri) {
    const token = group(pri, 2).toLowerCase();
    const map: Record<string, TaskPriority> = {
      p1: 'HIGH', high: 'HIGH', p2: 'MEDIUM', med: 'MEDIUM', medium: 'MEDIUM',
      p3: 'LOW', low: 'LOW', p4: 'NONE',
    };
    priority = { value: map[token] ?? 'NONE', confidence: 0.95, source: `!${group(pri, 2)}` };
    claim(pri.index + group(pri, 1).length, pri.index + group(pri, 0).length);
  } else {
    const words = /(^|\s)(high|low)\s+priority\b/i.exec(text);
    if (words) {
      priority = {
        value: group(words, 2).toLowerCase() === 'high' ? 'HIGH' : 'LOW',
        confidence: 0.85,
        source: group(words, 0).trim(),
      };
      claim(words.index + group(words, 1).length, words.index + group(words, 0).length);
    }
  }

  // ---- duration: "for 90 minutes", "90m", "1.5h", "2 hours"
  const durRe = /(^|\s)(?:for\s+)?(\d+(?:\.\d+)?)\s*(minutes?|mins?|m|hours?|hrs?|h)\b/gi;
  for (const m of text.matchAll(durRe)) {
    const qty = Number(group(m, 2));
    const unit = group(m, 3).toLowerCase();
    const isHour = unit.startsWith('h');
    // Bare "m"/"h" is less certain than a spelled-out unit.
    const explicit = unit.length > 1;
    const minutes = Math.round(isHour ? qty * 60 : qty);
    if (minutes <= 0 || minutes > 60 * 24 * 31) continue;
    const startsWithFor = /^\s*for\s/i.test(group(m, 0));
    estimate = {
      value: minutes,
      confidence: startsWithFor ? 0.95 : explicit ? 0.85 : 0.7,
      source: group(m, 0).trim(),
    };
    claim((m.index ?? 0) + group(m, 1).length, (m.index ?? 0) + group(m, 0).length);
    break;
  }

  // ---- recurrence: "every day", "every 2 weeks", "every monday"
  const recRe = /(^|\s)every\s+(?:(\d+)\s+)?(day|days|week|weeks|month|months|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)\b/i;
  const rec = recRe.exec(text);
  if (rec) {
    const interval = rec[2] ? Number(rec[2]) : 1;
    const unit = group(rec, 3).toLowerCase();
    if (unit.startsWith('day')) {
      recurrence = { value: { freq: 'DAILY', interval }, confidence: 0.93, source: group(rec, 0).trim() };
    } else if (unit.startsWith('week')) {
      recurrence = { value: { freq: 'WEEKLY', interval }, confidence: 0.93, source: group(rec, 0).trim() };
    } else if (unit.startsWith('month')) {
      recurrence = { value: { freq: 'MONTHLY', interval }, confidence: 0.93, source: group(rec, 0).trim() };
    } else if (unit in WEEKDAYS) {
      recurrence = {
        value: { freq: 'WEEKLY', interval, byWeekday: [WEEKDAYS[unit] ?? 0] },
        confidence: 0.9,
        source: group(rec, 0).trim(),
      };
    }
    if (recurrence) claim(rec.index + group(rec, 1).length, rec.index + group(rec, 0).length);
  }

  // ---- explicit time: "at 2pm", "at 14:30"
  let clock: { hour: number; minute: number } | null = null;
  let clockConfidence = 0;
  const timeRe = /(^|\s)(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)|\d{1,2}:\d{2})\b/i;
  const tm = timeRe.exec(text);
  if (tm) {
    const parsed = parseClock(group(tm, 2));
    if (parsed) {
      clock = parsed;
      clockConfidence = /^\s*at\s/i.test(group(tm, 0)) ? 0.96 : 0.82;
      claim(tm.index + group(tm, 1).length, tm.index + group(tm, 0).length);
    }
  }

  // ---- date phrases
  let dateParts: { year: number; month: number; day: number } | null = null;
  let dateConfidence = 0;
  let dateSource = '';

  const todayRe = /(^|\s)(today|tonight)\b/i.exec(text);
  const tomorrowRe = /(^|\s)(tomorrow|tmr|tmrw)\b/i.exec(text);
  const nextWeekdayRe = /(^|\s)(?:(next|this)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)\b/i.exec(text);
  const inNRe = /(^|\s)in\s+(\d{1,3})\s+(day|days|week|weeks)\b/i.exec(text);
  const onDateRe = /(^|\s)(?:on\s+)?(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\s+(\d{1,2})(?:st|nd|rd|th)?\b/i.exec(text);
  const isoRe = /(^|\s)(\d{4})-(\d{2})-(\d{2})\b/.exec(text);

  if (isoRe) {
    dateParts = { year: Number(group(isoRe, 2)), month: Number(group(isoRe, 3)), day: Number(group(isoRe, 4)) };
    dateConfidence = 0.98;
    dateSource = group(isoRe, 0).trim();
    claim(isoRe.index + group(isoRe, 1).length, isoRe.index + group(isoRe, 0).length);
  } else if (todayRe) {
    dateParts = addLocalDays(now, timeZone, 0);
    dateConfidence = 0.97;
    dateSource = group(todayRe, 2);
    if (group(todayRe, 2).toLowerCase() === 'tonight' && !clock) {
      clock = { hour: 19, minute: 0 };
      clockConfidence = 0.6; // "tonight" is vague — force confirmation
    }
    claim(todayRe.index + group(todayRe, 1).length, todayRe.index + group(todayRe, 0).length);
  } else if (tomorrowRe) {
    dateParts = addLocalDays(now, timeZone, 1);
    dateConfidence = 0.97;
    dateSource = group(tomorrowRe, 2);
    claim(tomorrowRe.index + group(tomorrowRe, 1).length, tomorrowRe.index + group(tomorrowRe, 0).length);
  } else if (inNRe) {
    const n = Number(group(inNRe, 2));
    const days = group(inNRe, 3).toLowerCase().startsWith('week') ? n * 7 : n;
    dateParts = addLocalDays(now, timeZone, days);
    dateConfidence = 0.94;
    dateSource = group(inNRe, 0).trim();
    claim(inNRe.index + group(inNRe, 1).length, inNRe.index + group(inNRe, 0).length);
  } else if (onDateRe) {
    const month = MONTHS[group(onDateRe, 2).toLowerCase()] ?? 1;
    const day = Number(group(onDateRe, 3));
    const cur = localParts(now, timeZone);
    // Assume the next occurrence of that month/day.
    const year = month < cur.month || (month === cur.month && day < cur.day) ? cur.year + 1 : cur.year;
    dateParts = { year, month, day };
    dateConfidence = 0.9;
    dateSource = group(onDateRe, 0).trim();
    claim(onDateRe.index + group(onDateRe, 1).length, onDateRe.index + group(onDateRe, 0).length);
  } else if (nextWeekdayRe && !recurrence) {
    const target = WEEKDAYS[group(nextWeekdayRe, 3).toLowerCase()] ?? 0;
    const cur = localParts(now, timeZone);
    let delta = (target - cur.weekday + 7) % 7;
    const qualifier = nextWeekdayRe[2]?.toLowerCase();
    if (delta === 0) delta = 7; // "monday" on a Monday means next Monday
    if (qualifier === 'next' && delta < 7) delta += 7;
    dateParts = addLocalDays(now, timeZone, delta);
    dateConfidence = qualifier ? 0.92 : 0.85;
    dateSource = group(nextWeekdayRe, 0).trim();
    claim(nextWeekdayRe.index + group(nextWeekdayRe, 1).length, nextWeekdayRe.index + group(nextWeekdayRe, 0).length);
  }

  if (dateParts) {
    const hour = clock?.hour ?? 9; // default planning hour
    const minute = clock?.minute ?? 0;
    const instant = zonedTimeToUtc(dateParts.year, dateParts.month, dateParts.day, hour, minute, timeZone);
    dueAt = {
      value: instant.toISOString(),
      // A date without an explicit time is inherently less certain.
      confidence: clock ? Math.min(dateConfidence, clockConfidence) : Math.min(dateConfidence, 0.75),
      source: clock ? `${dateSource} ${tm?.[2] ?? ''}`.trim() : dateSource,
    };
  } else if (clock) {
    // Time with no date: assume today, or tomorrow if the time already passed.
    const cur = localParts(now, timeZone);
    let candidate = zonedTimeToUtc(cur.year, cur.month, cur.day, clock.hour, clock.minute, timeZone);
    if (candidate.getTime() <= now.getTime()) {
      const t = addLocalDays(now, timeZone, 1);
      candidate = zonedTimeToUtc(t.year, t.month, t.day, clock.hour, clock.minute, timeZone);
    }
    dueAt = { value: candidate.toISOString(), confidence: Math.min(clockConfidence, 0.72), source: tm?.[2] ?? '' };
  }

  // ---- title: whatever was not consumed
  const merged = consumed.sort((a, b) => a.start - b.start);
  let title = '';
  let cursor = 0;
  for (const span of merged) {
    if (span.start > cursor) title += original.slice(cursor, span.start);
    cursor = Math.max(cursor, span.end);
  }
  title += original.slice(cursor);
  title = title
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/^[\s,;:-]+|[\s,;:-]+$/g, '')
    .trim();

  // Never return an empty title — fall back to the raw input.
  if (!title) title = original.trim();

  const fields = [dueAt, estimate, priority, project, recurrence].filter(Boolean) as Array<{ confidence: number }>;
  const requiresConfirmation = fields.some((f) => f.confidence < CONFIRMATION_THRESHOLD);

  return {
    title,
    dueAt,
    estimateMinutes: estimate,
    priority,
    tags: tagValues.length ? { value: tagValues, confidence: 0.97, source: tagSpanSource } : null,
    project,
    recurrence,
    requiresConfirmation,
    originalText: original,
  };
}
