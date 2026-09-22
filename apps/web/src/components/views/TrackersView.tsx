'use client';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { TrackerDefinition, TrackerValue } from '@nextdoo/contracts';
import { createTrackerDefinition, trackerDate } from '@nextdoo/core/personal-tracker';
import { api, ApiError, type Task } from '@/lib/api';
import { useTaskPages } from '@/lib/use-task-pages';
import { TaskPagination } from '@/components/TaskPagination';
import { TaskEditor } from '@/components/TaskEditor';
import { TrackerDefinitionEditor, TrackerValueInput } from './TrackerDefinitionEditor';

interface Delivery { enabled: boolean; channel: 'EMAIL' | 'WHATSAPP' | 'TELEGRAM'; dayOfMonth: number; hour: number; minute: number; }
interface Tracker { id: string; name: string; description: string | null; startDate: string; timeZone: string; goalId: string | null; frequency: 'DAILY' | 'WEEKLY' | 'CUSTOM'; state: 'ACTIVE' | 'PAUSED' | 'ARCHIVED'; definition: TrackerDefinition; delivery: Delivery; version: number; }
interface Entry { id: string; day: string; definition: TrackerDefinition; inputValues: Record<string, TrackerValue>; notes: string | null; statusName: string | null; stars: number | null; missingFields: string[]; version: number; deletedAt: string | null; sources: Array<{ taskId: string | null; title: string | null; completedAt: string; durationMinutes: string | null }>; }
interface Report { calendarDays: number; trackedDays: number; nonTrackingDays: number; totalStars: number; averageStars: number | null; relativeStars: number | null; completionRate: number | null; unscoredDays: number; statusDistribution: Record<string, number>; trend: Array<{ day: string; stars: number | null; statusName: string | null }>; weekly: Array<{ period: string; totalStars: number; trackedDays: number }>; monthly: Array<{ period: string; totalStars: number; trackedDays: number }>; bestDay: { day: string; stars: number } | null; worstDay: { day: string; stars: number } | null; linkedTaskCompletions: number; }
interface Detail { tracker: Tracker; goal: { id: string; title: string } | null; entries: Entry[]; nextCursor: string | null; report: Report; links: Array<{ taskId: string; title: string; status: string }>; deliveries: Array<{ id: string; period: string; channel: string; status: string; reason: string | null }>; deliveryCapabilities: Record<string, boolean>; }
interface Template { id: string; name: string; description: string; definition: TrackerDefinition; }
const message = (e: unknown) => e instanceof ApiError ? e.message : 'Could not reach the server. Your draft is kept; retry when connected.';
const today = () => { const at = new Date(); return new Date(at.getTime() - at.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const format = (value: number | null) => value === null ? 'Not measured' : value.toFixed(2);
function useCommand() {
  const identity = useRef({ body: '', key: '' }), locked = useRef(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [conflict, setConflict] = useState(false);
  async function send<T>(path: string, body: object, method = 'POST'): Promise<T | null> {
    if (locked.current) return null;
    locked.current = true; setBusy(true); setError(null); setConflict(false);
    const encoded = JSON.stringify(body), command = method + path + encoded;
    if (identity.current.body !== command) identity.current = { body: command, key: crypto.randomUUID() };
    try { const result = await api<T>(path, { method, body: encoded, headers: { 'Idempotency-Key': identity.current.key } }); identity.current.body = ''; return result; }
    catch (e) { setError(message(e)); setConflict(e instanceof ApiError && e.isConflict); return null; } finally { locked.current = false; setBusy(false); }
  }
  return { send, busy, error, conflict, clear: () => { setError(null); setConflict(false); } };
}

export function TrackersView({ workspaceId }: { workspaceId: string }) {
  const [rows, setRows] = useState<Tracker[]>([]), [cursor, setCursor] = useState<string | null>(null), [archived, setArchived] = useState(false);
  const [loading, setLoading] = useState(true), [error, setError] = useState<string | null>(null), [create, setCreate] = useState(false), [template, setTemplate] = useState<Template | null>(null), [showTemplates, setShowTemplates] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const load = useCallback(async (after?: string) => {
    abort.current?.abort(); const request = new AbortController(); abort.current = request; setLoading(true);
    try { const p = await api<{ data: Tracker[]; nextCursor: string | null }>(`/trackers?includeArchived=${archived}${after ? `&after=${after}` : ''}`, { signal: request.signal });
      if (!request.signal.aborted) { setRows((old) => after ? [...old, ...p.data] : p.data); setCursor(p.nextCursor); setError(null); }
    } catch (e) { if (!request.signal.aborted) setError(message(e)); } finally { if (!request.signal.aborted) setLoading(false); }
  }, [archived]);
  useEffect(() => { void load(); return () => abort.current?.abort(); }, [load]);
  return <div className="goals-view tracker-view"><h1>Tracker</h1><p>Your tracking tables, conditions, stars and reports.</p>
    <div className="row"><button className="btn-primary" onClick={() => { setTemplate(null); setCreate(true); }}>New Tracker</button><button onClick={() => setShowTemplates((v) => !v)}>Templates</button></div>
    {showTemplates && <TemplateBrowser useTemplate={(t) => { setTemplate(t); setCreate(true); setShowTemplates(false); }} />}
    {create && <><TrackerSettings key={template?.id ?? 'new'} workspaceId={workspaceId} template={template ?? undefined} onSaved={() => { setCreate(false); void load(); }} /><button onClick={() => setCreate(false)}>Cancel new tracker</button></>}
    <label><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Include archived trackers</label><button disabled={loading} onClick={() => void load()}>Refresh trackers</button>
    {loading && <p role="status">Loading trackers…</p>}{error && <p role="alert">{error}</p>}{!loading && !rows.length && !error && <p>No trackers yet. Create a table or start from a template.</p>}
    <div className="grid grid-2">{rows.map((r) => <article className="card" key={r.id}><h2><Link href={`/trackers/${r.id}`}>{r.name}</Link></h2><p>{r.description}</p><p>Tracking since {r.startDate} · {r.state.toLowerCase()}</p></article>)}</div>
    {cursor && <button disabled={loading} onClick={() => void load(cursor)}>Load more trackers</button>}
  </div>;
}

function TemplateBrowser({ useTemplate }: { useTemplate: (t: Template) => void }) {
  const [templates, setTemplates] = useState<Template[]>([]), [error, setError] = useState<string | null>(null), [preview, setPreview] = useState<Template | null>(null);
  const load = useCallback(() => { void api<Template[]>('/trackers/templates').then(setTemplates).catch((e) => setError(message(e))); }, []);
  useEffect(load, [load]);
  function download(t: Template) { const url = URL.createObjectURL(new Blob([JSON.stringify(t, null, 2)], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = `${t.id}-tracker-template.json`; a.click(); URL.revokeObjectURL(url); }
  return <section aria-label="Tracker templates"><h2>Templates</h2><p>Using a template creates your own editable copy.</p>{error && <p role="alert">{error} <button onClick={load}>Retry templates</button></p>}<div className="grid grid-2">{templates.map((t) => <article className="card" key={t.id}><h3>{t.name}</h3><button onClick={() => setPreview(t)}>Preview {t.name}</button></article>)}</div>
    {preview && <article className="card" aria-label="Template preview"><h3>{preview.name}</h3><p>{preview.description}</p><p>{preview.definition.columns.map((c) => c.label).join(' · ')}</p><p>Inputs: {preview.definition.fields.map((f) => `${f.label} (${f.type}${f.unit ? ', ' + f.unit : ''})`).join(', ')}</p><ul>{preview.definition.rules.map((r) => <li key={r.id}>{r.conditions.map((c) => `${preview.definition.fields.find((f) => f.id === c.fieldId)?.label} ${c.operator} ${c.value}`).join(' and ')} → {preview.definition.statuses.find((s) => s.id === r.statusId)?.name}</li>)}</ul><button onClick={() => useTemplate(preview)}>Use {preview.name}</button><button onClick={() => download(preview)}>Download template</button></article>}
  </section>;
}
function GoalSelect({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const [rows, setRows] = useState<Array<{ id: string; title: string; identifier: string }>>([]), [cursor, setCursor] = useState<string | null>(null), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const load = useCallback(async (after?: string) => { setBusy(true); try { const p = await api<{ data: Array<{ goal: { id: string; title: string; identifier: string } }>; nextCursor: string | null }>(`/goals?includeArchived=true${after ? `&after=${after}` : ''}`); setRows((old) => after ? [...old, ...p.data.map((r) => r.goal)] : p.data.map((r) => r.goal)); setCursor(p.nextCursor); setError(null); } catch (e) { setError(message(e)); } finally { setBusy(false); } }, []);
  useEffect(() => { void load(); }, [load]);
  return <><label>Related goal<select aria-label="Related goal" value={value} onChange={(e) => onChange(e.target.value)}><option value="">No goal</option>{value && !rows.some((r) => r.id === value) && <option value={value}>Current goal (kept)</option>}{rows.map((r) => <option key={r.id} value={r.id}>{r.identifier} · {r.title}</option>)}</select></label>{cursor && <button type="button" disabled={busy} onClick={() => void load(cursor)}>More goals</button>}{error && <p role="alert">{error} <button type="button" onClick={() => void load()}>Retry goals</button></p>}</>;
}

function TrackerSettings({ workspaceId, initial, template, onSaved }: { workspaceId: string; initial?: Tracker; template?: Template; onSaved: () => void }) {
  const [base] = useState(initial), [name, setName] = useState(initial?.name ?? template?.name ?? ''), [description, setDescription] = useState(initial?.description ?? ''), [startDate, setStartDate] = useState(initial?.startDate ?? today());
  const [definition, setDefinition] = useState(() => structuredClone(initial?.definition ?? template?.definition ?? createTrackerDefinition())), [goalId, setGoalId] = useState(initial?.goalId ?? ''), [frequency, setFrequency] = useState(initial?.frequency ?? 'DAILY');
  const [delivery, setDelivery] = useState<Delivery>(initial?.delivery ?? { enabled: false, channel: 'EMAIL', dayOfMonth: 1, hour: 9, minute: 0 }), [version, setVersion] = useState(initial?.version ?? 1), [latest, setLatest] = useState<Tracker | null>(null), [reviewError, setReviewError] = useState<string | null>(null);
  const command = useCommand();
  async function submit(e: React.FormEvent) {
    e.preventDefault(); const fields = { name, description: description || null, startDate, goalId: goalId || null, frequency, definition, delivery };
    const patch = base ? Object.fromEntries(Object.entries(fields).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(base[k as keyof Tracker]))) : fields;
    if (initial && !Object.keys(patch).length) { setReviewError('Change a setting before saving.'); return; }
    const body = initial ? { ...patch, version } : { ...fields, workspaceId, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
    if (await command.send(initial ? `/trackers/${initial.id}` : '/trackers', body, initial ? 'PATCH' : 'POST')) onSaved();
  }
  async function review() { if (!initial) return; try { const d = await api<Detail>(`/trackers/${initial.id}?from=${initial.startDate}&to=${trackerDate(new Date(), initial.timeZone)}`); setLatest(d.tracker); setReviewError(null); } catch (e) { setReviewError(message(e)); } }
  return <form className="card" aria-label={initial ? 'Tracker settings' : 'New tracker'} onSubmit={(e) => void submit(e)}><h2>{initial ? 'Tracker settings' : 'Create tracking table'}</h2><fieldset disabled={command.busy} style={{ border: 0, padding: 0 }}>
    <label>Tracker name<input aria-label="Tracker name" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} /></label><label>Description<textarea aria-label="Tracker description" maxLength={10000} value={description} onChange={(e) => setDescription(e.target.value)} /></label>
    <label>Tracking start date<input aria-label="Tracking start date" required type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></label><label>Frequency<select aria-label="Tracking frequency" value={frequency} onChange={(e) => setFrequency(e.target.value as Tracker['frequency'])}><option value="DAILY">Daily</option><option value="WEEKLY">Weekly</option><option value="CUSTOM">Custom</option></select></label>
    <p className="muted">Frequency describes your routine. Average stars always uses calendar days; relative stars uses tracked days. Dates use {initial?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone}.</p><GoalSelect value={goalId} onChange={setGoalId} />
    <TrackerDefinitionEditor value={definition} onChange={setDefinition} />
    <details><summary>Monthly report delivery</summary><label><input type="checkbox" checked={delivery.enabled} onChange={(e) => setDelivery({ ...delivery, enabled: e.target.checked })} /> Enable monthly reports</label>
      <label>Channel<select aria-label="Report channel" value={delivery.channel} onChange={(e) => setDelivery({ ...delivery, channel: e.target.value as Delivery['channel'] })}><option value="EMAIL">Email</option><option value="WHATSAPP">WhatsApp (provider unavailable)</option><option value="TELEGRAM">Telegram (provider unavailable)</option></select></label>
      <label>Day of month<input aria-label="Report day of month" type="number" min="1" max="28" required value={delivery.dayOfMonth} onChange={(e) => setDelivery({ ...delivery, dayOfMonth: Number(e.target.value) })} /></label><label>Local delivery time<input aria-label="Report delivery time" type="time" required value={`${String(delivery.hour).padStart(2, '0')}:${String(delivery.minute).padStart(2, '0')}`} onChange={(e) => { const [hour, minute] = e.target.value.split(':').map(Number); setDelivery({ ...delivery, hour: hour!, minute: minute! }); }} /></label>
      <p>Reports summarize the previous calendar month. Email requires configured SMTP. WhatsApp and Telegram settings are saved, but delivery remains blocked until a supported provider exists.</p></details>
    <p className="muted">Existing records keep their saved fields, rules and scores. Definition changes apply to new days. Editing requires an internet connection.</p>
    {command.error && <p role="alert">{command.error} Your draft is kept.</p>}{reviewError && <p role="alert">{reviewError}</p>}{command.conflict && <button type="button" onClick={() => void review()}>Review latest settings</button>}
    {latest && <div className="banner"><p>Latest: {latest.name}, version {latest.version}. {latest.definition.fields.length} inputs and {latest.definition.rules.length} rules. {latest.description}</p><p>Applying your draft replaces the settings you changed, including the whole definition if you edited it.</p><button type="button" onClick={() => { setVersion(latest.version); setLatest(null); command.clear(); }}>Use latest version and keep draft</button></div>}
    <button className="btn-primary" type="submit" disabled={command.conflict || !name.trim()}>{initial ? 'Save settings' : 'Create tracker'}</button>
  </fieldset></form>;
}

export function TrackerDetailView({ workspaceId, id }: { workspaceId: string; id: string }) {
  const [detail, setDetail] = useState<Detail | null>(null), [error, setError] = useState<string | null>(null), [loading, setLoading] = useState(true), [settings, setSettings] = useState(false), [report, setReport] = useState(false), [linking, setLinking] = useState(false);
  const [from, setFrom] = useState(''), [to, setTo] = useState(today()), [range, setRange] = useState<{ from: string; to: string } | null>(null), [editEntry, setEditEntry] = useState<Entry | null>(null), [newEntry, setNewEntry] = useState(false), [task, setTask] = useState<Task | null>(null);
  const [showDeleted, setShowDeleted] = useState(false), command = useCommand(), controller = useRef<AbortController | null>(null);
  const load = useCallback(async (after?: string) => {
    controller.current?.abort(); const request = new AbortController(); controller.current = request; setLoading(true);
    try {
      const d = await api<Detail>(`/trackers/${id}${range ? `?from=${range.from}&to=${range.to}${after ? `&after=${after}` : ''}` : ''}`, { signal: request.signal });
      if (!request.signal.aborted) { setDetail((old) => after && old ? { ...d, entries: [...old.entries, ...d.entries] } : d); setError(null); if (!range) { const currentDay = trackerDate(new Date(), d.tracker.timeZone); const actual = { from: d.tracker.startDate > currentDay ? currentDay : d.tracker.startDate, to: currentDay }; setFrom(actual.from); setTo(actual.to); setRange(actual); } }
    } catch (e) { if (!request.signal.aborted) setError(message(e)); } finally { if (!request.signal.aborted) setLoading(false); }
  }, [id, range]);
  useEffect(() => { void load(); return () => controller.current?.abort(); }, [load]);
  useEffect(() => { const timer = setInterval(() => { if (document.visibilityState === 'visible' && !settings && !editEntry && !newEntry) void load(); }, 10000); return () => clearInterval(timer); }, [load, settings, editEntry, newEntry]);
  async function state(value: Tracker['state']) { if (detail && await command.send(`/trackers/${id}`, { version: detail.tracker.version, state: value }, 'PATCH')) void load(); }
  async function remove(row: Entry) { if (window.confirm('Delete this tracking day? It will be excluded from reports until restored.') && await command.send(`/tracker-entries/${row.id}`, { version: row.version }, 'DELETE')) void load(); }
  async function restore(row: Entry) { if (await command.send(`/tracker-entries/${row.id}/restore`, { version: row.version })) void load(); }
  async function link(taskId: string, linked: boolean) { if (detail && await command.send(`/trackers/${id}/tasks`, { version: detail.tracker.version, taskId, linked })) void load(); }
  async function openTask(taskId: string) { try { setTask(await api<Task>(`/tasks/${taskId}`)); } catch (e) { setError(message(e)); } }
  const currentStatus = detail?.report.trend.at(-1)?.statusName ?? 'Not measured';
  return <div className="goals-view tracker-view"><Link href="/trackers">Back to trackers</Link>{loading && <p role="status">Loading tracker…</p>}{error && <p role="alert">{error}</p>}<button disabled={loading} onClick={() => void load()}>Refresh tracker</button>
    {detail && <><h1>{detail.tracker.name}</h1><p>{detail.tracker.description}</p>{detail.goal && <Link href={`/goals/${detail.goal.id}`}>Goal: {detail.goal.title}</Link>}
      <div className="grid grid-2" aria-label="Tracker summary">{[['Total Stars', detail.report.totalStars], ['Average Stars', format(detail.report.averageStars)], ['Relative Stars', format(detail.report.relativeStars)], ['Tracked Days', detail.report.trackedDays], ['Current Status', currentStatus]].map(([label, value]) => <div className="card" key={label}><strong>{label}</strong><p>{value}</p></div>)}</div>
      <p>{detail.tracker.state.toLowerCase()} · One scored record per tracked day · Time zone: {detail.tracker.timeZone}</p>
      <div className="row"><button disabled={detail.tracker.state !== 'ACTIVE'} onClick={() => { setNewEntry(true); setEditEntry(null); }}>New Entry</button><button onClick={() => setSettings((v) => !v)}>Conditions, Scoring & Settings</button><button onClick={() => setReport((v) => !v)}>Report</button><button onClick={() => setLinking((v) => !v)}>Linked Tasks</button>
        {detail.tracker.state === 'ACTIVE' ? <button disabled={command.busy} onClick={() => void state('PAUSED')}>Pause tracker</button> : <button disabled={command.busy} onClick={() => void state('ACTIVE')}>{detail.tracker.state === 'ARCHIVED' ? 'Restore tracker' : 'Resume tracker'}</button>}{detail.tracker.state !== 'ARCHIVED' && <button disabled={command.busy} onClick={() => void state('ARCHIVED')}>Archive tracker</button>}</div>
      {command.error && <p role="alert">{command.error} Refresh to review current data.</p>}
      {settings && <TrackerSettings workspaceId={workspaceId} initial={detail.tracker} onSaved={() => { setSettings(false); void load(); }} />}
      {linking && <section className="card" aria-label="Linked tasks"><h2>Linked Tasks</h2><p>New completions feed this tracker while active. Task-derived inputs are configured in Settings. Existing task history is preserved; paused periods are not backfilled.</p><ul>{detail.links.map((l) => <li key={l.taskId}><button onClick={() => void openTask(l.taskId)}>{l.title}</button><button disabled={command.busy} onClick={() => void link(l.taskId, false)}>Unlink {l.title}</button></li>)}</ul>{detail.tracker.state === 'ACTIVE' && <TaskChoices workspaceId={workspaceId} linked={detail.links.map((l) => l.taskId)} choose={(t) => void link(t.id, true)} />}</section>}
      {(newEntry || editEntry) && <><EntryForm key={editEntry?.id ?? 'new'} tracker={detail.tracker} initial={editEntry ?? undefined} onSaved={() => { setNewEntry(false); setEditEntry(null); void load(); }} /><button onClick={() => { setNewEntry(false); setEditEntry(null); }}>Cancel entry edit</button></>}
      <form className="row" aria-label="Report range" onSubmit={(e) => { e.preventDefault(); setRange({ from, to }); }}><label>From<input aria-label="Report from" type="date" required value={from} onChange={(e) => setFrom(e.target.value)} /></label><label>Through<input aria-label="Report through" type="date" required min={from} value={to} onChange={(e) => setTo(e.target.value)} /></label><button>Apply range</button></form>
      <label><input type="checkbox" checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)} /> Show deleted records</label>
      <div className="tracker-table-wrap"><table><caption>Tracking records</caption><thead><tr>{detail.tracker.definition.columns.filter((c) => c.visible).map((c) => <th key={c.semantic} scope="col">{c.label}</th>)}<th scope="col">Actions</th></tr></thead><tbody>{detail.entries.filter((r) => showDeleted || !r.deletedAt).map((row) => <tr key={row.id}>{detail.tracker.definition.columns.filter((c) => c.visible).map((c) => <td key={c.semantic}>
        {c.semantic === 'date' ? row.day : c.semantic === 'task' ? row.sources.length ? row.sources.map((s, i) => <div key={i}>{s.taskId && s.title ? <button onClick={() => void openTask(s.taskId!)}>{s.title}</button> : 'Removed task'}</div>) : 'Manual' : c.semantic === 'input' ? row.definition.fields.map((f) => <div key={f.id}>{f.label}: {row.inputValues[f.id] === null || row.inputValues[f.id] === undefined ? 'Not entered' : String(row.inputValues[f.id])}{f.unit ? ` ${f.unit}` : ''}</div>) : c.semantic === 'status' ? row.deletedAt ? 'Deleted' : row.statusName ?? 'Unmeasured' : c.semantic === 'stars' ? <span aria-label={row.stars === null ? 'Unmeasured stars' : `${row.stars} out of 5 stars`}>{row.stars === null ? '—' : '★'.repeat(row.stars) + '☆'.repeat(5 - row.stars)}</span> : row.notes}
      </td>)}<td>{row.deletedAt ? <button disabled={command.busy || detail.tracker.state !== 'ACTIVE'} onClick={() => void restore(row)}>Restore record</button> : <><button disabled={detail.tracker.state !== 'ACTIVE'} onClick={() => { setEditEntry(row); setNewEntry(false); }}>Edit record</button><button disabled={command.busy} onClick={() => void remove(row)}>Delete record</button></>}</td></tr>)}</tbody></table></div>
      {!detail.entries.length && <p>No records in this range. Missing days are not fabricated as rows.</p>}{detail.nextCursor && <button disabled={loading} onClick={() => void load(detail.nextCursor!)}>Load more records</button>}
      {report && <TrackerReport detail={detail} />}
    </>}{task && <TaskEditor task={task} onClose={() => { setTask(null); void load(); }} onSaved={() => void load()} />}</div>;
}

function TrackerReport({ detail }: { detail: Detail }) {
  const r = detail.report;
  return <section className="card" aria-label="Tracker report"><h2>Report: {detail.tracker.name}</h2><p>Total stars: {r.totalStars}. Average: {format(r.averageStars)} = total ÷ {r.calendarDays} calendar days. Relative: {format(r.relativeStars)} = total ÷ {r.trackedDays} tracked days.</p><p>{r.nonTrackingDays} non-tracking days · {r.unscoredDays} tracked days without a score · Tracking completion rate: {r.completionRate === null ? 'Not measured' : `${(r.completionRate * 100).toFixed(1)}%`}.</p>
    <h3>Daily star trend</h3><p>Only actual tracking days are shown. Gaps count in calendar averages.</p><div className="tracker-trend">{r.trend.map((d) => <div key={d.day}><span>{d.day}</span> <meter min="0" max="5" value={d.stars ?? 0} aria-label={`${d.day}: ${d.stars === null ? 'unmeasured' : d.stars + ' stars'}`} /> <span>{d.stars ?? 'Unmeasured'}</span></div>)}</div>
    <h3>Status distribution</h3><ul>{Object.entries(r.statusDistribution).map(([status, count]) => <li key={status}>{status}: {count}</li>)}</ul>
    <h3>Weekly performance</h3><ul>{r.weekly.map((p) => <li key={p.period}>Week of {p.period}: {p.totalStars} stars across {p.trackedDays} tracked days</li>)}</ul><h3>Monthly performance</h3><ul>{r.monthly.map((p) => <li key={p.period}>{p.period}: {p.totalStars} stars across {p.trackedDays} tracked days</li>)}</ul>
    <p>Best scored day: {r.bestDay ? `${r.bestDay.day} (${r.bestDay.stars} stars)` : 'Not measured'}. Worst scored day: {r.worstDay ? `${r.worstDay.day} (${r.worstDay.stars} stars)` : 'Not measured'}.</p><p>{r.linkedTaskCompletions} linked task/day contributions. Task execution scores are unchanged.</p>
    <h3>Monthly delivery</h3><p>Email: {detail.deliveryCapabilities.EMAIL ? 'SMTP configured; delivery results below' : 'not configured'}. WhatsApp and Telegram: provider unavailable.</p>{!detail.deliveries.length && <p>No scheduled reports yet.</p>}<ul>{detail.deliveries.map((d) => <li key={d.id}>{d.period} · {d.channel} · {d.status.toLowerCase()}{d.reason ? ` · ${d.reason === 'SMTP_NOT_CONFIGURED' ? 'SMTP not configured' : d.reason === 'PROVIDER_NOT_IMPLEMENTED' ? 'Provider unavailable' : 'Delivery needs attention'}` : ''}</li>)}</ul>
  </section>;
}
function EntryForm({ tracker, initial, onSaved }: { tracker: Tracker; initial?: Entry; onSaved: () => void }) {
  const definition = initial?.definition ?? tracker.definition, command = useCommand();
  const [day, setDay] = useState(initial?.day ?? trackerDate(new Date(), tracker.timeZone)), [values, setValues] = useState<Record<string, TrackerValue>>(() => Object.fromEntries(Object.entries(initial?.inputValues ?? {}).filter(([id]) => definition.fields.find((f) => f.id === id)?.source === 'manual'))), [notes, setNotes] = useState(initial?.notes ?? '');
  async function submit(e: React.FormEvent) { e.preventDefault(); if (await command.send(initial ? `/tracker-entries/${initial.id}` : `/trackers/${tracker.id}/entries`, { day, values, notes: notes || null, ...(initial ? { version: initial.version } : {}) }, initial ? 'PATCH' : 'POST')) onSaved(); }
  return <form className="card" aria-label={initial ? 'Edit tracking record' : 'New tracking record'} onSubmit={(e) => void submit(e)}><h2>{initial ? 'Edit record' : 'New Entry'}</h2><fieldset disabled={command.busy} style={{ border: 0, padding: 0 }}>
    <label>Tracking date<input aria-label="Tracking date" type="date" required disabled={Boolean(initial)} min={tracker.startDate} value={day} onChange={(e) => setDay(e.target.value)} /></label>
    {definition.fields.map((field) => <div key={field.id}><p>{field.label}{field.unit ? ` (${field.unit})` : ''}</p>{field.source === 'manual' ? <TrackerValueInput field={field} value={values[field.id]} label={field.label} onChange={(value) => setValues({ ...values, [field.id]: value })} /> : <p>From linked tasks: {String(initial?.inputValues[field.id] ?? 'Waiting for a completion')}</p>}</div>)}
    <label>Notes<textarea aria-label="Tracking notes" maxLength={5000} value={notes} onChange={(e) => setNotes(e.target.value)} /></label><p className="muted">Missing rule inputs remain unmeasured. One record per day; edit an existing day to add manual observations.</p>
    {command.error && <p role="alert">{command.error} Your draft remains here. Refresh to review the latest table; cancel this editor when ready to reopen that record.</p>}<button className="btn-primary" type="submit">{initial ? 'Save record' : 'Add record'}</button></fieldset></form>;
}
function TaskChoices({ workspaceId, choose, linked }: { workspaceId: string; choose: (task: Task) => void; linked: string[] }) {
  const [term, setTerm] = useState(''), [search, setSearch] = useState(''); const page = useTaskPages(workspaceId, `includeArchived=true&q=${encodeURIComponent(search)}`);
  return <div><form className="row" onSubmit={(e) => { e.preventDefault(); setSearch(term); }}><label>Find tasks<input aria-label="Find tasks to link" maxLength={200} value={term} onChange={(e) => setTerm(e.target.value)} /></label><button>Search tasks</button></form>{page.loading && <p role="status">Searching…</p>}{page.error && <p role="alert">{page.error}</p>}<ul>{page.tasks.filter((t) => !linked.includes(t.id)).map((t) => <li key={t.id}><button onClick={() => choose(t)}>Link {t.title}</button></li>)}</ul><TaskPagination {...page} count={page.tasks.length} onMore={page.loadMore} onRetry={page.reload} /></div>;
}
