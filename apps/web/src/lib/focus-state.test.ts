import { expect, it } from 'vitest';
import { projectFocus, focusElapsed } from './focus-state';
import type { QueuedMutation } from './offline-queue';
const at=(minutes:number)=>new Date(Date.UTC(2026,8,25,10,minutes)).toISOString();
const command=(operation:'create'|'update',payload:Record<string,unknown>):QueuedMutation=>({workspaceId:'w',entityType:'timer_session',entityId:'timer',mutationId:'mutation',operation,payload,baseVersion:null,createdAt:at(0),attempts:0});
it('rebuilds offline pause/resume time from durable timestamps without counting the break',()=>{
  const queued=[command('create',{taskId:'task',startedAt:at(0)}),command('update',{action:'pause',at:at(5)}),command('update',{action:'resume',at:at(15)})];
  const timer=projectFocus(null,queued)!;
  expect(timer.version).toBe(3);expect(focusElapsed(timer,Date.parse(at(18)))).toBe(8*60);
  expect(projectFocus(null,[...queued,command('update',{action:'stop',at:at(18)})])).toBeNull();
});
it('projects a pending earlier pause against a later canonical acknowledgement without overcounting',()=>{
  const base={id:'timer',taskId:'task',status:'RUNNING' as const,version:1,startedAt:at(0),observedAt:at(20),elapsedSeconds:1200};
  expect(projectFocus(base,[command('update',{action:'pause',at:at(5)})])?.elapsedSeconds).toBe(300);
});
