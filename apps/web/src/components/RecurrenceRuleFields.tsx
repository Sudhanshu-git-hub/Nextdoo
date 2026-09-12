'use client';
import { recurrenceRuleSchema, type RecurrenceRuleInput } from '@nextdoo/contracts';
export interface RuleDraft { freq: RecurrenceRuleInput['freq']; interval: string; zone: string; weekdays: number[]; monthDay: string; end: string; count: string; until: string }
export const ruleDraft = (rule?: RecurrenceRuleInput): RuleDraft => ({ freq: rule?.freq ?? 'DAILY', interval: String(rule?.interval ?? 1), zone: rule?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, weekdays: rule?.byWeekday ?? [], monthDay: rule?.byMonthDay?.toString() ?? '', end: rule?.count ? 'count' : rule?.until ? 'until' : 'never', count: String(rule?.count ?? 10), until: rule?.until ?? '' });
export function parseRule(d: RuleDraft) {
 return recurrenceRuleSchema.parse({ freq: d.freq, interval: Number(d.interval), timeZone: d.zone,
  ...(d.freq === 'WEEKLY' && d.weekdays.length ? { byWeekday: [...d.weekdays].sort() } : {}),
  ...(d.freq === 'MONTHLY' && d.monthDay ? { byMonthDay: Number(d.monthDay) } : {}),
  ...(d.end === 'count' ? { count: Number(d.count) } : d.end === 'until' ? { until: d.until } : {}) });
}
export function RecurrenceRuleFields({ draft, onChange, prefix }: { draft: RuleDraft; onChange: (draft: RuleDraft) => void; prefix: string }) {
 const set = <K extends keyof RuleDraft>(key: K, value: RuleDraft[K]) => onChange({ ...draft, [key]: value });
 return <>
  <div className="task-filter-grid">
   <div><label htmlFor={`${prefix}-frequency`}>Repeat</label><select id={`${prefix}-frequency`} value={draft.freq} onChange={(e) => set('freq', e.target.value as RuleDraft['freq'])}><option value="DAILY">Daily</option><option value="WEEKLY">Weekly</option><option value="MONTHLY">Monthly</option></select></div>
   <div><label htmlFor={`${prefix}-interval`}>Interval</label><input id={`${prefix}-interval`} type="number" min={1} max={365} required value={draft.interval} onChange={(e) => set('interval', e.target.value)} /></div>
   <div><label htmlFor={`${prefix}-zone`}>Recurrence time zone</label><input id={`${prefix}-zone`} required value={draft.zone} onChange={(e) => set('zone', e.target.value)} placeholder="Asia/Kolkata" /></div>
   <div><label htmlFor={`${prefix}-end`}>End condition</label><select id={`${prefix}-end`} value={draft.end} onChange={(e) => set('end', e.target.value)}><option value="never">No end</option><option value="count">Occurrence count</option><option value="until">End instant</option></select></div>
   {draft.end === 'count' && <div><label htmlFor={`${prefix}-count`}>Occurrence count</label><input id={`${prefix}-count`} type="number" min={1} max={1000} required value={draft.count} onChange={(e) => set('count', e.target.value)} /></div>}
   {draft.end === 'until' && <div><label htmlFor={`${prefix}-until`}>End instant (ISO with offset)</label><input id={`${prefix}-until`} required value={draft.until} onChange={(e) => set('until', e.target.value)} placeholder="2026-12-31T23:59:59+05:30" /></div>}
   {draft.freq === 'MONTHLY' && <div><label htmlFor={`${prefix}-month`}>Monthly day (optional)</label><input id={`${prefix}-month`} type="number" min={1} max={31} value={draft.monthDay} onChange={(e) => set('monthDay', e.target.value)} /></div>}
  </div>
  {draft.freq === 'WEEKLY' && <fieldset><legend>Weekdays (none selected uses the first date’s weekday)</legend><div className="row">{['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((day, i) => <label className="bulk-selection" key={day}><input type="checkbox" checked={draft.weekdays.includes(i)} onChange={(e) => set('weekdays', e.target.checked ? [...draft.weekdays, i] : draft.weekdays.filter((d) => d !== i))} />{day}</label>)}</div></fieldset>}
  <p className="muted">Daily intervals use calendar days; monthly dates clamp to the last day in shorter months. Missing clock times shift forward by the gap; repeated times run once at the earlier instant.</p>
 </>;
}
