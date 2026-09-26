'use client';
import Link from 'next/link';
import { useEffect,useState } from 'react';
import { api,type Task } from '@/lib/api';
import { focusElapsed } from '@/lib/focus-state';
import type { FocusSnapshot } from '@/lib/offline-queue';
import { durationLabel } from '@/lib/time-entry';
export function TaskTimeSummary({task}:{task:Task}){
  const [saved,setSaved]=useState(task),[timer,setTimer]=useState<FocusSnapshot|null>(null),[now,setNow]=useState(Date.now());
  useEffect(()=>{let active=true;setSaved(task);const refresh=async()=>{try{const [detail,session]=await Promise.all([api<Task>(`/tasks/${task.id}`),api<{timer:FocusSnapshot|null}>('/timers')]);if(active){setSaved(detail);setTimer(session.timer?.taskId===task.id?session.timer:null);}}catch{/* Preserve the last acknowledged task while offline. */}};void refresh();const poll=setInterval(()=>void refresh(),15000),tick=setInterval(()=>setNow(Date.now()),1000);window.addEventListener('nextdoo-synced',refresh);return()=>{active=false;clearInterval(poll);clearInterval(tick);window.removeEventListener('nextdoo-synced',refresh);};},[task]);
  return <section aria-label="Task time"><p>Actual time: {durationLabel(saved.actualSeconds+(timer?focusElapsed(timer,now):0))} · Planned time: {saved.estimateMinutes===null?'Not planned':durationLabel(saved.estimateMinutes*60)}</p><Link href={`/focus?taskId=${task.id}`}>Focus and time entries</Link></section>;
}
