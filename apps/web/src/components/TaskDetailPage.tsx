'use client';
import Link from 'next/link';
import { useState } from 'react';
import type { Task } from '@/lib/api';
import { TaskEditor } from './TaskEditor';
import { KnowledgeStatus,useKnowledgeRead } from './knowledge/shared';
export function TaskDetailPage({id}:{id:string}) {
  const read=useKnowledgeRead<Task>(`/tasks/${id}`),[open,setOpen]=useState(true);
  return <><Link href="/today">Back to Today</Link><KnowledgeStatus error={read.error} loading={read.loading}/>{read.data&&!read.error&&<><h1>{read.data.title}</h1><button onClick={()=>setOpen(true)}>Open task</button>{open&&<TaskEditor task={read.data} onClose={()=>setOpen(false)} onSaved={read.refresh}/>}</>}</>;
}
