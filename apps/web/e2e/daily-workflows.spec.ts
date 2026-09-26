import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const origin={Origin:'http://localhost:3100'};
let address=130;
async function setup(page:Page,timeZone='UTC') {
  const response=await page.request.post('/api/v1/auth/register',{headers:{...origin,'X-Forwarded-For':`192.0.2.${address++}`},data:{email:`daily-${randomUUID()}@test.local`,password:'daily-test-password-123',timeZone}});
  expect(response.status()).toBe(200);return response.json();
}
async function create(page:Page,workspaceId:string,title:string,dueAt?:string) {
  const response=await page.request.post('/api/v1/tasks',{headers:{...origin,'Idempotency-Key':randomUUID()},data:{workspaceId,title,dueAt,priority:'HIGH'}});expect(response.status()).toBe(200);return response.json();
}
test('daily navigation separates tomorrow, horizons, overdue, backlog and completed',async({page})=>{
  const user=await setup(page), workspaceId=user.workspaceId;
  const date=(offset:number)=>{const d=new Date();d.setUTCDate(d.getUTCDate()+offset);d.setUTCHours(12,0,0,0);return d.toISOString();};
  const tomorrow=await create(page,workspaceId,'Tomorrow work',date(1));await create(page,workspaceId,'Later work',date(10));await create(page,workspaceId,'Overdue work',date(-1));await create(page,workspaceId,'Unscheduled work');
  await page.goto('/tomorrow');await expect(page.getByRole('button',{name:'Edit "Tomorrow work"',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Edit "Later work"',exact:true})).toHaveCount(0);
  await page.goto('/upcoming');await page.getByLabel('Upcoming horizon').selectOption('14');await expect(page.getByRole('button',{name:'Edit "Later work"',exact:true})).toBeVisible();await page.getByLabel('Upcoming horizon').selectOption('3');await expect(page.getByRole('button',{name:'Edit "Later work"',exact:true})).toHaveCount(0);
  await page.goto('/backlog');await expect(page.getByRole('button',{name:'Edit "Unscheduled work"',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Edit "Overdue work"',exact:true})).toHaveCount(0);await page.getByLabel('Backlog queue').selectOption('overdue');await expect(page.getByRole('button',{name:'Edit "Overdue work"',exact:true})).toBeVisible();
  expect((await page.request.post(`/api/v1/tasks/${tomorrow.id}/complete`,{headers:{...origin,'Idempotency-Key':randomUUID()},data:{version:tomorrow.version}})).ok()).toBe(true);
  await page.goto('/completed');await expect(page.getByRole('button',{name:'Mark "Tomorrow work" as not done',exact:true})).toBeVisible();
  expect((await new AxeBuilder({page}).analyze()).violations).toEqual([]);
});
test('Home cards persist, notes use Knowledge, and Home is a personalized start page',async({page})=>{
  const user=await setup(page);await create(page,user.workspaceId,'Important work');
  await page.goto('/home');await expect(page.getByRole('heading',{name:/Good /})).toBeVisible();await expect(page.getByRole('region',{name:'Priorities',exact:true}).getByRole('link',{name:'Important work'})).toBeVisible();
  await page.getByRole('button',{name:'Manage cards',exact:true}).click();await page.getByRole('region',{name:'Manage Home cards'}).getByLabel('Quick Notes',{exact:true}).click();await expect(page.getByRole('region',{name:'Manage Home cards'}).getByLabel('Quick Notes',{exact:true})).toBeChecked();
  const notes=page.getByRole('region',{name:'Quick Notes',exact:true});await notes.getByLabel('Note title',{exact:true}).fill('A real Home note');await notes.getByLabel('Note',{exact:true}).fill('Saved through Knowledge');await notes.getByRole('button',{name:'Save note',exact:true}).click();await expect(notes.getByRole('link',{name:'Open note',exact:true})).toBeVisible();
  await page.reload();await expect(notes).toBeVisible();
  expect((await page.request.patch('/api/v1/preferences/personalization',{headers:{...origin,'Idempotency-Key':randomUUID()},data:{startPage:'/home'}})).ok()).toBe(true);await page.goto('/');await expect(page).toHaveURL(/\/home$/);
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);expect((await new AxeBuilder({page}).analyze()).violations).toEqual([]);
  await page.screenshot({path:'test-results/task-home-mobile.png',fullPage:true});await page.getByRole('navigation',{name:'Mobile navigation'}).getByLabel('Go to',{exact:true}).selectOption('/tomorrow');await expect(page).toHaveURL(/\/tomorrow$/);
});
test('Focus actions survive offline pause/resume and reconnect without duplicate credit',async({page,context})=>{
  const user=await setup(page),task=await create(page,user.workspaceId,'Offline focus task');
  await page.goto(`/focus?taskId=${task.id}`);await expect(page.getByRole('button',{name:'Start a focus timer for Offline focus task',exact:true})).toBeEnabled();
  await context.setOffline(true);await page.getByRole('button',{name:'Start a focus timer for Offline focus task',exact:true}).click();await page.getByRole('button',{name:'Pause',exact:true}).click();await page.getByRole('button',{name:'Resume',exact:true}).click();await page.getByRole('button',{name:'Stop and save',exact:true}).click();await expect(page.getByText('No timer running',{exact:true})).toBeVisible();await expect(page.getByText('4 focus actions saved on this device, awaiting sync.',{exact:true})).toBeVisible();
  await context.setOffline(false);await expect(page.getByText(/focus actions? saved on this device/)).toHaveCount(0,{timeout:30000});await page.reload();await expect(page.getByText('No timer running',{exact:true})).toBeVisible();
  await page.getByLabel('Task for correction').selectOption(task.id);await page.getByLabel('Adjustment in minutes').fill('3');await page.getByLabel('Reason',{exact:true}).fill('Missed work');await page.getByRole('button',{name:'Save time correction',exact:true}).click();await expect(page.getByText(/focus actions? saved on this device/)).toHaveCount(0,{timeout:30000});
  await expect.poll(async()=>{const detail=await page.request.get(`/api/v1/tasks/${task.id}`);return (await detail.json()).actualMinutes;},{timeout:30000}).toBeGreaterThanOrEqual(3);
});
test('Pomodoro saves its preferences and a break never starts a work timer',async({page})=>{
  const user=await setup(page),task=await create(page,user.workspaceId,'Pomodoro task');await page.goto('/focus');
  await page.getByLabel('Timer mode').selectOption('pomodoro');await expect(page.getByLabel('Work minutes')).toHaveValue('25');await page.getByRole('button',{name:'Start a focus timer for Pomodoro task',exact:true}).click();await page.getByRole('button',{name:'Finish work and take a break',exact:true}).click();await expect(page.getByText('Break — no work time is recorded',{exact:true})).toBeVisible();await expect(page.getByText(/focus actions? saved on this device/)).toHaveCount(0,{timeout:30000});
  await page.reload();await expect(page.getByText('Break — no work time is recorded',{exact:true})).toBeVisible();expect((await (await page.request.get('/api/v1/timers')).json()).timer).toBeNull();await page.getByRole('button',{name:'End break',exact:true}).click();await expect(page.getByRole('button',{name:`Start a focus timer for Pomodoro task`,exact:true})).toBeEnabled();
  await page.setViewportSize({width:390,height:844});expect((await new AxeBuilder({page}).analyze()).violations).toEqual([]);await page.screenshot({path:'test-results/task-focus-mobile.png',fullPage:true});expect(task.id).toBeTruthy();
});
test('workspace-local Tomorrow and browser date filters agree across a DST boundary',async({page})=>{
  const user=await setup(page,'America/New_York');
  await create(page,user.workspaceId,'Before local tomorrow','2026-03-08T04:59:59Z');
  await create(page,user.workspaceId,'First instant tomorrow','2026-03-08T05:00:00Z');
  await create(page,user.workspaceId,'Last instant tomorrow','2026-03-09T03:59:59.999999Z');
  await create(page,user.workspaceId,'After local tomorrow','2026-03-09T04:00:00Z');
  await page.clock.install({time:new Date('2026-03-07T23:00:00Z')});await page.goto('/tomorrow');
  await expect(page.locator('[data-task-id]')).toHaveCount(2);await expect(page.getByRole('button',{name:'Edit "Last instant tomorrow"',exact:true})).toBeVisible();
  await page.goto('/tasks');await page.getByLabel('Due from',{exact:true}).fill('2026-03-08');await page.getByLabel('Due through',{exact:true}).fill('2026-03-08');await page.getByRole('button',{name:'Apply filters',exact:true}).click();await expect(page.locator('[data-task-id]')).toHaveCount(2);
});
test('an interrupted timer acknowledgement survives page reload and clears after reconnect',async({page})=>{
  const user=await setup(page);await create(page,user.workspaceId,'Reload focus');await page.goto('/focus');
  await page.route('**/api/v1/sync/push',route=>route.abort('failed'));
  await page.getByRole('button',{name:'Start a focus timer for Reload focus',exact:true}).click();await page.getByRole('button',{name:'Pause',exact:true}).click();
  await page.reload();await expect(page.getByRole('button',{name:'Resume',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Stop and save',exact:true}).click();await page.unroute('**/api/v1/sync/push');
  await expect(page.getByText(/focus actions? saved on this device/)).toHaveCount(0,{timeout:30000});await page.reload();await expect(page.getByText('No timer running',{exact:true})).toBeVisible();
});
test('failed Home layout saves retain the previous layout and show a recoverable error',async({page})=>{
  await setup(page);await page.goto('/home');await page.getByRole('button',{name:'Manage cards',exact:true}).click();
  await page.route('**/api/v1/preferences/personalization',route=>route.request().method()==='PATCH'?route.fulfill({status:503,contentType:'application/problem+json',body:JSON.stringify({detail:'Unavailable',code:'INTERNAL_ERROR',status:503})}):route.continue());
  await page.getByRole('region',{name:'Manage Home cards'}).getByLabel('Quick Notes',{exact:true}).click();await expect(page.getByText('Could not save your card layout. Your saved layout is still applied.',{exact:true})).toBeVisible();await expect(page.getByRole('region',{name:'Quick Notes',exact:true})).toHaveCount(0);
  await page.unroute('**/api/v1/preferences/personalization');await page.getByRole('region',{name:'Manage Home cards'}).getByLabel('Quick Notes',{exact:true}).click();await expect(page.getByRole('region',{name:'Quick Notes',exact:true})).toBeVisible();
});
