'use client';
import { createContext,useContext,useEffect,useState,type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
const sections=[['account','Account & Profile'],['appearance','Appearance'],['productivity','Productivity'],['notifications','Notifications'],['wellbeing','Wellbeing'],['data','Sync & Data'],['integrations','Integrations'],['billing','Plan & Billing'],['security','Security & Privacy'],['help','Help'],['all','All settings']] as const;
const Context=createContext('account');
export function SettingsSections({children}:{children:ReactNode}){
  // Server-rendered controls must not accept edits before React attaches handlers.
  const [ready,setReady]=useState(false);
  useEffect(()=>setReady(true),[]);
  const query=useSearchParams();const requested=query.get('calendar')?'integrations':query.get('section')??'account';
  const [active,setActive]=useState(sections.some(([id])=>id===requested)?requested:'account');
  useEffect(()=>{setActive(sections.some(([id])=>id===requested)?requested:'account');},[requested]);
  return <Context.Provider value={active}><fieldset disabled={!ready} className="settings-ready"><nav className="settings-nav" aria-label="Settings sections">{sections.map(([id,title])=><button key={id} aria-pressed={active===id} onClick={()=>{setActive(id);const url=new URL(location.href);url.searchParams.delete('calendar');url.searchParams.set('section',id);history.replaceState(null,'',url);}}>{title}</button>)}</nav>{children}</fieldset></Context.Provider>;
}
export function SettingsGroup({id,children}:{id:string;children:ReactNode}){const active=useContext(Context);return <div className="settings-group" hidden={active!==id&&active!=='all'}>{children}</div>;}
