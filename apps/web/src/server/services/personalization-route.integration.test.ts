import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
const state=vi.hoisted(()=>({auth:null as {userId:string;workspaceId:string;sessionId:string}|null}));
vi.mock('../auth',async original=>{
  const {AppError}=await import('@nextdoo/contracts');
  return {...await original() as object,requireAuth:async()=>{if(!state.auth)throw new AppError('UNAUTHENTICATED','Authentication required.');return state.auth;}};
});
await (await import('../../../../../tests/database')).requireTestDatabase();
const {registerUser}=await import('./accounts');
const route=await import('../../app/api/v1/preferences/personalization/route');
const status=await import('../../app/api/v1/settings/status/route');
const {PERSONALIZATION_DEFAULTS}=await import('@nextdoo/contracts');
const url='http://localhost/api/v1/preferences/personalization';
const patch=(body:unknown,key?:string)=>new Request(url,{method:'PATCH',headers:{Origin:'http://localhost','Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})},body:JSON.stringify(body)});
beforeEach(async()=>{const u=await registerUser({email:`pc7-route-${randomUUID()}@test.local`,passwordHash:'test',name:null,timeZone:'UTC'});state.auth={userId:u.id,workspaceId:u.workspaceId,sessionId:randomUUID()};});
it('protects preferences and account status from anonymous requests',async()=>{
  state.auth=null;
  expect((await route.GET(new Request(url))).status).toBe(401);
  expect((await route.PATCH(patch({theme:'dark'},randomUUID()))).status).toBe(401);
  expect((await status.GET(new Request('http://localhost/api/v1/settings/status'))).status).toBe(401);
});
it('returns uncached personal defaults and requires mutation idempotency',async()=>{
  const response=await route.GET(new Request(url));
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(await response.json()).toEqual(PERSONALIZATION_DEFAULTS);
  expect((await route.PATCH(patch({theme:'dark'}))).status).toBe(400);
});
it('replays the original saved patch and preserves other values',async()=>{
  const key=randomUUID();
  const first=await route.PATCH(patch({theme:'light'},key));expect(first.status).toBe(200);
  expect(await first.json()).toEqual({...PERSONALIZATION_DEFAULTS,theme:'light'});
  const replay=await route.PATCH(patch({theme:'light'},key));expect(replay.headers.get('Idempotent-Replay')).toBe('true');
  const next=await route.PATCH(patch({accent:'purple'},randomUUID()));
  expect(await next.json()).toEqual({...PERSONALIZATION_DEFAULTS,theme:'light',accent:'purple'});
});
it('rejects empty, unsupported and identity-bearing patches',async()=>{
  for(const body of [{},{locale:'xx'},{workspaceId:randomUUID()},{reminderMinutes:-1}])expect((await route.PATCH(patch(body,randomUUID()))).status).toBe(400);
  expect(await (await route.GET(new Request(url))).json()).toEqual(PERSONALIZATION_DEFAULTS);
});
