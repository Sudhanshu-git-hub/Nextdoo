'use client';
import { useState } from 'react';
import type { Task } from '@/lib/api';
import { TaskEditor } from './TaskEditor';
import { KnowledgeStatus,useKnowledgeRead } from './knowledge/shared';
import { Breadcrumb } from './Breadcrumb';
export function TaskDetailPage({id}:{id:string}) {
  const read=useKnowledgeRead<Task>(`/tasks/${id}`),[open,setOpen]=useState(true);
  return <>
    <Breadcrumb items={[{label:'Home',href:'/'},{label:'Today',href:'/today'},{label:'Task'}]} />
    <KnowledgeStatus error={read.error} loading={read.loading}/>
    {read.data&&!read.error&&<><h1>{read.data.title}</h1><button onClick={()=>setOpen(true)}>Open task</button>{open&&<TaskEditor task={read.data} onClose={()=>setOpen(false)} onSaved={read.refresh}/>}</>}
  </>;
}
