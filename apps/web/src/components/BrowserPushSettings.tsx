'use client';
import { useCallback,useEffect,useState } from 'react';
import { fetchPushStatus,pushSupport,registerServiceWorker,subscribeToPush,unsubscribeFromPush } from '@/lib/push-client';
type PushState={phase:'loading'|'unsupported'|'unconfigured'|'denied'}|{phase:'ready';total:number;deviceActive:boolean};
export function useBrowserPush(){
  const [push,setPush]=useState<PushState>({phase:'loading'}),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
  const refresh=useCallback(async()=>{try{if(pushSupport().kind!=='supported'){setPush({phase:'unsupported'});return;}const status=await fetchPushStatus();if(!status.configured){setPush({phase:'unconfigured'});return;}if(status.permission==='denied'){setPush({phase:'denied'});return;}const registration=await navigator.serviceWorker.getRegistration();const subscription=await registration?.pushManager.getSubscription();setPush({phase:'ready',total:status.total,deviceActive:!!subscription&&status.endpoints.includes(subscription.endpoint)});}catch{setError('Could not check browser push. Reload to try again.');}},[]);
  useEffect(()=>{void refresh();},[refresh]);
  async function enable(){setBusy(true);setError('');setMessage('');try{await registerServiceWorker();const response=await fetch('/api/v1/push/public-key');if(!response.ok)throw new Error();const {vapidPublicKey}=await response.json();const result=await subscribeToPush(vapidPublicKey);if(!result.ok)throw new Error();setMessage(`Browser push enabled (${result.total} subscription${result.total===1?'':'s'} registered).`);await refresh();}catch{setError('Browser push could not be enabled. Check that notifications are allowed for this site, then try again.');await refresh();}finally{setBusy(false);}}
  async function disable(){setBusy(true);setError('');setMessage('');try{const removed=await unsubscribeFromPush();setMessage(removed?'Browser push disabled on this device.':'Browser push disabled locally; the server registration is already gone.');await refresh();}catch{setError('Could not disable browser push on this device.');}finally{setBusy(false);}}
  return {push,busy,error,message,enable,disable};
}
export function BrowserPushSettings({controls,disabled=false}:{controls:ReturnType<typeof useBrowserPush>;disabled?:boolean}){
  const {push,busy,error,message,enable,disable}=controls;
  return <section className="card" aria-labelledby="push-heading"><h2 id="push-heading">Browser push</h2>
    {push.phase==='loading'&&<p role="status">Checking browser push…</p>}
    {push.phase==='unsupported'&&<p>Browser push is not supported in this browser. Reminders continue to appear in the notification center.</p>}
    {push.phase==='unconfigured'&&<p>Browser push is not configured on this deployment. Reminders continue to appear in the notification center.</p>}
    {push.phase==='denied'&&<p>Notifications are blocked for this site in your browser settings. Allow notifications to use browser push; reminders continue to appear in the notification center.</p>}
    {push.phase==='ready'&&<><p>{push.total>0?`Browser push is enabled — ${push.total} subscription${push.total===1?'':'s'} registered for this account.`:'Browser push is available. Enable it to receive reminders as browser notifications on this device.'}</p>{push.deviceActive?<button disabled={busy||disabled} onClick={()=>void disable()}>Disable browser push on this device</button>:<button disabled={busy||disabled} onClick={()=>void enable()}>Enable browser push</button>}</>}
    {error&&<p role="alert">{error}</p>}{message&&<p role="status">{message}</p>}
  </section>;
}
export function BrowserPushPanel(){const controls=useBrowserPush();return <BrowserPushSettings controls={controls} />;}
