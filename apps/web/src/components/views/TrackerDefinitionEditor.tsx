'use client';
import type { TrackerDefinition, TrackerField, TrackerValue } from '@nextdoo/contracts';

export function TrackerValueInput({ field, value, onChange, label, disabled = false }: { field: TrackerField; value: TrackerValue | undefined; onChange: (value: TrackerValue) => void; label: string; disabled?: boolean }) {
  if (field.type === 'checkbox') return <select aria-label={label} disabled={disabled} value={value === undefined || value === null ? '' : String(value)} onChange={(e) => onChange(e.target.value === '' ? null : e.target.value === 'true')}><option value="">Not entered</option><option value="true">Yes</option><option value="false">No</option></select>;
  if (field.type === 'select') return <select aria-label={label} disabled={disabled} value={String(value ?? '')} onChange={(e) => onChange(e.target.value || null)}><option value="">Not entered</option>{field.options.map((option) => <option key={option}>{option}</option>)}</select>;
  const local = field.type === 'datetime' && typeof value === 'string' && value ? new Date(new Date(value).getTime() - new Date(value).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : String(value ?? '');
  return <input aria-label={label} disabled={disabled} type={['number', 'duration'].includes(field.type) ? 'number' : field.type === 'datetime' ? 'datetime-local' : field.type === 'date' ? 'date' : 'text'}
    step={['number', 'duration'].includes(field.type) ? 'any' : undefined} maxLength={5000} value={local}
    onChange={(e) => onChange(e.target.value === '' ? null : ['number', 'duration'].includes(field.type) ? Number(e.target.value) : field.type === 'datetime' ? new Date(e.target.value).toISOString() : e.target.value)} />;
}
const nextId = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
const initialValue = (field: TrackerField): TrackerValue => field.type === 'checkbox' ? true : ['number', 'duration'].includes(field.type) ? 0 : field.type === 'date' ? new Date().toISOString().slice(0, 10) : field.type === 'datetime' ? new Date().toISOString() : field.type === 'select' ? field.options[0] ?? '' : '';

export function TrackerDefinitionEditor({ value, onChange }: { value: TrackerDefinition; onChange: (definition: TrackerDefinition) => void }) {
  function changeField(index: number, patch: Partial<TrackerField>) {
    if (patch.type === 'duration') patch = { ...patch, unit: 'minutes' };
    const fields = value.fields.map((field, i) => i === index ? { ...field, ...patch } : field);
    const changed = fields[index]!;
    const rules = patch.type || patch.source ? value.rules.map((r) => ({ ...r, conditions: r.conditions.map((c) => c.fieldId === changed.id ? { ...c, operator: 'eq' as const, value: initialValue(changed) } : c) })) : value.rules;
    onChange({ ...value, fields, rules });
  }
  return <div>
    <details><summary>Column headers</summary><p>Rename headers without changing what each column means.</p>{value.columns.map((c, i) => <div className="row" key={c.semantic}>
      <label>{c.semantic}<input aria-label={`${c.semantic} column name`} maxLength={80} required value={c.label} onChange={(e) => onChange({ ...value, columns: value.columns.map((old, at) => at === i ? { ...old, label: e.target.value } : old) })} /></label>
      <label><input type="checkbox" checked={c.visible} disabled={c.semantic === 'date'} onChange={(e) => onChange({ ...value, columns: value.columns.map((old, at) => at === i ? { ...old, visible: e.target.checked } : old) })} /> Visible</label></div>)}</details>
    <details><summary>Input fields</summary>{value.fields.map((field, index) => <fieldset key={field.id}><legend>{field.label || 'Input field'}</legend>
      <label>Field name<input aria-label={`Field ${index + 1} name`} required maxLength={80} value={field.label} onChange={(e) => changeField(index, { label: e.target.value })} /></label>
      <label>Data source<select aria-label={`Field ${index + 1} source`} value={field.source} onChange={(e) => { const source = e.target.value as TrackerField['source']; changeField(index, { source, ...(source === 'manual' ? {} : { type: source === 'task_completed' ? 'checkbox' : source === 'task_duration' ? 'duration' : source === 'task_completed_at' ? 'datetime' : 'number', unit: source === 'task_duration' ? 'minutes' : '' }) }); }}>
        <option value="manual">Manual observation</option><option value="task_completed">Task completed</option><option value="task_count">Completed task count</option><option value="task_duration">Task time spent (minutes)</option><option value="task_completed_at">Latest completion date/time</option></select></label>
      <label>Input type<select aria-label={`Field ${index + 1} type`} disabled={field.source !== 'manual'} value={field.type} onChange={(e) => changeField(index, { type: e.target.value as TrackerField['type'], options: e.target.value === 'select' ? ['Option 1', 'Option 2'] : [] })}>{['number', 'text', 'checkbox', 'select', 'duration', 'date', 'datetime'].map((type) => <option key={type}>{type}</option>)}</select></label>
      <label>Unit<input aria-label={`Field ${index + 1} unit`} disabled={field.type === 'duration'} maxLength={40} value={field.type === 'duration' ? 'minutes' : field.unit} onChange={(e) => changeField(index, { unit: e.target.value })} /></label>
      {field.type === 'select' && <label>Choices (one per line)<textarea aria-label={`Field ${index + 1} choices`} value={field.options.join('\n')} onChange={(e) => changeField(index, { options: e.target.value.split('\n') })} /></label>}
      <button type="button" disabled={value.fields.length === 1} onClick={() => onChange({ ...value, fields: value.fields.filter((f) => f.id !== field.id), rules: value.rules.map((r) => ({ ...r, conditions: r.conditions.filter((c) => c.fieldId !== field.id) })).filter((r) => r.conditions.length) })}>Remove field</button>
    </fieldset>)}<button type="button" disabled={value.fields.length >= 20} onClick={() => onChange({ ...value, fields: [...value.fields, { id: nextId('field'), label: 'New input', type: 'number', source: 'manual', unit: '', options: [] }] })}>Add input field</button></details>
    <details><summary>Statuses and star scores</summary>{value.statuses.map((status, index) => <div className="row" key={status.id}><label>Status name<input aria-label={`Status ${index + 1} name`} required maxLength={80} value={status.name} onChange={(e) => onChange({ ...value, statuses: value.statuses.map((s) => s.id === status.id ? { ...s, name: e.target.value } : s) })} /></label>
      <label>Stars<select aria-label={`Status ${index + 1} stars`} value={status.stars} onChange={(e) => onChange({ ...value, statuses: value.statuses.map((s) => s.id === status.id ? { ...s, stars: Number(e.target.value) } : s) })}>{[0, 1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
      <button type="button" disabled={value.statuses.length === 1} onClick={() => onChange({ ...value, statuses: value.statuses.filter((s) => s.id !== status.id), rules: value.rules.filter((r) => r.statusId !== status.id), defaultStatusId: value.defaultStatusId === status.id ? null : value.defaultStatusId })}>Remove status</button></div>)}
      <button type="button" disabled={value.statuses.length >= 20} onClick={() => onChange({ ...value, statuses: [...value.statuses, { id: nextId('status'), name: 'New status', stars: 0 }] })}>Add status</button>
      <label>When no rule matches<select aria-label="Default status" value={value.defaultStatusId ?? ''} onChange={(e) => onChange({ ...value, defaultStatusId: e.target.value || null })}><option value="">Unmeasured</option>{value.statuses.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label></details>
    <details><summary>Conditions</summary><p>Rules run from top to bottom. The first match determines the status and stars. Missing required inputs remain unmeasured.</p>
      {value.rules.map((rule, index) => <fieldset key={rule.id}><legend>Rule {index + 1}</legend><label>Match<select aria-label={`Rule ${index + 1} match`} value={rule.match} onChange={(e) => onChange({ ...value, rules: value.rules.map((r) => r.id === rule.id ? { ...r, match: e.target.value as 'all' | 'any' } : r) })}><option value="all">All conditions</option><option value="any">Any condition</option></select></label>
        {rule.conditions.map((condition, at) => {
          const field = value.fields.find((f) => f.id === condition.fieldId)!;
          const change = (patch: Partial<typeof condition>) => onChange({ ...value, rules: value.rules.map((r) => r.id === rule.id ? { ...r, conditions: r.conditions.map((c, i) => i === at ? { ...c, ...patch } : c) } : r) });
          return <div className="card" key={at}><label>Input<select aria-label={`Rule ${index + 1} condition ${at + 1} field`} value={condition.fieldId} onChange={(e) => { const f = value.fields.find((item) => item.id === e.target.value)!; change({ fieldId: f.id, operator: 'eq', value: initialValue(f) }); }}>{value.fields.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}</select></label>
            <label>Comparison<select aria-label={`Rule ${index + 1} condition ${at + 1} operator`} value={condition.operator} onChange={(e) => change({ operator: e.target.value as typeof condition.operator })}>{[['eq', 'equals'], ['neq', 'does not equal'], ...(['number', 'duration', 'date', 'datetime'].includes(field.type) ? [['gt', 'greater than'], ['gte', 'at least'], ['lt', 'less than'], ['lte', 'at most']] : field.type === 'text' ? [['contains', 'contains']] : [])].map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
            <TrackerValueInput field={field} value={condition.value} label={`Rule ${index + 1} condition ${at + 1} value`} onChange={(v) => change({ value: v })} />
            <button type="button" disabled={rule.conditions.length === 1} onClick={() => onChange({ ...value, rules: value.rules.map((r) => r.id === rule.id ? { ...r, conditions: r.conditions.filter((_, i) => i !== at) } : r) })}>Remove condition</button></div>;
        })}
        <button type="button" disabled={rule.conditions.length >= 10} onClick={() => onChange({ ...value, rules: value.rules.map((r) => r.id === rule.id ? { ...r, conditions: [...r.conditions, { fieldId: value.fields[0]!.id, operator: 'eq', value: initialValue(value.fields[0]!) }] } : r) })}>Add condition</button>
        <label>Resulting status<select aria-label={`Rule ${index + 1} status`} value={rule.statusId} onChange={(e) => onChange({ ...value, rules: value.rules.map((r) => r.id === rule.id ? { ...r, statusId: e.target.value } : r) })}>{value.statuses.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.stars} stars</option>)}</select></label>
        <button type="button" disabled={index === 0} onClick={() => { const rules = [...value.rules]; [rules[index - 1], rules[index]] = [rules[index]!, rules[index - 1]!]; onChange({ ...value, rules }); }}>Move rule up</button>
        <button type="button" onClick={() => onChange({ ...value, rules: value.rules.filter((r) => r.id !== rule.id) })}>Remove rule</button>
      </fieldset>)}<button type="button" disabled={value.rules.length >= 30} onClick={() => onChange({ ...value, rules: [...value.rules, { id: nextId('rule'), statusId: value.statuses[0]!.id, match: 'all', conditions: [{ fieldId: value.fields[0]!.id, operator: 'eq', value: initialValue(value.fields[0]!) }] }] })}>Add rule</button>
    </details>
  </div>;
}
