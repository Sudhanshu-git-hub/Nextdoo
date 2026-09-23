'use client';
import Link from 'next/link';
import { useState } from 'react';
import { KnowledgeHeader,KnowledgeStatus,KnowledgePager,useKnowledgeRead,type Page,type KnowledgeItem } from './shared';
export function KnowledgeNotes({recordId,databaseId}:{recordId?:string;databaseId?:string}) {
  const [offset,setOffset]=useState(0);const parent=new URLSearchParams({...recordId?{recordId}:{},...databaseId?{databaseId}:{}});
  const read=useKnowledgeRead<Page<KnowledgeItem>>(`/knowledge/notes?${parent}&offset=${offset}`);
  return <div className="knowledge-view"><KnowledgeHeader/><h1>Notes</h1><Link href={`/knowledge/notes/new?${parent}`}>Add note</Link><KnowledgeStatus error={read.error} loading={read.loading}/><ul>{read.data?.data.map(n=><li key={n.id}><Link href={`/knowledge/notes/${n.id}`}>{n.title}</Link></li>)}</ul>{read.data&&<KnowledgePager offset={offset} nextOffset={read.data.nextOffset} setOffset={setOffset}/>}</div>;
}
