import type { Personalization } from '@nextdoo/contracts';
import { focusElapsed } from './focus-state';
import type { FocusSnapshot } from './offline-queue';
export interface PomodoroState {
  session: number; phase: 'ready'|'work'|'short-break'|'long-break';
  taskId: string; timerId?: string; targetSeconds: number;
  deadline: number | null; remaining: number | null;
}
export function workCycle(previous: PomodoroState|null, taskId:string, timerId:string, prefs:Personalization):PomodoroState {
  return {session:previous?.session??1,phase:'work',taskId,timerId,targetSeconds:prefs.focusMinutes*60,deadline:null,remaining:null};
}
export function breakCycle(cycle:PomodoroState,prefs:Personalization,at:number):PomodoroState {
  const long=cycle.session%prefs.sessionsBeforeLongBreak===0;
  return {...cycle,phase:long?'long-break':'short-break',timerId:undefined,deadline:at+(long?prefs.longBreakMinutes:prefs.breakMinutes)*60000,remaining:null};
}
export function readyCycle(cycle:PomodoroState):PomodoroState {
  return {...cycle,session:cycle.session+1,phase:'ready',timerId:undefined,deadline:null,remaining:null};
}
/** A late wake-up closes only the recorded work interval, never invents unattended cycles. */
export function workDeadline(cycle:PomodoroState|null,timer:FocusSnapshot|null,now:number):number|null {
  if(!cycle||cycle.phase!=='work'||!timer||timer.id!==cycle.timerId||timer.status!=='RUNNING')return null;
  if(focusElapsed(timer,now)<cycle.targetSeconds)return null;
  return Date.parse(timer.observedAt)+(cycle.targetSeconds-timer.elapsedSeconds)*1000;
}
