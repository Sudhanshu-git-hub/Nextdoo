import { trackerDefinitionSchema, trackerDaySchema, validTrackerValue, type TrackerDefinition, type TrackerValue } from '@nextdoo/contracts';

export function validateTrackerValues(definition: TrackerDefinition, values: Record<string, TrackerValue>, manualOnly = false) {
  for (const [id, value] of Object.entries(values)) {
    const field = definition.fields.find((f) => f.id === id);
    if (!field || (manualOnly && field.source !== 'manual') || !validTrackerValue(field, value)) throw new Error(`Invalid tracker input: ${id}`);
  }
}

/** Ordered rules: first matching rule wins. Missing rule inputs remain unmeasured. */
export function evaluatePersonalTracker(definition: TrackerDefinition, values: Record<string, TrackerValue>) {
  trackerDefinitionSchema.parse(definition); validateTrackerValues(definition, values);
  const required = [...new Set(definition.rules.flatMap((r) => r.conditions.map((c) => c.fieldId)))];
  const missing = required.filter((id) => values[id] === undefined || values[id] === null);
  if (missing.length) return { statusId: null, statusName: null, stars: null, ruleId: null, missing };
  function matches(condition: TrackerDefinition['rules'][number]['conditions'][number]) {
    const field = definition.fields.find((f) => f.id === condition.fieldId)!;
    let left = values[condition.fieldId]!, right = condition.value!;
    if (field.type === 'datetime') { left = Date.parse(String(left)); right = Date.parse(String(right)); }
    switch (condition.operator) {
      case 'eq': return left === right;
      case 'neq': return left !== right;
      case 'gt': return left > right;
      case 'gte': return left >= right;
      case 'lt': return left < right;
      case 'lte': return left <= right;
      case 'contains': return String(left).includes(String(right));
    }
  }
  const rule = definition.rules.find((r) => r.match === 'all' ? r.conditions.every(matches) : r.conditions.some(matches));
  const status = definition.statuses.find((s) => s.id === (rule?.statusId ?? definition.defaultStatusId));
  return { statusId: status?.id ?? null, statusName: status?.name ?? null, stars: status?.stars ?? null, ruleId: rule?.id ?? null, missing };
}

export function trackerDate(at: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  return `${parts.find((p) => p.type === 'year')!.value}-${parts.find((p) => p.type === 'month')!.value}-${parts.find((p) => p.type === 'day')!.value}`;
}
export interface TrackerSource { taskId: string | null; taskIdentity: string; sourceEventId: string; completedAt: Date; durationMinutes: string | null; createdAt: Date; }
/** Re-completing a task on the same day replaces its contribution, not its evidence. */
export function trackerSourceValues(definition: TrackerDefinition, sources: TrackerSource[]): Record<string, TrackerValue> {
  const latest = new Map<string, TrackerSource>();
  for (const source of sources) {
    const id = source.taskIdentity, before = latest.get(id);
    if (!before || source.createdAt >= before.createdAt) latest.set(id, source);
  }
  const current = [...latest.values()], result: Record<string, TrackerValue> = {};
  for (const field of definition.fields) {
    if (field.source === 'manual') continue;
    if (!current.length) { result[field.id] = null; continue; }
    if (field.source === 'task_completed') result[field.id] = true;
    if (field.source === 'task_count') result[field.id] = current.length;
    if (field.source === 'task_duration') result[field.id] = current.some((s) => s.durationMinutes === null) ? null : current.reduce((sum, s) => sum + Number(s.durationMinutes), 0);
    if (field.source === 'task_completed_at') result[field.id] = new Date(Math.max(...current.map((s) => s.completedAt.getTime()))).toISOString();
  }
  return result;
}
export interface ScoredTrackerDay { day: string; stars: number | null; statusName: string | null; sourceCount?: number; }
/** Recording streaks, never a score threshold; restricted to the requested date range. */
export function personalTrackerStreaks(from:string,to:string,rows:ScoredTrackerDay[]){
  const days=[...new Set(rows.filter(r=>r.day>=from&&r.day<=to).map(r=>r.day))].sort();
  let longest=0,run=0,last:string|undefined;
  for(const day of days){run=last&&Date.parse(day)-Date.parse(last)===86400000?run+1:1;longest=Math.max(longest,run);last=day;}
  return {longest,current:last===to?run:0};
}
/** One persisted row per actual tracked day. No missing-day rows are fabricated. */
export function personalTrackerReport(startDate: string, from: string, to: string, rows: ScoredTrackerDay[]) {
  [startDate, from, to].forEach((day) => trackerDaySchema.parse(day));
  const start = from > startDate ? from : startDate;
  const calendarDays = Math.max(0, Math.floor((Date.parse(to) - Date.parse(start)) / 86400000) + 1);
  const actual = rows.filter((r) => r.day >= start && r.day <= to);
  if (new Set(actual.map((r) => r.day)).size !== actual.length) throw new Error('Tracker report requires one row per day');
  const totalStars = actual.reduce((sum, r) => sum + (r.stars ?? 0), 0), trackedDays = actual.length;
  const distribution: Record<string, number> = Object.create(null);
  for (const row of actual) distribution[row.statusName ?? 'Unmeasured'] = (distribution[row.statusName ?? 'Unmeasured'] ?? 0) + 1;
  function periods(kind: 'week' | 'month') {
    const groups = new Map<string, ScoredTrackerDay[]>();
    for (const row of actual) {
      const at = new Date(row.day + 'T00:00:00Z');
      if (kind === 'week') at.setUTCDate(at.getUTCDate() - (at.getUTCDay() + 6) % 7);
      const key = kind === 'week' ? at.toISOString().slice(0, 10) : row.day.slice(0, 7);
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([period, records]) => ({ period, totalStars: records.reduce((sum, r) => sum + (r.stars ?? 0), 0), trackedDays: records.length }));
  }
  const scored = actual.filter((r) => r.stars !== null);
  return { from: start, to, calendarDays, trackedDays, nonTrackingDays: calendarDays - trackedDays, totalStars,
    averageStars: calendarDays ? totalStars / calendarDays : null,
    relativeStars: trackedDays ? totalStars / trackedDays : null,
    completionRate: calendarDays ? trackedDays / calendarDays : null,
    unscoredDays: actual.filter((r) => r.stars === null).length,
    statusDistribution: distribution, trend: actual.slice().sort((a, b) => a.day.localeCompare(b.day)), weekly: periods('week'), monthly: periods('month'),
    bestDay: scored.length ? scored.reduce((best, r) => r.stars! > best.stars! ? r : best) : null,
    worstDay: scored.length ? scored.reduce((worst, r) => r.stars! < worst.stars! ? r : worst) : null,
    linkedTaskCompletions: actual.reduce((sum, r) => sum + (r.sourceCount ?? 0), 0),
  };
}

const columns: TrackerDefinition['columns'] = [
  { semantic: 'date', label: 'Date', visible: true }, { semantic: 'task', label: 'Linked task', visible: true },
  { semantic: 'input', label: 'Input / observation', visible: true }, { semantic: 'status', label: 'Status', visible: true },
  { semantic: 'stars', label: 'Stars', visible: true }, { semantic: 'notes', label: 'Notes', visible: true },
];
export function createTrackerDefinition(label = 'Observation', unit = '', thresholds = [30, 60, 90]): TrackerDefinition {
  return { columns: structuredClone(columns), fields: [{ id: 'input', label, type: 'number', source: 'manual', unit, options: [] }],
    statuses: [{ id: 'not_met', name: 'Not Met', stars: 0 }, { id: 'good', name: 'Good', stars: 2 }, { id: 'very_good', name: 'Very Good', stars: 3 }, { id: 'excellent', name: 'Excellent', stars: 5 }],
    defaultStatusId: 'not_met', rules: thresholds.map((threshold, i) => ({ id: `rule_${i}`, statusId: ['good', 'very_good', 'excellent'][i]!, match: 'all' as const, conditions: [{ fieldId: 'input', operator: 'gte' as const, value: threshold }] })).reverse() };
}
export function personalTrackerTemplates() {
  const examples: Array<[string, string, string, number[]]> = [
    ['exercise', 'Exercise', 'minutes', [30, 60, 90]], ['water', 'Water Intake', 'glasses', [4, 6, 8]],
    ['reading', 'Reading', 'pages', [5, 10, 20]], ['study', 'Study', 'minutes', [30, 60, 90]],
    ['sleep', 'Sleep', 'hours', [6, 7, 8]], ['meditation', 'Meditation', 'minutes', [5, 10, 20]],
    ['weight', 'Weight', 'kg', []], ['learning', 'Learning', 'lessons', [1, 2, 3]], ['finance', 'Finance', 'amount', []],
    ['mood', 'Mood', 'rating', [2, 3, 4]], ['custom', 'Custom Score', '', []],
  ];
  return examples.map(([id, name, unit, thresholds]) => {
    const definition = createTrackerDefinition(name, unit, thresholds);
    if (!thresholds.length) definition.defaultStatusId = null;
    return { id, name, description: 'Editable starting point. Thresholds are examples, not medical or financial advice.', definition };
  });
}
