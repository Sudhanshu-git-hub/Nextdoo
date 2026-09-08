import { describe, expect, it } from 'vitest';
import { parseTaskText } from './nl-parse';
import { localParts } from './recurrence';

// Fixed reference instant so every assertion is deterministic.
// 2026-09-08 is a Tuesday.
const NOW = new Date('2026-09-08T10:00:00Z');
const TZ = 'America/New_York';

const parse = (text: string, tz = TZ) => parseTaskText(text, tz, NOW);

describe('the PRD worked example', () => {
  it('parses "Prepare Q3 report tomorrow at 2pm for 90 minutes #finance"', () => {
    const r = parse('Prepare Q3 report tomorrow at 2pm for 90 minutes #finance');
    expect(r.title).toBe('Prepare Q3 report');
    expect(r.estimateMinutes?.value).toBe(90);
    expect(r.tags?.value).toEqual(['finance']);
    expect(r.requiresConfirmation).toBe(false);

    const due = new Date(r.dueAt!.value);
    const local = localParts(due, TZ);
    expect([local.year, local.month, local.day, local.hour]).toEqual([2026, 9, 9, 14]);
  });
});

describe('dates', () => {
  it('resolves "today" in the user time zone', () => {
    const r = parse('Call the bank today');
    expect(localParts(new Date(r.dueAt!.value), TZ).day).toBe(8);
    expect(r.title).toBe('Call the bank');
  });

  it('resolves "in 3 days"', () => {
    const r = parse('Renew licence in 3 days');
    expect(localParts(new Date(r.dueAt!.value), TZ).day).toBe(11);
  });

  it('resolves "in 2 weeks"', () => {
    const r = parse('Board update in 2 weeks');
    expect(localParts(new Date(r.dueAt!.value), TZ).day).toBe(22);
  });

  it('treats a bare weekday as the next one, never today', () => {
    const r = parse('Standup notes tuesday'); // NOW is a Tuesday
    const local = localParts(new Date(r.dueAt!.value), TZ);
    expect(local.day).toBe(15); // a week later
  });

  it('pushes "next friday" past the imminent friday', () => {
    const r = parse('Invoice next friday');
    expect(localParts(new Date(r.dueAt!.value), TZ).day).toBe(18);
  });

  it('parses an ISO date with high confidence', () => {
    const r = parse('Ship release 2026-12-01');
    const local = localParts(new Date(r.dueAt!.value), TZ);
    expect([local.year, local.month, local.day]).toEqual([2026, 12, 1]);
    expect(r.title).toBe('Ship release');
  });

  it('parses "on Oct 3" and rolls to next year when already past', () => {
    const r = parse('Conference on Mar 3');
    const local = localParts(new Date(r.dueAt!.value), TZ);
    expect([local.year, local.month, local.day]).toEqual([2027, 3, 3]);
  });

  it('rolls a bare time that already passed to tomorrow', () => {
    // NOW is 06:00 local (10:00Z). 5am has passed.
    const r = parse('Gym at 5am');
    expect(localParts(new Date(r.dueAt!.value), TZ).day).toBe(9);
  });

  it('keeps a bare future time on today', () => {
    const r = parse('Review PR at 11pm');
    const local = localParts(new Date(r.dueAt!.value), TZ);
    expect(local.day).toBe(8);
    expect(local.hour).toBe(23);
  });

  it('defaults to 09:00 local when no time is given', () => {
    const r = parse('Water plants tomorrow');
    expect(localParts(new Date(r.dueAt!.value), TZ).hour).toBe(9);
  });

  it('respects a different time zone for the same text', () => {
    const ny = parse('Sync tomorrow at 9am', 'America/New_York');
    const tokyo = parse('Sync tomorrow at 9am', 'Asia/Tokyo');
    expect(ny.dueAt!.value).not.toBe(tokyo.dueAt!.value);
    expect(localParts(new Date(tokyo.dueAt!.value), 'Asia/Tokyo').hour).toBe(9);
  });
});

describe('durations', () => {
  it.each([
    ['Task for 90 minutes', 90],
    ['Task for 2 hours', 120],
    ['Task for 1.5h', 90],
    ['Task 45m', 45],
    ['Task for 30 mins', 30],
  ])('parses %s', (text, expected) => {
    expect(parse(text).estimateMinutes?.value).toBe(expected);
  });

  it('rates "for N minutes" more confident than a bare unit', () => {
    expect(parse('Task for 90 minutes').estimateMinutes!.confidence).toBeGreaterThan(
      parse('Task 90m').estimateMinutes!.confidence,
    );
  });
});

describe('tags, projects, priority', () => {
  it('extracts multiple tags', () => {
    const r = parse('Draft brief #client #urgent');
    expect(r.tags?.value).toEqual(['client', 'urgent']);
    expect(r.title).toBe('Draft brief');
  });

  it('extracts a +project', () => {
    const r = parse('Fix login bug +platform');
    expect(r.project?.value).toBe('platform');
    expect(r.title).toBe('Fix login bug');
  });

  it.each([
    ['Ship it !p1', 'HIGH'],
    ['Ship it !p2', 'MEDIUM'],
    ['Ship it !p3', 'LOW'],
    ['Ship it !high', 'HIGH'],
  ])('parses priority in %s', (text, expected) => {
    expect(parse(text).priority?.value).toBe(expected);
  });

  it('parses "high priority" as words', () => {
    expect(parse('Fix outage high priority').priority?.value).toBe('HIGH');
  });
});

describe('recurrence', () => {
  it.each([
    ['Standup every day', 'DAILY', 1],
    ['Payroll every 2 weeks', 'WEEKLY', 2],
    ['Rent every month', 'MONTHLY', 1],
  ])('parses %s', (text, freq, interval) => {
    const r = parse(text);
    expect(r.recurrence?.value.freq).toBe(freq);
    expect(r.recurrence?.value.interval).toBe(interval);
  });

  it('parses a weekday recurrence into byWeekday', () => {
    const r = parse('Team sync every monday');
    expect(r.recurrence?.value.freq).toBe('WEEKLY');
    expect(r.recurrence?.value.byWeekday).toEqual([1]);
  });

  it('does not treat "every monday" as a one-off date', () => {
    const r = parse('Team sync every monday');
    expect(r.title).toBe('Team sync');
  });
});

describe('confirmation gating', () => {
  it('does not require confirmation for unambiguous input', () => {
    expect(parse('Report tomorrow at 2pm for 90 minutes').requiresConfirmation).toBe(false);
  });

  it('requires confirmation for the vague word "tonight"', () => {
    expect(parse('Call mum tonight').requiresConfirmation).toBe(true);
  });

  it('requires confirmation for a date with no explicit time', () => {
    const r = parse('Submit taxes tomorrow');
    expect(r.dueAt!.confidence).toBeLessThan(0.8);
    expect(r.requiresConfirmation).toBe(true);
  });
});

describe('robustness', () => {
  it('returns the raw text as title when nothing is extractable', () => {
    const r = parse('Think about the thing');
    expect(r.title).toBe('Think about the thing');
    expect(r.dueAt).toBeNull();
    expect(r.requiresConfirmation).toBe(false);
  });

  it('never produces an empty title even if the input is only metadata', () => {
    const r = parse('#inbox');
    expect(r.title.length).toBeGreaterThan(0);
  });

  it('always preserves the original text for correction', () => {
    const text = 'Weird   input tomorrow #x';
    expect(parse(text).originalText).toBe(text);
  });

  it('tidies leftover whitespace and punctuation in the title', () => {
    expect(parse('Email Sam,  tomorrow at 3pm').title).toBe('Email Sam');
  });

  it('is deterministic', () => {
    const text = 'Plan sprint next monday at 10am for 2 hours #planning';
    expect(parse(text)).toEqual(parse(text));
  });

  it('handles unicode titles and tags', () => {
    const r = parse('Café meeting tomorrow #café');
    expect(r.title).toBe('Café meeting');
    expect(r.tags?.value).toEqual(['café']);
  });
});
