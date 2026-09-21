import { describe, expect, it } from 'vitest';
import { SUGGESTION_RULE_VERSION, type Suggestion } from '@nextdoo/contracts';
import { buildSuggestions, SUGGESTION_RULE_LIMITS, type SuggestionCohortInput, type SuggestionDayInput, type SuggestionInputs, type SuggestionRecurrenceInput, type SuggestionTaskInput } from './suggestion-rules';

const tag = (name: string, variancePct: number, taskCount: number): SuggestionCohortInput => ({ key: `tag:${name}`, kind: 'tag', label: name, variancePct, taskCount });
const project = (id: string, name: string, variancePct: number, taskCount: number): SuggestionCohortInput => ({ key: `project:${id}`, kind: 'project', label: name, variancePct, taskCount });
const day = (day: string, label: string, plannedMinutes: number, workdayMinutes: number | null): SuggestionDayInput => ({ day, label, plannedMinutes, workdayMinutes });
const task = (over: Partial<SuggestionTaskInput> & { id: string; title: string }): SuggestionTaskInput => ({
  estimateMinutes: null,
  actualMinutes: null,
  rescheduleCount: 0,
  version: 1,
  tagNames: [],
  projectId: null,
  hasSubtasks: false,
  ...over,
});
const series = (over: Partial<SuggestionRecurrenceInput> & { ruleId: string; title: string }): SuggestionRecurrenceInput => ({
  measuredOccurrences: 0,
  medianLateMinutes: null,
  adherencePct: null,
  nextDueMinutesOfDay: null,
  ...over,
});
const inputs = (over: Partial<SuggestionInputs> = {}): SuggestionInputs => ({
  overloadWarningsEnabled: true,
  days: [],
  tasks: [],
  cohorts: [],
  recurrences: [],
  ...over,
});
const byType = (s: Suggestion[]) => {
  const map = new Map(s.map((x) => [x.type, x]));
  return (type: Suggestion['type']) => {
    const found = map.get(type);
    if (!found) throw new Error(`expected a ${type} suggestion, got: ${[...map.keys()].join(',') || 'none'}`);
    return found;
  };
};

describe('S1 — larger estimates for similar tasks', () => {
  it('fires when the task\'s tag cohort ran ≥ +10% over with ≥ 2 measured tasks', () => {
    const s = buildSuggestions(
      inputs({
        cohorts: [tag('Deep work', 25, 3)],
        tasks: [task({ id: 't1', title: 'Draft spec', estimateMinutes: 60, tagNames: ['Deep work'] })],
      }),
    );
    const s1 = byType(s)('S1_ESTIMATE');
    expect(s1).toBeDefined();
    expect(s1.action).toEqual({ kind: 'raise_estimate', taskId: 't1', suggestedMinutes: 75, taskVersion: 1 });
    expect(s1.evidence).toEqual({ estimateMinutes: 60, variancePct: 25, taskCount: 3 });
    expect(s1.message).toContain('75 min');
    expect(s1.message).toContain('25%');
    expect(s1.ruleVersion).toBe(SUGGESTION_RULE_VERSION);
    expect(s1.id).toBe('S1_ESTIMATE:t1');
  });

  it('falls back to the project cohort when no matching tag cohort is strong enough', () => {
    const s = buildSuggestions(
      inputs({
        cohorts: [tag('Deep work', 4, 5), project('p1', 'Ops', 15, 2)],
        tasks: [task({ id: 't1', title: 'Rotate creds', estimateMinutes: 120, tagNames: ['Deep work'], projectId: 'p1' })],
      }),
    );
    const s1 = byType(s)('S1_ESTIMATE');
    expect(s1).toBeDefined();
    expect(s1.action).toMatchObject({ suggestedMinutes: round5(120 * 1.15) });
    expect(s1.message).toContain('Ops');
  });

  it('picks the strongest cohort when a task matches several', () => {
    const s = buildSuggestions(
      inputs({
        cohorts: [tag('A', 12, 2), tag('B', 30, 2)],
        tasks: [task({ id: 't1', title: 'X', estimateMinutes: 100, tagNames: ['A', 'B'] })],
      }),
    );
    expect(byType(s)('S1_ESTIMATE')?.message).toContain('30%');
  });

  it.each([
    ['variance just under threshold', tag('T', 9.9, 5)],
    ['cohort under n=2', tag('T', 40, 1)],
    ['negative variance', tag('T', -30, 5)],
  ])('does not fire on %s', (_label, cohort) => {
    const s = buildSuggestions(inputs({ cohorts: [cohort], tasks: [task({ id: 't1', title: 'X', estimateMinutes: 60, tagNames: ['T'] })] }));
    expect(s.filter((x) => x.type === 'S1_ESTIMATE')).toHaveLength(0);
  });

  it('ignores tasks without a usable estimate (Unmeasured estimates are not fabricated)', () => {
    const s = buildSuggestions(
      inputs({ cohorts: [tag('T', 40, 5)], tasks: [task({ id: 't1', title: 'No estimate', tagNames: ['T'] }), task({ id: 't2', title: 'Zero estimate', estimateMinutes: 0, tagNames: ['T'] })] }),
    );
    expect(s.filter((x) => x.type === 'S1_ESTIMATE')).toHaveLength(0);
  });

  it('rounds the suggestion to 5-minute steps and skips rounding no-ops', () => {
    // 60 × 1.10 = 66 → 65 (round5).
    const fired = buildSuggestions(
      inputs({ cohorts: [tag('T', 10, 2)], tasks: [task({ id: 't1', title: 'X', estimateMinutes: 60, tagNames: ['T'] })] }),
    );
    expect(byType(fired)('S1_ESTIMATE')?.action).toMatchObject({ suggestedMinutes: 65 });
    // 5 × 1.10 = 5.5 → round5 = 5 = estimate → no-op, suppressed.
    const noop = buildSuggestions(
      inputs({ cohorts: [tag('T', 10, 2)], tasks: [task({ id: 't1', title: 'X', estimateMinutes: 5, tagNames: ['T'] })] }),
    );
    expect(noop.filter((x) => x.type === 'S1_ESTIMATE')).toHaveLength(0);
  });

  it('caps at 2, ranked by uplift then title', () => {
    const s = buildSuggestions(
      inputs({
        cohorts: [tag('T', 50, 3)],
        tasks: [
          task({ id: 't1', title: 'B beta', estimateMinutes: 100, tagNames: ['T'] }), // +50
          task({ id: 't2', title: 'A alpha', estimateMinutes: 100, tagNames: ['T'] }), // +50
          task({ id: 't3', title: 'A alpha', estimateMinutes: 50, tagNames: ['T'] }), // +25
        ],
      }),
    );
    const s1 = s.filter((x) => x.type === 'S1_ESTIMATE');
    expect(s1).toHaveLength(2);
    expect(s1.map((x) => x.target.taskId)).toEqual(['t2', 't1']);
  });
});

describe('S2 — less work on overloaded days (view-only)', () => {
  const days = [day('2026-09-14', 'Mon 14 Sep', 500, 480), day('2026-09-15', 'Tue 15 Sep', 620, 480), day('2026-09-16', 'Wed 16 Sep', 470, 480)];

  it('fires only for days above a known workday, ranked by overage, capped at 2', () => {
    const s = buildSuggestions(inputs({ days }));
    const s2 = s.filter((x) => x.type === 'S2_OVERLOAD');
    expect(s2.map((x) => x.target.dayKey)).toEqual(['2026-09-15', '2026-09-14']);
    expect(s2[0]!.evidence).toEqual({ plannedMinutes: 620, workdayMinutes: 480, overByMinutes: 140 });
  });

  it('is view-only: the action is navigation, never a move or mutate', () => {
    const s2 = byType(buildSuggestions(inputs({ days })))('S2_OVERLOAD');
    expect(s2.action.kind).toBe('open_day');
    expect(JSON.stringify(s2)).not.toMatch(/move|mutat/i);
  });

  it('is fully suppressed when overload warnings are disabled (§7.9 toggle)', () => {
    expect(buildSuggestions(inputs({ days, overloadWarningsEnabled: false })).filter((x) => x.type === 'S2_OVERLOAD')).toHaveLength(0);
  });

  it('does not fire when the workday is unknown (CAPACITY_UNKNOWN honesty)', () => {
    const s = buildSuggestions(inputs({ days: [day('2026-09-15', 'Tue 15 Sep', 999, null)] }));
    expect(s.filter((x) => x.type === 'S2_OVERLOAD')).toHaveLength(0);
  });

  it('does not fire at exactly the guideline', () => {
    const s = buildSuggestions(inputs({ days: [day('2026-09-15', 'Tue 15 Sep', 480, 480)] }));
    expect(s.filter((x) => x.type === 'S2_OVERLOAD')).toHaveLength(0);
  });
});

describe('S3 — earlier planning for recurring work', () => {
  it('fires on median lateness ≥ 30 min with ≥ 3 measured occurrences and proposes an earlier time (15-min rounded)', () => {
    const s = buildSuggestions(
      inputs({ recurrences: [series({ ruleId: 'r1', title: 'Standup follow-up', measuredOccurrences: 4, medianLateMinutes: 40, nextDueMinutesOfDay: 9 * 60 + 30 })] }),
    );
    const s3 = byType(s)('S3_RECURRING');
    expect(s3).toBeDefined();
    expect(s3.message).toContain('08:45'); // 09:30 − 45 (40 → 45 rounded)
    expect(s3.message).toContain('09:30');
    expect(s3.action).toEqual({ kind: 'open_recurrence', recurrenceRuleId: 'r1' });
  });

  it('fires on adherence < 80% even with no lateness data', () => {
    const s = buildSuggestions(inputs({ recurrences: [series({ ruleId: 'r1', title: 'Weekly report', measuredOccurrences: 3, adherencePct: 60 })] }));
    const s3 = byType(s)('S3_RECURRING');
    expect(s3).toBeDefined();
    expect(s3.message).toContain('60%');
  });

  it.each([
    ['fewer than 3 measured', { measuredOccurrences: 2, medianLateMinutes: 90, nextDueMinutesOfDay: 600 }],
    ['median lateness under 30 and adherence ≥ 80', { measuredOccurrences: 5, medianLateMinutes: 20, adherencePct: 85, nextDueMinutesOfDay: 600 }],
    ['unmeasured', { measuredOccurrences: 0, medianLateMinutes: null, adherencePct: null, nextDueMinutesOfDay: 600 }],
  ])('does not fire on %s', (_label, rec) => {
    const s = buildSuggestions(inputs({ recurrences: [series({ ruleId: 'r1', title: 'X', ...rec })] }));
    expect(s.filter((x) => x.type === 'S3_RECURRING')).toHaveLength(0);
  });

  it('falls back to generic wording when the suggested time would land before 00:00 or not be earlier', () => {
    const early = buildSuggestions(
      inputs({ recurrences: [series({ ruleId: 'r1', title: 'Morning check', measuredOccurrences: 3, medianLateMinutes: 500, nextDueMinutesOfDay: 60 })] }),
    );
    expect(byType(early)('S3_RECURRING')?.message).toContain('earlier in the day');
    expect(byType(early)('S3_RECURRING')?.message).not.toContain('00:');
    const tiny = buildSuggestions(
      inputs({ recurrences: [series({ ruleId: 'r1', title: 'X', measuredOccurrences: 3, medianLateMinutes: 5, nextDueMinutesOfDay: 600 })] }),
    );
    // median 5 < 30 and no adherence → no trigger at all
    expect(tiny.filter((x) => x.type === 'S3_RECURRING')).toHaveLength(0);
  });

  it('caps at 2, ranked by median lateness', () => {
    const s = buildSuggestions(
      inputs({
        recurrences: [
          series({ ruleId: 'r1', title: 'A', measuredOccurrences: 3, medianLateMinutes: 30, nextDueMinutesOfDay: 600 }),
          series({ ruleId: 'r2', title: 'B', measuredOccurrences: 3, medianLateMinutes: 90, nextDueMinutesOfDay: 600 }),
          series({ ruleId: 'r3', title: 'C', measuredOccurrences: 3, medianLateMinutes: 60, nextDueMinutesOfDay: 600 }),
        ],
      }),
    );
    expect(s.filter((x) => x.type === 'S3_RECURRING').map((x) => x.target.recurrenceRuleId)).toEqual(['r2', 'r3']);
  });
});

describe('S4 — breaking large tasks into subtasks', () => {
  it('fires on a large estimate with no subtasks', () => {
    const s = buildSuggestions(inputs({ tasks: [task({ id: 't1', title: 'Migration', estimateMinutes: 300 })] }));
    const s4 = byType(s)('S4_SPLIT');
    expect(s4).toBeDefined();
    expect(s4.message).toContain('300 min');
    expect(s4.action).toEqual({ kind: 'open_task', taskId: 't1' });
  });

  it('fires on a measured actual ≥ 4h even without an estimate', () => {
    const s = buildSuggestions(inputs({ tasks: [task({ id: 't1', title: 'Audit', actualMinutes: 240 })] }));
    expect(byType(s)('S4_SPLIT')?.message).toContain('240 min');
  });

  it('skips tasks that already have subtasks and tasks under the size floor', () => {
    const s = buildSuggestions(
      inputs({ tasks: [task({ id: 't1', title: 'Has subs', estimateMinutes: 600, hasSubtasks: true }), task({ id: 't2', title: 'Small', estimateMinutes: 239 })] }),
    );
    expect(s.filter((x) => x.type === 'S4_SPLIT')).toHaveLength(0);
  });

  it('caps at 3, ranked by size', () => {
    const s = buildSuggestions(
      inputs({ tasks: [task({ id: 't1', title: 'A', estimateMinutes: 240 }), task({ id: 't2', title: 'B', estimateMinutes: 400 }), task({ id: 't3', title: 'C', estimateMinutes: 500 }), task({ id: 't4', title: 'D', estimateMinutes: 999 })] }),
    );
    expect(s.filter((x) => x.type === 'S4_SPLIT').map((x) => x.target.taskId)).toEqual(['t4', 't3', 't2']);
  });
});

describe('S5 — reviewing frequently rescheduled tasks', () => {
  it('fires at rescheduleCount ≥ 3 and caps at 3 by count', () => {
    const s = buildSuggestions(
      inputs({ tasks: [task({ id: 't1', title: 'A', rescheduleCount: 3 }), task({ id: 't2', title: 'B', rescheduleCount: 9 }), task({ id: 't3', title: 'C', rescheduleCount: 5 }), task({ id: 't4', title: 'D', rescheduleCount: 4 })] }),
    );
    const s5 = s.filter((x) => x.type === 'S5_REVIEW');
    expect(s5.map((x) => x.target.taskId)).toEqual(['t2', 't3', 't4']);
    expect(s5[0]!.message).toContain('9 times');
  });

  it('does not fire below the floor', () => {
    const s = buildSuggestions(inputs({ tasks: [task({ id: 't1', title: 'A', rescheduleCount: 2 })] }));
    expect(s.filter((x) => x.type === 'S5_REVIEW')).toHaveLength(0);
  });
});

describe('advisory invariants', () => {
  it('never exceeds 11 total suggestions (per-type caps sum to the total)', () => {
    const s = buildSuggestions(
      inputs({
        days: [day('d1', 'D1', 900, 480), day('d2', 'D2', 900, 480), day('d3', 'D3', 900, 480)],
        cohorts: [tag('T', 50, 3), tag('U', 50, 3), tag('V', 50, 3)],
        tasks: [
          task({ id: 't1', title: 'A1', estimateMinutes: 60, tagNames: ['T'], rescheduleCount: 9, version: 3 }),
          task({ id: 't2', title: 'A2', estimateMinutes: 300, tagNames: ['U'], rescheduleCount: 8 }),
          task({ id: 't3', title: 'A3', estimateMinutes: 400, tagNames: ['V'], rescheduleCount: 7 }),
          task({ id: 't4', title: 'A4', estimateMinutes: 500, tagNames: ['T'], rescheduleCount: 6 }),
        ],
        recurrences: [
          series({ ruleId: 'r1', title: 'R1', measuredOccurrences: 3, medianLateMinutes: 90, nextDueMinutesOfDay: 600 }),
          series({ ruleId: 'r2', title: 'R2', measuredOccurrences: 3, medianLateMinutes: 80, nextDueMinutesOfDay: 600 }),
          series({ ruleId: 'r3', title: 'R3', measuredOccurrences: 3, medianLateMinutes: 70, nextDueMinutesOfDay: 600 }),
        ],
      }),
    );
    expect(s.length).toBeLessThanOrEqual(SUGGESTION_RULE_LIMITS.maxTotal);
    expect(s.length).toBe(11);
    // Stable type order: S1…, S2…, S3…, S4…, S5…
    const orderIdx = ['S1_ESTIMATE', 'S2_OVERLOAD', 'S3_RECURRING', 'S4_SPLIT', 'S5_REVIEW'];
    const ranks = s.map((x) => orderIdx.indexOf(x.type));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it('is deterministic: shuffled input order yields identical output', () => {
    const base = inputs({
      days: [day('d1', 'D1', 900, 480), day('d2', 'D2', 500, 480)],
      cohorts: [tag('T', 50, 3), tag('U', 20, 2)],
      tasks: [
        task({ id: 't1', title: 'A', estimateMinutes: 60, tagNames: ['T'], rescheduleCount: 4 }),
        task({ id: 't2', title: 'B', estimateMinutes: 300, tagNames: ['U'], rescheduleCount: 3 }),
        task({ id: 't3', title: 'C', estimateMinutes: 100, tagNames: ['T'] }),
      ],
      recurrences: [
        series({ ruleId: 'r1', title: 'R1', measuredOccurrences: 3, medianLateMinutes: 90, nextDueMinutesOfDay: 600 }),
        series({ ruleId: 'r2', title: 'R2', measuredOccurrences: 3, adherencePct: 50 }),
      ],
    });
    const first = buildSuggestions(base);
    const second = buildSuggestions({
      ...base,
      days: [...base.days].reverse(),
      tasks: [...base.tasks].reverse(),
      cohorts: [...base.cohorts].reverse(),
      recurrences: [...base.recurrences].reverse(),
    });
    expect(second).toEqual(first);
  });

  it('keeps messages ≤ 200 characters with plain, non-punitive wording', () => {
    const s = buildSuggestions(
      inputs({
        tasks: [task({ id: 't1', title: 'A very long task title that keeps going and going to test clamping of long output ', estimateMinutes: 60, tagNames: ['T'] }), task({ id: 't2', title: 'B big', estimateMinutes: 600 })],
        cohorts: [tag('A tag name that is also rather long and contributes to message length', 50, 3)],
      }),
    );
    for (const x of s) {
      expect(x.message.length).toBeLessThanOrEqual(200);
      expect(x.message).not.toMatch(/fail|should have|you must/i);
    }
  });

  it('Unmeasured actuals are never treated as numbers (S4 only uses real measurements)', () => {
    const s = buildSuggestions(inputs({ tasks: [task({ id: 't1', title: 'Unmeasured', estimateMinutes: null, actualMinutes: null })] }));
    expect(s.filter((x) => x.type === 'S4_SPLIT')).toHaveLength(0);
  });

  it('only S1 offers a mutation-capable action; every other action is navigation', () => {
    const s = buildSuggestions(
      inputs({
        days: [day('d1', 'D1', 900, 480)],
        cohorts: [tag('T', 50, 3)],
        tasks: [task({ id: 't1', title: 'A', estimateMinutes: 300, tagNames: ['T'], rescheduleCount: 5 })],
        recurrences: [series({ ruleId: 'r1', title: 'R', measuredOccurrences: 3, medianLateMinutes: 90, nextDueMinutesOfDay: 600 })],
      }),
    );
    for (const x of s) {
      if (x.type === 'S1_ESTIMATE') expect(x.action.kind).toBe('raise_estimate');
      else expect(['open_task', 'open_day', 'open_recurrence']).toContain(x.action.kind);
    }
    expect(s.filter((x) => x.action.kind === 'raise_estimate')).toHaveLength(1);
  });
});

function round5(n: number) { return Math.round(n / 5) * 5; }
