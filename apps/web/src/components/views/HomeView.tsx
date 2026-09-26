'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { usePersonalization } from '../PersonalizationContext';
import { useWorkspace } from '../WorkspaceContext';
import { useWorkspaceDay } from '@/lib/use-workspace-day';
import { HOME_WIDGETS, type HomeWidget, type HomeCardData } from '@/lib/home-widgets';
import { useKnowledgeRead, useKnowledgeCommand } from '../knowledge/shared';

export function HomeView({name}:{name:string|null}) {
  const { preferences, save, busy } = usePersonalization(), { timeZone } = useWorkspace();
  const { now, day } = useWorkspaceDay(timeZone);
  const [managing, setManaging] = useState(false), [error, setError] = useState(''), [revision, setRevision] = useState(0), [ready,setReady] = useState(false);
  useEffect(()=>setReady(true),[]);
  const summary = useKnowledgeRead<{completed:number;focusMinutes:number;upcoming:number;overdue:number;asOf:string}>(`/home?day=${day}&revision=${revision}`);
  useEffect(() => { const refresh = () => setRevision(v=>v+1); window.addEventListener('nextdoo-synced',refresh); const timer=setInterval(()=>{if(!document.hidden&&navigator.onLine)refresh();},60000);return()=>{clearInterval(timer);window.removeEventListener('nextdoo-synced',refresh);}; }, []);
  async function arrange(cards: HomeWidget[]) { setError(''); try { await save({homeCards:cards}); } catch { setError('Could not save your card layout. Your saved layout is still applied.'); } }
  const hour = Number(new Intl.DateTimeFormat('en',{timeZone,hour:'numeric',hourCycle:'h23'}).format(now));
  return <><div className="page-head"><div><p className="muted">{now.toLocaleDateString(undefined,{timeZone,weekday:'long',month:'long',day:'numeric'})}</p><h1>Good {hour<12?'morning':hour<18?'afternoon':'evening'}{name ? ', '+name : ''}</h1><p className="subtitle">A little perspective for your day.</p></div><button disabled={!ready} onClick={()=>setManaging(v=>!v)} aria-expanded={managing}>Manage cards</button></div>
    {error&&<p role="alert" className="banner banner-error">{error}</p>}
    {managing&&<section className="card" aria-label="Manage Home cards"><h2>Your Home cards</h2><p>Add or remove cards. Use each card’s menu to change its order.</p><div className="home-card-picker">{(Object.keys(HOME_WIDGETS) as HomeWidget[]).map(id=><label key={id}><input type="checkbox" checked={preferences.homeCards.includes(id)} disabled={busy} onChange={e=>arrange(e.target.checked?[...preferences.homeCards,id]:preferences.homeCards.filter(c=>c!==id))}/>{HOME_WIDGETS[id].title}</label>)}</div><p className="muted">Recently Viewed is not available yet; no viewing history is collected for this dashboard.</p></section>}
    <section aria-label="Today's overview"><h2>Today’s overview</h2>{summary.loading&&<p role="status">Loading overview…</p>}{summary.error&&<p role="alert">{summary.error} <button onClick={summary.refresh}>Retry overview</button></p>}{summary.data&&!summary.error&&<><div className="home-stats">{[['Tasks completed',summary.data.completed,'/completed'],['Saved focus minutes',summary.data.focusMinutes,'/focus'],['Upcoming · 7 days',summary.data.upcoming,'/upcoming'],['Overdue',summary.data.overdue,'/overdue']].map(([title,value,href])=><Link className="card" key={title} href={String(href)}><strong>{value}</strong><span>{title}</span></Link>)}</div><p className="muted">Updated {new Date(summary.data.asOf).toLocaleTimeString(undefined,{timeZone})} · {timeZone}. Focus summary includes finished sessions started today.</p></>}</section>
    <div className="home-grid">{preferences.homeCards.map((id,index)=><section className="card home-widget" aria-label={HOME_WIDGETS[id].title} key={id}><header className="row"><h2>{HOME_WIDGETS[id].title}</h2><details><summary aria-label={`${HOME_WIDGETS[id].title} card menu`}>•••</summary><div className="home-card-menu"><button disabled={busy||index===0} onClick={()=>{const cards=[...preferences.homeCards];[cards[index-1],cards[index]]=[cards[index]!,cards[index-1]!];void arrange(cards);}}>Move earlier</button><button disabled={busy||index===preferences.homeCards.length-1} onClick={()=>{const cards=[...preferences.homeCards];[cards[index+1],cards[index]]=[cards[index]!,cards[index+1]!];void arrange(cards);}}>Move later</button><button disabled={busy} onClick={()=>arrange(preferences.homeCards.filter(c=>c!==id))}>Remove card</button></div></details></header><p className="muted">{HOME_WIDGETS[id].description}</p>{id==='notes'?<QuickNote/>:<DataCard id={id} revision={revision} day={day}/>}<Link className="home-card-link" href={HOME_WIDGETS[id].href}>Open {HOME_WIDGETS[id].title}</Link></section>)}</div>
    {!preferences.homeCards.length&&<p>No cards selected. Use Manage cards to add an overview.</p>}
  </>;
}
function DataCard({id,revision,day}:{id:HomeWidget;revision:number;day:string}) {
  const read=useKnowledgeRead<HomeCardData>(`/home?card=${id}&revision=${revision}&day=${day}`);
  return <>{read.loading&&<p role="status">Loading card…</p>}{read.error&&<p role="alert">{read.error}</p>}{read.data&&!read.error&&<><ul className="home-items">{read.data.items.map(item=><li key={item.id}><Link href={item.href}>{item.title}</Link><span className="muted">{item.detail}</span></li>)}</ul>{!read.data.items.length&&<p>Nothing to show yet.</p>}{read.data.more&&<p className="muted">Showing a preview. Open the module to see more.</p>}</>}<button className="btn-sm" onClick={read.refresh}>Refresh card</button></>;
}
function QuickNote() {
  const command=useKnowledgeCommand(),[title,setTitle]=useState(''),[content,setContent]=useState(''),[saved,setSaved]=useState<string|null>(null);
  return <form onSubmit={async e=>{e.preventDefault();const note=await command.send<{id:string}>('/knowledge/notes',{title,content});if(note){setTitle('');setContent('');setSaved(note.id);}}}><label>Note title<input required maxLength={500} value={title} onChange={e=>setTitle(e.target.value)}/></label><label>Note<textarea maxLength={20000} value={content} onChange={e=>setContent(e.target.value)}/></label>{command.error&&<p role="alert">{command.error}</p>}<button disabled={command.busy}>Save note</button>{saved&&<p role="status">Saved in Knowledge. <Link href={`/knowledge/notes/${saved}`}>Open note</Link></p>}</form>;
}
