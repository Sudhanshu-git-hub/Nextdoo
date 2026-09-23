'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { knowledgeTemplates } from '@nextdoo/core/knowledge';
import { KnowledgeHeader, KnowledgePager, KnowledgeStatus, useKnowledgeRead, useKnowledgeCommand, type Page, type KnowledgeDatabase, type KnowledgeItem } from './shared';

export function KnowledgeHome(){
  const [q,setQ]=useState(''),[search,setSearch]=useState(''),[offset,setOffset]=useState(0),[archived,setArchived]=useState(false),[favorite,setFavorite]=useState(false),[tab,setTab]=useState<'databases'|'notes'>('databases');
  const [name,setName]=useState(''),[description,setDescription]=useState(''),[template,setTemplate]=useState(''),[preview,setPreview]=useState('');
  const command=useKnowledgeCommand(),router=useRouter();const templates=knowledgeTemplates();
  const read=useKnowledgeRead<Page<KnowledgeDatabase & KnowledgeItem>>(`/knowledge/${tab}?q=${encodeURIComponent(search)}&offset=${offset}&includeDeleted=${archived}&favorite=${favorite}`);
  return <div className="knowledge-view"><KnowledgeHeader/><h1>Knowledge &amp; Data</h1><div className="row"><button onClick={()=>{setTab('databases');setOffset(0);}} aria-pressed={tab==='databases'}>Databases</button><button onClick={()=>{setTab('notes');setOffset(0);}} aria-pressed={tab==='notes'}>Notes</button></div>
    <form className="card knowledge-form" aria-label={tab==='databases'?'New database':'New note'} onSubmit={async e=>{e.preventDefault();const created=await command.send<{id:string}>(`/knowledge/${tab}`,tab==='databases'?{name,description, ...(template?{templateId:template}:{})}:{title:name,content:description});if(created)router.push(`/knowledge/${tab}/${created.id}`);}}>
      <h2>{tab==='databases'?'Create a database':'Create a note'}</h2><label>{tab==='databases'?'Database name':'Note title'}<input required maxLength={200} value={name} onChange={e=>setName(e.target.value)}/></label><label>{tab==='databases'?'Description':'Content'}<textarea maxLength={10000} value={description} onChange={e=>setDescription(e.target.value)}/></label>
      {tab==='databases'&&<><label>Starting template<select value={template} onChange={e=>setTemplate(e.target.value)}><option value="">Blank database</option>{templates.map(t=><option value={t.id} key={t.id}>{t.name}</option>)}</select></label>{template&&<button type="button" onClick={()=>setPreview(template)}>Preview template</button>}{templates.filter(t=>t.id===preview).map(t=><article aria-label="Template preview" key={t.id}><h3>{t.name}</h3><p>{t.description}</p><ul>{t.properties.map(p=><li key={p.name}>{p.name} · {p.type.toLowerCase().replaceAll('_',' ')}{p.config.options.length?` (${p.config.options.join(', ')})`:''}</li>)}</ul><p>Creates an independent copy you can edit.</p></article>)}</>}
      <KnowledgeStatus error={command.error}/><button disabled={command.busy}>{tab==='databases'?'Create database':'Create note'}</button>
    </form>
    <form className="row" onSubmit={e=>{e.preventDefault();setSearch(q);setOffset(0);}}><label>Search {tab}<input value={q} maxLength={200} onChange={e=>setQ(e.target.value)}/></label><button>Search</button><label><input type="checkbox" checked={archived} onChange={e=>{setArchived(e.target.checked);setOffset(0);}}/>Include {tab==='databases'?'archived databases':'deleted notes'}</label>{tab==='databases'&&<label><input type="checkbox" checked={favorite} onChange={e=>{setFavorite(e.target.checked);setOffset(0);}}/>Favorites only</label>}</form>
    <KnowledgeStatus error={read.error} loading={read.loading}/>{read.data?.data.length===0&&<p>No {tab} found. Create one above to get started.</p>}
    <div className="knowledge-grid">{read.data?.data.map(row=><article className="card" key={row.id}><h2><Link href={`/knowledge/${tab}/${row.id}`}>{row.icon} {tab==='databases'?row.name:row.title}</Link></h2><p>{tab==='databases'?row.description:row.content.slice(0,180)}</p>{(row.archived||row.deletedAt)&&<p className="muted">{tab==='databases'?'Archived':'Deleted'}</p>}</article>)}</div>{read.data&&<KnowledgePager offset={offset} nextOffset={read.data.nextOffset} setOffset={setOffset}/>}
  </div>;
}
