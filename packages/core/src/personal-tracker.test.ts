import { describe, expect, it } from 'vitest';
import { trackerDefinitionSchema, trackerDaySchema } from '@nextdoo/contracts';
import { createTrackerDefinition, evaluatePersonalTracker, personalTrackerReport, personalTrackerTemplates, trackerDate, trackerSourceValues, validateTrackerValues } from './personal-tracker';

describe('personal tracker rules and reports', () => {
  it('evaluates every comparison and leaves unmatched optional scoring unmeasured', () => {
    for (const [operator, input, expected] of [['eq', 30, true], ['neq', 20, true], ['gt', 31, true], ['gte', 30, true], ['lt', 29, true], ['lte', 30, true], ['gt', 30, false]] as const) {
      const d = createTrackerDefinition(); d.defaultStatusId = null;
      d.rules = [{ id: 'rule', statusId: 'excellent', match: 'all', conditions: [{ fieldId: 'input', operator, value: 30 }] }];
      expect(evaluatePersonalTracker(d, { input }).stars).toBe(expected ? 5 : null);
    }
    const d = createTrackerDefinition(); d.fields[0]!.type = 'select'; d.fields[0]!.options = ['yes', 'no']; d.rules = [];
    expect(() => validateTrackerValues(d, { input: 'yes' })).not.toThrow();
    expect(() => validateTrackerValues(d, { input: 'unknown' })).toThrow();
  });
  it('aggregates the latest evidence per task, preserves purged identities and never invents duration', () => {
    const d = createTrackerDefinition();
    d.fields = [
      { id: 'done', label: 'Done', type: 'checkbox', source: 'task_completed', unit: '', options: [] },
      { id: 'count', label: 'Count', type: 'number', source: 'task_count', unit: '', options: [] },
      { id: 'duration', label: 'Duration', type: 'duration', source: 'task_duration', unit: 'minutes', options: [] },
      { id: 'at', label: 'At', type: 'datetime', source: 'task_completed_at', unit: '', options: [] },
      ...d.fields,
    ];
    const first = { taskId: null, taskIdentity: 'first', sourceEventId: 'one', completedAt: new Date('2026-01-01T10:00Z'), createdAt: new Date('2026-01-01T10:00Z'), durationMinutes: '30' };
    const latest = { ...first, sourceEventId: 'two', createdAt: new Date('2026-01-01T12:00Z'), durationMinutes: '60' };
    const second = { ...first, taskIdentity: 'second', sourceEventId: 'three', completedAt: new Date('2026-01-01T13:00Z'), durationMinutes: '15' };
    expect(trackerSourceValues(d, [latest, first, second])).toEqual({ done: true, count: 2, duration: 75, at: '2026-01-01T13:00:00.000Z' });
    expect(trackerSourceValues(d, [first, { ...second, durationMinutes: null }]).duration).toBeNull();
    expect(trackerSourceValues(d, [])).toEqual({ done: null, count: null, duration: null, at: null });
  });
  it('filters report boundaries, sorts periods and safely groups user-defined status names', () => {
    const report = personalTrackerReport('2026-01-02', '2026-01-01', '2026-02-01', [
      { day: '2026-01-01', stars: 5, statusName: 'Excluded' },
      { day: '2026-02-01', stars: 1, statusName: '__proto__', sourceCount: 2 },
      { day: '2026-01-04', stars: 5, statusName: '__proto__' },
      { day: '2026-01-03', stars: null, statusName: null },
      { day: '2026-02-02', stars: 5, statusName: 'Excluded' },
    ]);
    expect(report).toMatchObject({ calendarDays: 31, trackedDays: 3, totalStars: 6, linkedTaskCompletions: 2, bestDay: { day: '2026-01-04' }, worstDay: { day: '2026-02-01' } });
    expect(report.statusDistribution['__proto__']).toBe(2);
    expect(report.trend.map((r) => r.day)).toEqual(['2026-01-03', '2026-01-04', '2026-02-01']);
    expect(report.monthly.map((p) => p.period)).toEqual(['2026-01', '2026-02']);
  });
  it('uses ordered configurable thresholds, status names and star mappings', () => {
    const d = createTrackerDefinition();
    for (const [input, stars] of [[0, 0], [30, 2], [60, 3], [90, 5], [100, 5]] as const) expect(evaluatePersonalTracker(d, { input }).stars).toBe(stars);
    d.statuses[3] = { id: 'excellent', name: 'My best', stars: 4 };
    expect(evaluatePersonalTracker(d, { input: 90 })).toMatchObject({ statusName: 'My best', stars: 4 });
    expect(evaluatePersonalTracker(d, {}).stars).toBeNull();
    expect(() => validateTrackerValues(d, { invented: 1 })).toThrow();
  });
  it('keeps average and relative denominators separate without fake records', () => {
    const rows = [1, 2, 3, 5, 6, 9].map((day) => ({ day: `2026-01-0${day}`, stars: 5, statusName: 'Excellent' }));
    const report = personalTrackerReport('2026-01-01', '2026-01-01', '2026-01-10', rows);
    expect(report).toMatchObject({ calendarDays: 10, trackedDays: 6, nonTrackingDays: 4, totalStars: 30, averageStars: 3, relativeStars: 5, completionRate: 0.6 });
    expect(report.trend).toHaveLength(6);
    expect(report.weekly).toHaveLength(2);
    expect(report.monthly[0]?.totalStars).toBe(30);
  });
  it('handles zero days, missing scores, inclusive boundaries and leap days', () => {
    expect(personalTrackerReport('2026-02-01', '2026-01-01', '2026-01-10', [])).toMatchObject({ calendarDays: 0, averageStars: null, relativeStars: null });
    expect(personalTrackerReport('2026-01-01', '2026-01-01', '2026-01-01', [])).toMatchObject({ calendarDays: 1, averageStars: 0, relativeStars: null, nonTrackingDays: 1 });
    expect(personalTrackerReport('2024-02-28', '2024-02-28', '2024-03-01', [{ day: '2024-02-29', stars: null, statusName: null }])).toMatchObject({ calendarDays: 3, trackedDays: 1, unscoredDays: 1 });
    expect(trackerDaySchema.safeParse('2026-02-29').success).toBe(false);
    expect(trackerDaySchema.safeParse('0000-01-01').success).toBe(false);
    expect(() => personalTrackerReport('2026-01-01', '2026-01-01', '2026-01-01', [1, 2].map(() => ({ day: '2026-01-01', stars: 2, statusName: 'Good' })))).toThrow();
  });
  it('validates typed fields, sources, operators and semantic column IDs', () => {
    const d = createTrackerDefinition();
    d.columns[0]!.label = 'My day'; expect(trackerDefinitionSchema.safeParse(d).success).toBe(true);
    d.fields[0]!.source = 'task_completed'; expect(trackerDefinitionSchema.safeParse(d).success).toBe(false);
    d.fields[0]!.type = 'checkbox'; d.rules = [{ id: 'yes', statusId: 'excellent', match: 'all', conditions: [{ fieldId: 'input', operator: 'eq', value: true }] }];
    expect(evaluatePersonalTracker(d, { input: true }).stars).toBe(5);
    expect(() => validateTrackerValues(d, { input: true }, true)).toThrow();
    d.columns[1]!.semantic = 'date'; expect(trackerDefinitionSchema.safeParse(d).success).toBe(false);
  });
  it('compares date/times as instants and supports text, select and compound rules', () => {
    const d = createTrackerDefinition();
    d.fields = [{ id: 'at', label: 'When', type: 'datetime', source: 'manual', unit: '', options: [] }, { id: 'note', label: 'Text', type: 'text', source: 'manual', unit: '', options: [] }];
    d.rules = [{ id: 'match', statusId: 'excellent', match: 'any', conditions: [{ fieldId: 'at', operator: 'eq', value: '2026-01-01T00:00:00Z' }, { fieldId: 'note', operator: 'contains', value: 'done' }] }];
    expect(evaluatePersonalTracker(d, { at: '2026-01-01T05:30:00+05:30', note: '' }).stars).toBe(5);
    expect(evaluatePersonalTracker(d, { at: '2026-01-02T00:00:00Z', note: 'done today' }).stars).toBe(5);
  });
  it('uses local tracking dates and copies templates independently', () => {
    expect(trackerDate(new Date('2026-01-01T20:00:00Z'), 'Asia/Calcutta')).toBe('2026-01-02');
    const a = personalTrackerTemplates(), b = personalTrackerTemplates();
    expect(a).toHaveLength(11); a.forEach((t) => expect(trackerDefinitionSchema.safeParse(t.definition).success).toBe(true));
    a[0]!.definition.columns[0]!.label = 'Changed'; expect(b[0]!.definition.columns[0]!.label).toBe('Date');
  });
});
