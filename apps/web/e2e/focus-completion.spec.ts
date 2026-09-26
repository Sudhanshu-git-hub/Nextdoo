import { randomUUID } from 'node:crypto';
import { test,expect,type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const headers=()=>({Origin:'http://localhost:3100','Idempotency-Key':randomUUID()});
let address=170;
async function setup(page:Page){const result=await page.request.post('/api/v1/auth/register',{headers:{...headers(),'X-Forwarded-For':`192.0.2.${address++}`},data:{email:`focus-more-${randomUUID()}@test.local`,password:'focus-more-test-password',timeZone:'UTC'}});expect(result.ok()).toBe(true);return result.json();}
async function task(page:Page,workspaceId:string,title:string,extra={}){const result=await page.request.post('/api/v1/tasks',{headers:headers(),data:{workspaceId,title,estimateMinutes:60,priority:'HIGH',...extra}});expect(result.ok()).toBe(true);return result.json();}
async function synced(page:Page){await expect(page.getByText(/focus actions? saved on this device/)).toHaveCount(0,{timeout:30000});}
test('Home to Today to Focus supports selected task, planned time, pause/resume, actual time and completion',async({page})=>{
  const user=await setup(page),main=await task(page,user.workspaceId,'Write assignment',{dueAt:new Date().toISOString()}),child=await task(page,user.workspaceId,'Research',{parentTaskId:main.id});
  await page.goto('/home');await page.getByRole('navigation',{name:'Main navigation'}).getByRole('link',{name:'Today',exact:true}).click();
  await page.locator(`[data-task-id="${main.id}"]`).getByRole('link',{name:'Start task timer',exact:true}).click();
  const panel=page.getByRole('region',{name:'Selected focus task'});await expect(panel.getByRole('heading',{name:'Write assignment',exact:true})).toBeVisible();await expect(panel.getByText('01:00:00',{exact:true})).toBeVisible();await expect(panel.getByRole('link',{name:'Research',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Start a focus timer for Write assignment',exact:true}).click();await page.getByRole('button',{name:'Pause',exact:true}).click();await page.getByRole('button',{name:'Resume',exact:true}).click();await page.getByRole('button',{name:'Stop and save',exact:true}).click();await synced(page);
  const start=new Date(Date.now()-3600000).toISOString().slice(0,16),end=new Date(Date.now()-1800000).toISOString().slice(0,16);
  await page.getByLabel('Entry start',{exact:true}).fill(start);await page.getByLabel('Entry end',{exact:true}).fill(end);await page.getByLabel('Entry note',{exact:true}).fill('Research session');await page.getByRole('button',{name:'Add time entry',exact:true}).click();
  await expect.poll(async()=>(await (await page.request.get(`/api/v1/tasks/${main.id}`)).json()).actualMinutes).toBeGreaterThanOrEqual(30);
  await page.getByRole('button',{name:'Complete subtask Research',exact:true}).click();await expect.poll(async()=>(await (await page.request.get(`/api/v1/tasks/${child.id}`)).json()).status).toBe('COMPLETED');
  await panel.getByRole('button',{name:'Complete task',exact:true}).click();await expect.poll(async()=>(await (await page.request.get(`/api/v1/tasks/${main.id}`)).json()).status).toBe('COMPLETED');
  await page.goto('/home');await expect(page.getByRole('region',{name:'Focus',exact:true}).getByText('No active focus session',{exact:true})).toBeVisible();expect((await (await page.request.get('/api/v1/home')).json()).focusMinutes).toBeGreaterThanOrEqual(30);
});
test('Home configures, reorders and restores its persisted card layout',async({page})=>{
  await setup(page);await page.goto('/home');await page.getByRole('button',{name:'Manage cards',exact:true}).click();
  const manage=page.getByRole('region',{name:'Manage Home cards'});await manage.getByLabel('Quick Notes',{exact:true}).click();await expect(manage.getByLabel('Quick Notes',{exact:true})).toBeChecked();
  await page.getByLabel('Upcoming card horizon').selectOption('14');await expect(page.getByLabel('Upcoming card horizon')).toHaveValue('14');await expect(page.getByRole('link',{name:'Open Upcoming',exact:true})).toHaveAttribute('href','/upcoming?days=14');
  const notes=page.getByRole('region',{name:'Quick Notes',exact:true});await notes.getByLabel('Quick Notes card menu',{exact:true}).click();await notes.getByRole('button',{name:'Move earlier',exact:true}).click();
  await expect.poll(async()=>(await (await page.request.get('/api/v1/preferences/personalization')).json()).homeCards.indexOf('notes')).toBe(7);
  await page.reload();await expect(notes).toBeVisible();await page.getByRole('button',{name:'Manage cards',exact:true}).click();await page.getByRole('button',{name:'Restore default layout',exact:true}).click();await expect(notes).toHaveCount(0);await expect(page.getByLabel('Upcoming card horizon')).toHaveValue('7');
  await page.reload();await expect(notes).toHaveCount(0);await page.setViewportSize({width:768,height:1024});expect((await new AxeBuilder({page}).analyze()).violations).toEqual([]);
});
test('Pomodoro background deadline, short and long breaks, pause, skip and auto-start retain their state',async({page,context})=>{
  const user=await setup(page),main=await task(page,user.workspaceId,'Cycle task');await page.request.patch('/api/v1/preferences/personalization',{headers:headers(),data:{focusMode:'pomodoro',focusMinutes:1,breakMinutes:1,longBreakMinutes:2,sessionsBeforeLongBreak:2}});
  await page.goto(`/focus?taskId=${main.id}`);await page.clock.install();await context.setOffline(true);
  await page.getByRole('button',{name:'Start a focus timer for Cycle task',exact:true}).click();await expect(page.getByRole('button',{name:'Pause',exact:true})).toBeVisible();await page.clock.fastForward(90000);await expect(page.getByText('Session 1 · Short break',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Pause break',exact:true}).click();const timer=page.getByRole('timer');const frozen=await timer.innerText();await page.clock.fastForward(120000);await expect(timer).toHaveText(frozen);await page.getByRole('button',{name:'Resume break',exact:true}).click();
  await page.getByRole('button',{name:'End break',exact:true}).click();await page.getByRole('button',{name:'Start a focus timer for Cycle task',exact:true}).click();await page.getByRole('button',{name:'Skip work session',exact:true}).click();await expect(page.getByText('Session 2 · Long break',{exact:true})).toBeVisible();
  await context.setOffline(false);await synced(page);await page.reload();await expect(page.getByText('Session 2 · Long break',{exact:true})).toBeVisible();await page.getByLabel('Auto-start next work session').click();await expect(page.getByLabel('Auto-start next work session')).toBeChecked();await page.clock.fastForward(180000);await expect(page.getByText('Session 3 · Work',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Pause',exact:true})).toBeVisible();await synced(page);await expect(page.getByText(/A session changed or an action was rejected/)).toHaveCount(0);expect((await (await page.request.get('/api/v1/timers')).json()).timer.taskId).toBe(main.id);
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect((await new AxeBuilder({page}).analyze()).violations).toEqual([]);await page.screenshot({path:'test-results/focus-completion-mobile.png',fullPage:true});
});
test('manual dated entries survive offline, can be corrected and removed, and reject invalid dates',async({page,context})=>{
  const user=await setup(page),main=await task(page,user.workspaceId,'Manual task');await page.goto(`/focus?taskId=${main.id}`);await expect(page.getByLabel('Entry start')).toBeVisible();await context.setOffline(true);
  await page.getByLabel('Entry start').fill('2026-09-24T10:00');await page.getByLabel('Entry end').fill('2026-09-24T09:00');await page.getByLabel('Entry note').fill('Research');await page.getByRole('button',{name:'Add time entry',exact:true}).click();await expect(page.getByText('End must follow start, with no more than 24 hours of work.',{exact:true})).toBeVisible();
  await page.getByLabel('Entry end').fill('2026-09-24T10:45');await page.getByRole('button',{name:'Add time entry',exact:true}).click();await expect(page.getByText('Time entry saved on this device, awaiting sync.',{exact:true})).toBeVisible();await context.setOffline(false);
  await expect(page.getByRole('button',{name:'Correct entry',exact:true})).toBeVisible({timeout:30000});await page.getByRole('button',{name:'Correct entry',exact:true}).click();await page.getByLabel('Entry end').fill('2026-09-24T10:30');await page.getByRole('button',{name:'Save entry correction',exact:true}).click();await expect.poll(async()=>(await (await page.request.get(`/api/v1/tasks/${main.id}`)).json()).actualMinutes).toBe(30);
  await page.getByRole('button',{name:'Correct entry',exact:true}).click();await page.getByLabel('Entry note').fill('Remove duplicate');await page.getByRole('button',{name:'Remove this entry',exact:true}).click();await expect.poll(async()=>(await (await page.request.get(`/api/v1/tasks/${main.id}`)).json()).actualMinutes).toBe(0);
});
test('Focus picker searches and switches tasks without inventing a selection',async({page})=>{
  const user=await setup(page);await task(page,user.workspaceId,'Alpha task');await task(page,user.workspaceId,'Beta task');await page.goto('/focus');await expect(page.getByText('Choose a task to begin focusing.',{exact:true})).toBeVisible();
  await page.getByLabel('Find a focus task').fill('Beta');await expect(page.getByRole('button',{name:'Start a focus timer for Alpha task',exact:true})).toHaveCount(0);await page.getByRole('button',{name:'Beta task',exact:true}).click();await expect(page.getByRole('region',{name:'Selected focus task'}).getByRole('heading',{name:'Beta task',exact:true})).toBeVisible();
  await page.getByLabel('Find a focus task').fill('Alpha');await page.getByRole('button',{name:'Alpha task',exact:true}).click();await expect(page.getByRole('region',{name:'Selected focus task'}).getByRole('heading',{name:'Alpha task',exact:true})).toBeVisible();
});

test('completion remains durable offline and stale corrections are retained for review',async({page,context})=>{
  const user=await setup(page),main=await task(page,user.workspaceId,'Offline completion');await page.goto(`/focus?taskId=${main.id}`);
  await expect(page.getByRole('button',{name:'Complete task',exact:true})).toBeEnabled();await context.setOffline(true);
  await page.getByRole('button',{name:'Start a focus timer for Offline completion',exact:true}).click();await page.getByRole('button',{name:'Pause',exact:true}).click();await page.getByRole('button',{name:'Complete task',exact:true}).click();await expect(page.getByText('3 focus actions saved on this device, awaiting sync.',{exact:true})).toBeVisible();
  await context.setOffline(false);await expect.poll(async()=>(await (await page.request.get(`/api/v1/tasks/${main.id}`)).json()).status,{timeout:30000}).toBe('COMPLETED');
  expect((await (await page.request.get('/api/v1/timers')).json()).timer).toBeNull();
  await page.getByLabel('Entry start').fill('2026-09-24T10:00');await page.getByLabel('Entry end').fill('2026-09-24T10:15');await page.getByLabel('Entry note').fill('Completed task work');await page.getByRole('button',{name:'Add time entry',exact:true}).click();await expect(page.getByRole('button',{name:'Correct entry',exact:true})).toBeVisible({timeout:30000});
  const entry=(await (await page.request.get(`/api/v1/time-entries?taskId=${main.id}`)).json()).entries[0];await page.getByRole('button',{name:'Correct entry',exact:true}).click();
  await page.request.post('/api/v1/sync/push',{headers:headers(),data:{workspaceId:user.workspaceId,deviceId:'other-device',mutations:[{mutationId:randomUUID(),entityId:randomUUID(),entityType:'timer_session',operation:'update',baseVersion:null,createdAt:new Date().toISOString(),payload:{action:'entry-remove',entryId:entry.id,version:entry.version,note:'Changed elsewhere'}}]}});
  await page.getByLabel('Entry end').fill('2026-09-24T10:20');await page.getByRole('button',{name:'Save entry correction',exact:true}).click();await expect(page.getByText(/A session changed or an action was rejected/)).toBeVisible({timeout:30000});expect((await (await page.request.get(`/api/v1/tasks/${main.id}`)).json()).actualMinutes).toBe(0);
});
