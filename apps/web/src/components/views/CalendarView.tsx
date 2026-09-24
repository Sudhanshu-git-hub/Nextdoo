'use client';
import { localParts, localDateKey, zonedTimeToUtc, workspaceWeek, workspaceMonthGrid, localDayBounds, workdayDescription, workdayMinutes } from '@nextdoo/core/calendar';
import { useWorkspace } from '@/components/WorkspaceContext';
import { TaskEditor } from '@/components/TaskEditor';
import { useConnectedCalendar,ConnectedCalendarItems } from '@/components/ConnectedCalendar';
import type { CenterEvent } from '@nextdoo/contracts';
import { useCalendarCenter,CalendarSourcePanel,CalendarEventDialog,CalendarEventChip,eventOnDay } from '@/components/CalendarCenter';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, type Task } from '@/lib/api';

type CalendarViewMode = 'day' | 'week' | 'month' | 'year' | 'agenda';

interface CalendarWindow {
  from: Date;
  to: Date;
  days: Date[];
}

/**
 * Calendar (PRD §8.3 / §6.9) — day, week and month views of scheduled work
 * with full cursor pagination over the visible period.
 *
 * Drag-and-drop is deliberately not the only way to move a task: each day is a
 * drop target *and* a keyboard-reachable button, satisfying the accessible
 * alternative requirement (PRD §8.8). In the day view the title opens the
 * editor, because there is no other day to move to.
 */
export function CalendarView({ workspaceId }: { workspaceId: string }) {
  const workspace = useWorkspace();
  const { timeZone, weekStart } = workspace;
  const [view, setView] = useState<CalendarViewMode>('week');
  const [anchor, setAnchor] = useState(() => new Date());
  const [tasks, setTasks] = useState<Task[]>([]);
  const [eventDialog,setEventDialog]=useState<{event:CenterEvent|null}|null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Task | null>(null);
  const [editing, setEditing] = useState<Task | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [status, setStatus] = useState('');
  const requestRef = useRef<AbortController | null>(null);

  const win: CalendarWindow = useMemo(() => {
    if(view==='year'||view==='agenda'){
      const p=localParts(anchor,timeZone),base=new Date(Date.UTC(p.year,view==='year'?0:p.month-1,view==='year'?1:p.day));
      const count=view==='year'?(new Date(Date.UTC(p.year+1,0,1)).getTime()-base.getTime())/86400000:30;
      const at=(i:number)=>{const d=new Date(base.getTime()+i*86400000);return zonedTimeToUtc(d.getUTCFullYear(),d.getUTCMonth()+1,d.getUTCDate(),0,0,timeZone);};
      return {from:at(0),to:new Date(at(count).getTime()-1),days:Array.from({length:count},(_,i)=>at(i))};
    }
    if (view === 'day') {
      const b = localDayBounds(anchor, timeZone);
      return { from: b.start, to: b.end, days: [b.start] };
    }
    if (view === 'week') {
      const w = workspaceWeek(anchor, timeZone, weekStart);
      return { from: w.days[0], to: w.end, days: w.days };
    }
    const m = workspaceMonthGrid(anchor, timeZone, weekStart);
    return { from: m.start, to: m.end, days: m.cells };
  }, [view, anchor, timeZone, weekStart]);
  const connected=useConnectedCalendar(win.from.toISOString(),win.to.toISOString());
  const center=useCalendarCenter(win.from.toISOString(),win.to.toISOString(),timeZone);

  const load = useCallback(async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setError(null);
    setRowError(null);
    try {
      // Full pagination over the visible period: follow next_cursor until the
      // window is exhausted (PRD §6.9 full calendar pagination).
      let cursor: string | null = null;
      const collected = new Map<string, Task>();
      for (;;) {
        if (collected.size) setLoadingMore(true); else setLoading(true);
        const params = new URLSearchParams({
          workspaceId,
          dueAfter: win.from.toISOString(),
          dueBefore: win.to.toISOString(),
          limit: '100',
        });
        if (cursor) params.set('cursor', cursor);
        const response = await api<{ data: Task[]; pagination: { next_cursor: string | null; has_more: boolean } }>(
          `/tasks?${params.toString()}`,
          { signal: controller.signal },
        );
        for (const task of response.data) collected.set(task.id, task);
        if(controller.signal.aborted)return;
        setTasks([...collected.values()]);
        if (!response.pagination.has_more || !response.pagination.next_cursor) break;
        cursor = response.pagination.next_cursor;
      }
    } catch (caught) {
      if (controller.signal.aborted) return;
      setError(caught instanceof ApiError ? caught.problem.detail : 'Could not load the calendar.');
    } finally {
      if (requestRef.current === controller) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [workspaceId, win.from, win.to]);

  useEffect(() => {
    void load();
    return () => requestRef.current?.abort();
  }, [load]);

  async function moveTo(task: Task, day: Date) {
    const date = localParts(day, timeZone), original = task.dueAt ? localParts(new Date(task.dueAt), timeZone) : null;
    const target = zonedTimeToUtc(date.year, date.month, date.day, original?.hour ?? Math.floor(workspace.workdayStartMinute / 60), original?.minute ?? workspace.workdayStartMinute % 60, timeZone);
    try {
      await api(`/tasks/${task.id}/reschedule`, {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ version: task.version, dueAt: target.toISOString(), reason: 'Moved on calendar' }),
      });
      setStatus(`Moved "${task.title}" to ${day.toLocaleDateString(undefined, { timeZone, weekday: 'long' })}`);
      setSelected(null);
      void load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.problem.detail : 'Could not move the task.');
    }
  }

  async function toggle(task: Task) {
    setBusyId(task.id);
    setRowError(null);
    const completing = task.status !== 'COMPLETED';
    try {
      await api(`/tasks/${task.id}/${completing ? 'complete' : 'reopen'}`, {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ version: task.version }),
      });
      setStatus(completing ? `Completed: ${task.title}` : `Reopened: ${task.title}`);
      void load();
    } catch (caught) {
      setRowError({ id: task.id, message: caught instanceof ApiError ? caught.problem.detail : 'Could not update the task.' });
    } finally {
      setBusyId(null);
    }
  }

  const byDay = useMemo(() => {
    const groups = new Map<string, Task[]>();
    for (const task of tasks) {
      if (!task.dueAt) continue;
      const key = localDateKey(new Date(task.dueAt), timeZone);
      const list = groups.get(key);
      if (list) list.push(task); else groups.set(key, [task]);
    }
    for (const list of groups.values()) {
      list.sort((a, b) => new Date(a.dueAt!).getTime() - new Date(b.dueAt!).getTime() || a.title.localeCompare(b.title));
    }
    return groups;
  }, [tasks, timeZone]);

  const capacity = workdayMinutes(workspace.workdayStartMinute, workspace.workdayEndMinute);
  const overDay = (list: Task[]) => list.reduce((sum, t) => sum + (t.estimateMinutes ?? 0), 0) > capacity;
  const isToday = (day: Date) => localDateKey(day, timeZone) === localDateKey(new Date(), timeZone);
  const timeLabel = (task: Task) => new Date(task.dueAt!).toLocaleTimeString(undefined, { timeZone, hour: 'numeric', minute: '2-digit' });

  function shift(dir: -1 | 1) {
    setAnchor((current) => {
      const p = localParts(current, timeZone);
      if(view==='year')return zonedTimeToUtc(p.year+dir,1,1,0,0,timeZone);
      if(view==='agenda'){const d=new Date(Date.UTC(p.year,p.month-1,p.day+dir*30));return zonedTimeToUtc(d.getUTCFullYear(),d.getUTCMonth()+1,d.getUTCDate(),0,0,timeZone);}
      if (view === 'month') {
        // Month arithmetic must not leak day-of-month (Jan 31 + 1 ≠ Mar 3).
        const d=new Date(Date.UTC(p.year,p.month-1+dir,1));return zonedTimeToUtc(d.getUTCFullYear(),d.getUTCMonth()+1,1,0,0,timeZone);
      }
      const date = new Date(Date.UTC(p.year, p.month - 1, p.day));
      if (view === 'day') date.setUTCDate(date.getUTCDate() + dir);
      else date.setUTCDate(date.getUTCDate() + dir * 7);
      return zonedTimeToUtc(date.getUTCFullYear(),date.getUTCMonth()+1,date.getUTCDate(),0,0,timeZone);
    });
    setSelected(null);
  }

  const periodKey = (date: Date) => {
    const p = localParts(date, timeZone);
    if(view==='year')return `y:${p.year}`;
    if(view==='agenda')return `a:${localDateKey(date,timeZone)}`;
    if (view === 'day') return `d:${localDateKey(date, timeZone)}`;
    if (view === 'week') return `w:${localDateKey(workspaceWeek(date, timeZone, weekStart).days[0], timeZone)}`;
    return `m:${p.year}-${p.month}`;
  };
  const atCurrentPeriod = periodKey(anchor) === periodKey(new Date());

  const subtitle = view==='year'?String(localParts(anchor,timeZone).year):view==='agenda'?`${localDateKey(win.from,timeZone)} – ${localDateKey(win.to,timeZone)}`:view === 'week'
    ? `${win.days[0]!.toLocaleDateString(undefined, { timeZone, month: 'short', day: 'numeric' })} – ${win.days[6]!.toLocaleDateString(undefined, { timeZone, month: 'short', day: 'numeric' })}`
    : view === 'month'
      ? anchor.toLocaleDateString(undefined, { timeZone, month: 'long', year: 'numeric' })
      : win.days[0]!.toLocaleDateString(undefined, { timeZone, weekday: 'long', month: 'long', day: 'numeric' });

  const navLabels = view==='year'?{prev:'← Previous year',next:'Next year →',current:'This year'}:view==='agenda'?{prev:'← Previous 30 days',next:'Next 30 days →',current:'Today'}:view === 'day'
    ? { prev: '← Previous day', next: 'Next day →', current: 'Today' }
    : view === 'month'
      ? { prev: '← Previous month', next: 'Next month →', current: 'This month' }
      : { prev: '← Previous week', next: 'Next week →', current: 'This week' };

  const monthBase = view === 'month' ? localParts(anchor, timeZone) : null;

  function chip(task: Task, compact: boolean) {
    const done = task.status === 'COMPLETED';
    return (
      <div key={task.id} style={{borderLeft:`4px solid ${center.color('internal:task')}`}} className={`cal-chip${done ? ' cal-done' : ''}`} draggable onDragStart={(e) => e.dataTransfer.setData('text/plain', task.id)}>
        <button
          type="button"
          className="check"
          aria-pressed={done}
          aria-label={done ? `Reopen "${task.title}"` : `Complete "${task.title}"`}
          disabled={busyId === task.id}
          onClick={() => void toggle(task)}
        >
          {done ? '✓' : ''}
        </button>
        <button
          type="button"
          className={`btn-sm cal-title${compact ? ' cal-compact' : ''}`}
          aria-label={view === 'day' ? `Edit "${task.title}"` : `${task.title}. Press to move to another day.`}
          title={task.title}
          onClick={() => (view === 'day' ? setEditing(task) : setSelected(task))}
        >
          {task.title}
        </button>
        <span className="cal-time">{timeLabel(task)}</span>
        <button type="button" className="btn-ghost btn-sm cal-edit" aria-label={`Edit "${task.title}"`} onClick={() => setEditing(task)}>Edit</button>
        {rowError?.id === task.id && (
          <p className="cal-row-error" role="alert">{rowError.message}</p>
        )}
      </div>
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Calendar</h1>
          <p className="subtitle">{subtitle}</p>
        </div>
        <div className="row">
          <div className="row" role="group" aria-label="Calendar view">
            {(['day', 'week', 'month','year','agenda'] as const).map((mode) => (
              <button key={mode} aria-pressed={view === mode} onClick={() => { setView(mode); setSelected(null); }}>
                {mode[0]!.toUpperCase()+mode.slice(1)}
              </button>
            ))}
          </div>
          <button onClick={() => shift(-1)}>{navLabels.prev}</button>
          <button onClick={() => { setAnchor(new Date()); setSelected(null); }} disabled={atCurrentPeriod}>{navLabels.current}</button>
          <button onClick={() => shift(1)}>{navLabels.next}</button>
        </div>
      </div>

      <div className="calendar-center"><CalendarSourcePanel center={center} timeZone={timeZone} onAddEvent={()=>setEventDialog({event:null})}/><div className="calendar-content">
      <p>Calendar time zone: {timeZone}</p>
      {connected.controls}
      <p>Configured workday: {workdayDescription(workspace.workdayStartMinute, workspace.workdayEndMinute)}</p>
      {error && (
        <div className="banner banner-error" role="alert">
          {error}{' '}
          <button className="btn-sm" onClick={() => void load()}>Retry</button>
        </div>
      )}
      {loadingMore && <p role="status" className="muted">Loading more tasks…</p>}
      {!loading && !loadingMore && !error && tasks.length === 0 && (
        <p className="muted">No scheduled tasks in this period.</p>
      )}

      {selected && (
        <div className="banner banner-info" role="group" aria-label="Move task">
          Moving <strong>{selected.title}</strong> — choose a day below, or{' '}
          <button className="btn-ghost btn-sm" onClick={() => setSelected(null)}>cancel</button>.
        </div>
      )}

      {view==='year'?<div className="calendar-year">{Array.from({length:12},(_,month)=>{
        const first=zonedTimeToUtc(localParts(anchor,timeZone).year,month+1,1,0,0,timeZone),grid=workspaceMonthGrid(first,timeZone,weekStart);
        return <section className="card" key={month}><h2><button onClick={()=>{setAnchor(first);setView('month');}}>{first.toLocaleDateString(undefined,{timeZone,month:'long'})}</button></h2><div className="calendar-year-month">{grid.cells.map(day=>{const key=localDateKey(day,timeZone),p=localParts(day,timeZone);if(p.month!==month+1)return <span key={key}/>;const count=(center.visible('internal:task')?(byDay.get(key)?.length??0):0)+connected.items.filter(i=>i.day===key&&center.visible('internal:'+i.type)).length+center.events.filter(e=>eventOnDay(e,key,timeZone)).length;return <button key={key} aria-label={`${key}, ${count} items`} onClick={()=>{setAnchor(day);setView('day');}}>{p.day}{count>0&&<small> · {count}</small>}</button>;})}</div></section>;
      })}</div>:<div
        className={view === 'month' ? 'grid cal-month' : 'grid'}
        style={{ gridTemplateColumns: `repeat(${view === 'month' ? 7 : 1}, minmax(0,1fr))` }}
        role="list"
      >
        {win.days.map((day) => {
          const today = isToday(day);
          const key=localDateKey(day,timeZone);
          const dayTasks = center.visible('internal:task')?(byDay.get(key)??[]):[];
          const dayEvents=center.events.filter(event=>eventOnDay(event,key,timeZone));
          const dayConnected=connected.items.filter(item=>item.day===key&&center.visible('internal:'+item.type));
          if(view==='agenda'&&!loading&&!center.loading&&!dayTasks.length&&!dayEvents.length&&!dayConnected.length)return null;
          const over = dayTasks.length > 0 && overDay(dayTasks);
          const inMonth = !monthBase || localParts(day, timeZone).month === monthBase.month;
          const cardStyle = {
            minHeight: view === 'month' ? 92 : 170,
            padding: view === 'month' ? 6 : 10,
            borderColor: today ? 'var(--accent)' : undefined,
          } as const;
          return (
            <div
              key={day.toISOString()}
              className="card"
              role="listitem"
              style={cardStyle}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const eventId=e.dataTransfer.getData('application/x-nextdoo-event'),resizeId=e.dataTransfer.getData('application/x-nextdoo-resize');
                if(eventId||resizeId){void center.move(eventId||resizeId,day,!!resizeId);return;}
                const id = e.dataTransfer.getData('text/plain');
                const task = tasks.find((t) => t.id === id);
                if (task) void moveTo(task, day);
              }}
              onClick={view === 'month' && selected ? (e) => { if (!e_targetInChip(e)) void moveTo(selected, day); } : undefined}
            >
              <div className="spread" style={{ marginBottom: view === 'month' ? 4 : 8 }}>
                <div style={{ fontSize: view === 'month' ? 11 : 12, color: 'var(--text-dim)' }}>
                  {view === 'month' ? '' : day.toLocaleDateString(undefined, { timeZone, weekday: 'short',month:'short' })}
                </div>
                <div style={{ fontWeight: today ? 700 : 400, fontSize: view === 'month' ? 12 : 13, color: inMonth ? undefined : 'var(--text-faint)' }}>
                  {localParts(day, timeZone).day}
                </div>
              </div>
              {over && (
                <div className="cal-over-mark" title="Sum of estimates for loaded tasks exceeds the configured workday">
                  over workday
                </div>
              )}

              {selected && view === 'week' && (
                <button
                  className="btn-sm"
                  style={{ width: '100%', marginBottom: 8 }}
                  onClick={() => void moveTo(selected, day)}
                >
                  Move here
                </button>
              )}

              {loading && <div className="skeleton" style={{ height: view === 'month' ? 22 : 30 }} />}

              {dayTasks.map((task) => chip(task, view === 'month'))}
              <ConnectedCalendarItems items={dayConnected} color={type=>center.color('internal:'+type)}/>
              {dayEvents.map(event=><CalendarEventChip key={event.id} timeZone={timeZone} event={event} color={center.color(event.sourceId)} onOpen={()=>setEventDialog({event})}/>)}

              {!loading && !dayTasks.length && !dayEvents.length && !dayConnected.length && !selected && (
                <p className="muted" style={{ fontSize: 12 }}>—</p>
              )}
            </div>
          );
        })}
      </div>}
      {view==='agenda'&&!loading&&!center.loading&&!connected.loading&&!(center.visible('internal:task')&&tasks.length)&&!center.events.length&&!connected.items.some(item=>center.visible('internal:'+item.type))&&<p>No items in this agenda period.</p>}
      </div></div>
      {eventDialog&&<CalendarEventDialog key={eventDialog.event?.id??'new'} event={eventDialog.event} sources={center.sources} timeZone={timeZone} onClose={()=>setEventDialog(null)} onSaved={center.refresh}/>}

      {editing && <TaskEditor key={editing.id} task={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
      <div aria-live="polite" className="sr-only">{status}</div>
    </>
  );
}

function e_targetInChip(event: React.MouseEvent): boolean {
  return Boolean((event.target as HTMLElement).closest('.cal-chip'));
}
