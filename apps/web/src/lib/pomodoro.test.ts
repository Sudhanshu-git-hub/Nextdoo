import { expect,it } from 'vitest';
import { PERSONALIZATION_DEFAULTS as prefs } from '@nextdoo/contracts';
import { breakCycle,readyCycle,workCycle,workDeadline } from './pomodoro';
import { entryLocalTime,workspaceDateTime } from './time-entry';
it('uses work timestamps across a background wake-up and pause instead of counting ticks',()=>{
  const cycle=workCycle(null,'task','timer',prefs), start=Date.parse('2026-09-25T10:00:00Z');
  const timer={id:'timer',taskId:'task',status:'RUNNING' as const,version:1,startedAt:new Date(start).toISOString(),observedAt:new Date(start+600000).toISOString(),elapsedSeconds:600};
  expect(workDeadline(cycle,timer,start+1200000)).toBeNull();
  expect(workDeadline(cycle,timer,start+3600000)).toBe(start+1500000);
  expect(workDeadline(cycle,{...timer,status:'PAUSED'},start+3600000)).toBeNull();
  expect(workDeadline(cycle,{...timer,observedAt:new Date(start+1800000).toISOString()},start+3600000)).toBe(start+2700000);
});
it('progresses through short and long breaks with configurable cycle length and no work credit',()=>{
  const config={...prefs,focusMinutes:10,breakMinutes:2,longBreakMinutes:8,sessionsBeforeLongBreak:2};
  const first=workCycle(null,'task','one',config),short=breakCycle(first,config,1000);
  expect(first.targetSeconds).toBe(600);expect(short).toMatchObject({phase:'short-break',deadline:121000});
  const second=workCycle(readyCycle(short),'task','two',config),long=breakCycle(second,config,2000);
  expect(second.session).toBe(2);expect(long).toMatchObject({phase:'long-break',deadline:482000});
  expect(readyCycle(long)).toMatchObject({session:3,phase:'ready',deadline:null});
});
it('converts manual entry boundaries in the workspace zone and rejects nonexistent local times',()=>{
  expect(workspaceDateTime('2026-09-26T00:15','Asia/Kolkata')).toBe('2026-09-25T18:45:00.000Z');
  expect(entryLocalTime('2026-09-25T18:45:00.000Z','Asia/Kolkata')).toBe('2026-09-26T00:15');
  expect(()=>workspaceDateTime('2026-03-08T02:30','America/New_York')).toThrow('does not exist');
  expect(()=>workspaceDateTime('2026-02-30T10:00','UTC')).toThrow();
});
