import { randomUUID } from 'node:crypto';
import { test,expect,type Page } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { createDb,calendarConnections,calendarEvents } from '@nextdoo/db';
const connection=createDb(process.env.DATABASE_URL!,{max:2});
test.afterAll(()=>connection.close());
let ip=1;
const headers=()=>({Origin:'http://localhost:3100','Idempotency-Key':randomUUID()});
async function setup(page:Page){const r=await page.request.post('/api/v1/auth/register',{headers:{...headers(),'X-Forwarded-For':`192.0.2.${ip++}`},data:{email:`closure-${randomUUID()}@test.local`,password:'closure-browser-password-123',timeZone:'UTC'}});expect(r.status()).toBe(200);const u=await r.json();return {...u,userId:u.id};}
async function post(page:Page,path:string,data:unknown){const r=await page.request.post('/api/v1'+path,{headers:headers(),data});expect(r.status(),await r.text()).toBe(200);return r.json();}
const date=(daysAgo:number)=>new Date(Date.now()-daysAgo*86400000).toISOString().slice(0,10);

test('task reminders render the filtered history and preserve archived/deleted/foreign boundaries',async({page,browser})=>{
 const {workspaceId}=await setup(page),task=await post(page,'/tasks',{workspaceId,title:'Reminder destination'}),other=await post(page,'/tasks',{workspaceId,title:'Other task reminder'});
 const scheduledAt=new Date(Date.now()+3600000).toISOString();
 const own=await post(page,'/reminders',{taskId:task.id,taskVersion:1,channel:'WEB',scheduledAt});
 const foreignReminder=await post(page,'/reminders',{taskId:other.id,taskVersion:1,channel:'WEB',scheduledAt});
 await page.goto('/tasks/'+task.id);await page.getByRole('link',{name:'Task reminders',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Reminders for Reminder destination',exact:true})).toBeVisible();
 await expect(page.locator(`[data-reminder-id="${own.id}"]`)).toBeVisible();
 await expect(page.locator(`[data-reminder-id="${foreignReminder.id}"]`)).toHaveCount(0);
 await post(page,`/tasks/${task.id}/archive`,{version:1});await page.reload();
 await expect(page.getByRole('button',{name:'Schedule reminder',exact:true})).toBeDisabled();
 const context=await browser.newContext({baseURL:'http://localhost:3100'});try{const otherPage=await context.newPage();await setup(otherPage);await otherPage.goto('/notifications?taskId='+task.id);await expect(otherPage.getByRole('heading',{name:'Reminders for Reminder destination',exact:true})).toHaveCount(0);expect((await otherPage.request.get('/api/v1/tasks/'+task.id)).status()).toBe(404);}finally{await context.close();}
 expect((await page.request.delete('/api/v1/tasks/'+task.id,{headers:headers(),data:{version:2}})).status()).toBe(200);
 await page.reload();await expect(page.getByRole('heading',{name:'Reminders for Reminder destination',exact:true})).toHaveCount(0);
});
test('retained Calendar reference becomes unavailable on suspension and navigable again on restore',async({page})=>{
 const {userId,workspaceId}=await setup(page),connectionId=randomUUID(),id=randomUUID();
 await connection.db.insert(calendarConnections).values({id:connectionId,userId,workspaceId,provider:'google',status:'ACTIVE',mode:'READ_ONLY'});
 await connection.db.insert(calendarEvents).values({id,workspaceId,connectionId,externalId:'closure-browser',title:'Retained Calendar target',startsAt:new Date(),endsAt:new Date(Date.now()+3600000)});
 const note=await post(page,'/knowledge/notes',{title:'Calendar relation note'});
 await post(page,`/knowledge/notes/${note.id}/relations`,{version:1,kind:'calendar',targetId:id,linked:true});
 await page.goto('/knowledge/notes/'+note.id);await expect(page.getByRole('link',{name:'Retained Calendar target',exact:true})).toBeVisible();
 await connection.db.update(calendarConnections).set({status:'SUSPENDED'}).where(eq(calendarConnections.id,connectionId));
 await page.getByRole('button',{name:'Reload saved version',exact:true}).click();
 await expect(page.getByRole('region',{name:'Relations',exact:true})).toContainText('Unavailable calendar');await expect(page.getByRole('link',{name:'Retained Calendar target',exact:true})).toHaveCount(0);
 expect((await (await page.request.get('/api/v1/knowledge/targets?kind=calendar')).json()).data).toHaveLength(0);
 await connection.db.update(calendarConnections).set({status:'ACTIVE'}).where(eq(calendarConnections.id,connectionId));
 await page.getByRole('button',{name:'Reload saved version',exact:true}).click();await page.getByRole('link',{name:'Retained Calendar target',exact:true}).click();await expect(page.getByRole('heading',{name:'Retained Calendar target',exact:true})).toBeVisible();
});
test('Insights and exports enforce allowed, forbidden and comparison history with a visible error',async({page})=>{
 await setup(page);await page.goto('/insights?period=day&date='+date(1));await expect(page.locator('.insights-kpis').first()).toBeVisible();
 for(const format of ['csv','json'])expect((await page.request.get(`/api/v1/insights/export?period=day&date=${date(1)}&format=${format}`)).status()).toBe(200);
 await page.goto('/insights?period=day&date='+date(40));await expect(page.locator('.insights-view').getByRole('alert')).toContainText('last 30 days');
 for(const format of ['csv','json'])expect((await page.request.get(`/api/v1/insights/export?period=day&date=${date(40)}&format=${format}`)).status()).toBe(402);
 await page.goto('/settings?section=all');await page.getByRole('checkbox',{name:'Hide period comparisons'}).uncheck();await expect(page.getByRole('checkbox',{name:'Hide period comparisons'})).toBeEnabled();
 await page.goto(`/insights?period=custom&from=${date(30)}&to=${date(25)}&compare=true`);await expect(page.locator('.insights-view').getByRole('alert')).toContainText('last 30 days');
 await page.goto(`/insights?period=day&date=${date(2)}&compare=true`);await expect(page.getByText('Completed tasks change',{exact:true})).toBeVisible();
});
test('unsupported offline editing keeps its draft, reports connection requirement and does not save',async({page})=>{
 const {workspaceId}=await setup(page),task=await post(page,'/tasks',{workspaceId,title:'Keep original offline'});
 await page.goto('/tasks');await page.getByRole('button',{name:'Edit "Keep original offline"',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Edit task',exact:true});await expect(dialog.getByLabel('Title',{exact:true})).toHaveValue('Keep original offline');
 await page.context().setOffline(true);await dialog.getByLabel('Title',{exact:true}).fill('Unsaved offline draft');await dialog.getByRole('button',{name:'Save changes',exact:true}).click();
 await expect(dialog.getByRole('alert').first()).toContainText('Requires connection');await expect(dialog.getByLabel('Title',{exact:true})).toHaveValue('Unsaved offline draft');
 await expect(page.locator('.offline-badge')).toContainText('0 changes queued');await page.context().setOffline(false);
 expect((await (await page.request.get('/api/v1/tasks/'+task.id)).json()).title).toBe('Keep original offline');
});
test('withheld Google settings expose native/ICS scope without a connection action',async({page})=>{
 await setup(page);await page.route('**/api/v1/calendar/connections',route=>route.fulfill({json:{enabled:false,connections:[]}}));await page.goto('/settings?section=all');
 await expect(page.getByTestId('calendar-card')).toContainText('Google Calendar is withheld');await expect(page.getByTestId('calendar-connect')).toHaveCount(0);
});

