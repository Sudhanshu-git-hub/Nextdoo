'use client';
import { createContext,useContext,useState,type ReactNode } from 'react';
import { PERSONALIZATION_DEFAULTS,type Personalization } from '@nextdoo/contracts';
import { api } from '@/lib/api';
const Context=createContext({preferences:PERSONALIZATION_DEFAULTS,save:async(_patch:Partial<Personalization>)=>{},busy:false});
export const usePersonalization=()=>useContext(Context);
export function PersonalizationProvider({initial,children}:{initial:Personalization;children:ReactNode}){
  const [preferences,setPreferences]=useState(initial),[busy,setBusy]=useState(false);
  async function save(patch:Partial<Personalization>){setBusy(true);try{setPreferences(await api<Personalization>('/preferences/personalization',{method:'PATCH',body:JSON.stringify(patch)}));}finally{setBusy(false);}}
  return <Context.Provider value={{preferences,save,busy}}><div className="personalized" data-theme={preferences.theme} data-accent={preferences.accent} data-density={preferences.density} data-ui-size={preferences.uiSize} data-sidebar={preferences.sidebar} data-contrast={preferences.highContrast?'high':''} data-motion={preferences.reducedMotion?'reduced':''}>{children}</div></Context.Provider>;
}
