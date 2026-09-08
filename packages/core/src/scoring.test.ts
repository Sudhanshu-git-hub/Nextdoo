import { describe, expect, it } from 'vitest';
import { calculateScore, determineOutcome, type ScoringInput } from './scoring';

const base = (over: Partial<ScoringInput> = {}): ScoringInput => ({
  completed: false,
  dueAt: null,
  completedAt: null,
  estimateMinutes: null,
  actualMinutes: null,
  expectedOccurrences: null,
  completedOccurrences: null,
  rescheduleCount: 0,
  skipped: false,
  evaluatedAt: new Date('2026-09-08T12:00:00Z'),
  ...over,
});

const at = (iso: string) => new Date(iso);

describe('determineOutcome', () => {
  it('TR-01: completed shortly before due is ON_TIME', () => {
    const outcome = determineOutcome(
      base({ completed: true, dueAt: at('2026-09-08T10:00:00Z'), completedAt: at('2026-09-08T09:50:00Z') }),
      60,
    );
    expect(outcome).toBe('ON_TIME');
  });

  it('flags EARLY only beyond the configured threshold', () => {
    const input = base({ completed: true, dueAt: at('2026-09-08T10:00:00Z'), completedAt: at('2026-09-08T08:00:00Z') });
    expect(determineOutcome(input, 60)).toBe('EARLY');
    expect(determineOutcome(input, 180)).toBe('ON_TIME');
  });

  it('returns LATE past the due instant', () => {
    expect(
      determineOutcome(base({ completed: true, dueAt: at('2026-09-08T10:00:00Z'), completedAt: at('2026-09-08T11:00:00Z') }), 60),
    ).toBe('LATE');
  });

  it('returns UNMEASURED when a completed task has no due date', () => {
    expect(determineOutcome(base({ completed: true, completedAt: at('2026-09-08T11:00:00Z') }), 60)).toBe('UNMEASURED');
  });

  it('returns INCOMPLETE once due has passed with no completion', () => {
    expect(determineOutcome(base({ dueAt: at('2026-09-07T10:00:00Z') }), 60)).toBe('INCOMPLETE');
  });

  it('prefers RESCHEDULED over INCOMPLETE when the user moved the date', () => {
    expect(determineOutcome(base({ dueAt: at('2026-09-07T10:00:00Z'), rescheduleCount: 2 }), 60)).toBe('RESCHEDULED');
  });

  it('returns SKIPPED for a skipped occurrence', () => {
    expect(determineOutcome(base({ skipped: true }), 60)).toBe('SKIPPED');
  });
});

describe('calculateScore', () => {
  it('TR-02: applies the hourly lateness penalty', () => {
    const r = calculateScore(
      base({ completed: true, dueAt: at('2026-09-08T00:00:00Z'), completedAt: at('2026-09-08T06:00:00Z') }),
      { latenessPenaltyPerHour: 4 },
    );
    const timing = r.components.find((c) => c.key === 'timing');
    expect(timing?.value).toBe(76); // 100 - 6h * 4
  });

  it('never lets the timing penalty go negative', () => {
    const r = calculateScore(
      base({ completed: true, dueAt: at('2026-09-01T00:00:00Z'), completedAt: at('2026-09-08T00:00:00Z') }),
    );
    expect(r.components.find((c) => c.key === 'timing')?.value).toBe(0);
  });

  it('TR-03: excludes the estimate component and normalises the remaining weight', () => {
    const r = calculateScore(
      base({ completed: true, dueAt: at('2026-09-08T10:00:00Z'), completedAt: at('2026-09-08T09:00:00Z') }),
    );
    const est = r.components.find((c) => c.key === 'estimateAccuracy');
    expect(est?.measured).toBe(false);
    expect(est?.value).toBeNull();
    // Only completion (0.40) + timing (0.25) are measurable here.
    expect(r.measuredWeight).toBe(0.65);
    expect(r.score).toBe(100);
  });

  it('does NOT default an unmeasured component to zero', () => {
    const withEstimate = calculateScore(
      base({
        completed: true,
        dueAt: at('2026-09-08T10:00:00Z'),
        completedAt: at('2026-09-08T09:00:00Z'),
        estimateMinutes: 60,
        actualMinutes: 60,
      }),
    );
    const withoutEstimate = calculateScore(
      base({ completed: true, dueAt: at('2026-09-08T10:00:00Z'), completedAt: at('2026-09-08T09:00:00Z') }),
    );
    // A missing estimate must not drag the score down.
    expect(withoutEstimate.score).toBe(withEstimate.score);
  });

  it('scores estimate accuracy from the variance ratio', () => {
    const r = calculateScore(base({ completed: true, estimateMinutes: 100, actualMinutes: 142 }));
    const est = r.components.find((c) => c.key === 'estimateAccuracy');
    expect(est?.value).toBe(58); // 42% over
    expect(est?.reason).toContain('42% longer than');
  });

  it('floors estimate accuracy at zero for extreme overruns', () => {
    const r = calculateScore(base({ completed: true, estimateMinutes: 10, actualMinutes: 600 }));
    expect(r.components.find((c) => c.key === 'estimateAccuracy')?.value).toBe(0);
  });

  it('TR-06: computes recurrence adherence', () => {
    const r = calculateScore(base({ expectedOccurrences: 4, completedOccurrences: 3 }));
    expect(r.components.find((c) => c.key === 'recurrence')?.value).toBe(75);
  });

  it('returns a null score when nothing is measurable', () => {
    const r = calculateScore(base());
    expect(r.score).toBeNull();
    expect(r.outcome).toBe('UNMEASURED');
    expect(r.explanation).toMatch(/not enough information/i);
  });

  it('does not score completion for an open task that is not yet due', () => {
    const r = calculateScore(base({ dueAt: at('2026-09-09T10:00:00Z') }));
    expect(r.components.find((c) => c.key === 'completion')?.measured).toBe(false);
  });

  it('scores completion as 0 once an open task is overdue', () => {
    const r = calculateScore(base({ dueAt: at('2026-09-07T10:00:00Z') }));
    expect(r.components.find((c) => c.key === 'completion')?.value).toBe(0);
  });

  it('explains every component in plain language without blaming the user', () => {
    const r = calculateScore(
      base({
        completed: true,
        dueAt: at('2026-09-08T10:00:00Z'),
        completedAt: at('2026-09-08T12:00:00Z'),
        estimateMinutes: 60,
        actualMinutes: 90,
      }),
    );
    for (const c of r.components) expect(c.reason.length).toBeGreaterThan(0);
    const joined = r.components.map((c) => c.reason).join(' ').toLowerCase();
    expect(joined).not.toMatch(/fail|lazy|bad|poor/);
  });

  it('is deterministic for identical input', () => {
    const input = base({ completed: true, dueAt: at('2026-09-08T10:00:00Z'), completedAt: at('2026-09-08T11:30:00Z') });
    expect(calculateScore(input)).toEqual(calculateScore(input));
  });

  it('honours custom weights', () => {
    const input = base({
      completed: true,
      dueAt: at('2026-09-08T10:00:00Z'),
      completedAt: at('2026-09-08T20:00:00Z'),
    });
    const dflt = calculateScore(input);
    const timingHeavy = calculateScore(input, { weights: { completion: 0.1, timing: 0.9 } });
    expect(timingHeavy.score!).toBeLessThan(dflt.score!);
  });
});
