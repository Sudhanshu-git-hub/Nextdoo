import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { eq, sql } from 'drizzle-orm';
import { createDb, runTrackingCycle, runTrackingEvaluation, trackingJobs, trackingEvents, trackingCorrections } from '@nextdoo/db';
const connection=createDb(process.env.DATABASE_URL!,{max:2});
test.afterAll(()=>connection.close());
const origin={Origin:'http://localhost:3100'},headers=()=>({...origin,'Idempotency-Key':randomUUID()});
async function fixture(page:Page){
 const r=await page.request.post('/api/v1/auth/register',{headers:{...origin,'X-Forwarded-For':'198.51.100.170'},data:{email:`tracking-${randomUUID()}@test.local`,password:'tracking-test-password-123',timeZone:'UTC'}});
 expect(r.status()).toBe(200);const {workspaceId}=await r.json();
 const due=new Date();due.setUTCHours(12,0,0,0);
 const t=await page.request.post('/api/v1/tasks',{headers:headers(),data:{workspaceId,title:'Tracking browser task',dueAt:due.toISOString()}});
 expect(t.status()).toBe(200);return{workspaceId,task:await t.json()};
}
test('pending tracking, real worker recovery, evidence and accessible explanations are visible without reloading',async({page})=>{
 const {workspaceId,task}=await fixture(page);await page.goto(`/analytics?taskId=${task.id}`);
 await expect(page.locator('[data-tracking-state]')).toHaveAttribute('data-tracking-state','PENDING');
 await expect(page.locator('[data-tracking-summary-state]')).toHaveAttribute('data-tracking-summary-state','STALE');
 await runTrackingCycle(connection.db,workspaceId);
 await expect(page.locator('[data-tracking-state]')).toHaveAttribute('data-tracking-state','FRESH',{timeout:12000});
 await expect(page.locator('[data-tracking-summary-state]')).toHaveAttribute('data-tracking-summary-state','FRESH',{timeout:12000});
 await page.getByRole('button',{name:'Refresh evidence',exact:true}).click();await expect(page.locator('[data-tracking-event-id]')).toHaveCount(2);await expect(page.locator('[data-tracking-result-id]')).toHaveCount(1);
 const {default:AxeBuilder}=await import('@axe-core/playwright');expect((await new AxeBuilder({page}).include('.tracking-panel').withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze()).violations).toEqual([]);
});
test('five exhausted retries are visible and an audited user retry recovers the real calculation',async({page})=>{
 const {workspaceId,task}=await fixture(page);const constraint=`tracking_browser_${randomUUID().replaceAll('-','')}`;
 await connection.db.execute(sql.raw(`alter table tracking_results add constraint ${constraint} check(task_id <> '${task.id}') not valid`));
 try{
  expect((await page.request.post(`/api/v1/tasks/${task.id}/complete`,{headers:headers(),data:{version:task.version}})).status()).toBe(200);
  await runTrackingCycle(connection.db,workspaceId);
  for(let i=0;i<5;i++){await connection.db.update(trackingJobs).set({nextAttemptAt:sql`clock_timestamp()-interval '1 second'`}).where(eq(trackingJobs.taskId,task.id));await runTrackingEvaluation(connection.db,workspaceId);}
  await page.goto(`/analytics?taskId=${task.id}`);await expect(page.locator('[data-tracking-state]')).toHaveAttribute('data-tracking-state','FAILED');await expect(page.getByText(/Support reference:/)).toBeVisible();
 }finally{await connection.db.execute(sql.raw(`alter table tracking_results drop constraint ${constraint}`));}
 await page.getByLabel('Reason for re-evaluation').fill('Retry after the calculation fault was fixed');await page.getByRole('button',{name:'Request re-evaluation',exact:true}).focus();await page.keyboard.press('Enter');
 await expect(page.getByText(/Re-evaluation queued/)).toBeVisible();await runTrackingCycle(connection.db,workspaceId);
 await expect(page.locator('[data-tracking-state]')).toHaveAttribute('data-tracking-state','FRESH',{timeout:12000});await expect(page.getByRole('heading',{name:'Current stored result',exact:true})).toBeVisible();
 expect(await connection.db.select().from(trackingCorrections).where(eq(trackingCorrections.taskId,task.id))).toHaveLength(1);
});
test('tracking HTTP reads, recovery, replay and pagination remain tenant scoped and origin protected',async({page,playwright})=>{
 const {task}=await fixture(page),url=`/api/v1/tracking/tasks/${task.id}`;
 const current=await(await page.request.get(url)).json(),data={revision:current.freshness.revision,reason:'Verify replay'},key=headers();
 expect((await page.request.post(url+'/recalculate',{headers:{...headers(),Origin:'https://untrusted.invalid'},data})).status()).toBe(403);
 const first=await page.request.post(url+'/recalculate',{headers:key,data});expect(first.status()).toBe(200);
 expect(await(await page.request.post(url+'/recalculate',{headers:key,data})).json()).toEqual(await first.json());
 expect((await page.request.post(url+'/recalculate',{headers:headers(),data})).status()).toBe(409);
 const foreign=await playwright.request.newContext({baseURL:'http://localhost:3100'});
 try{
  expect((await foreign.get(url)).status()).toBe(401);
  await foreign.post('/api/v1/auth/register',{headers:{...origin,'X-Forwarded-For':'198.51.100.171'},data:{email:`tracking-foreign-${randomUUID()}@test.local`,password:'tracking-test-password-123'}});
  expect((await foreign.get(url)).status()).toBe(404);expect((await foreign.post(url+'/recalculate',{headers:headers(),data})).status()).toBe(404);
  expect((await(await foreign.get('/api/v1/tracking/status')).json()).data).toEqual([]);
 }finally{await foreign.dispose();}
});
test('lost recovery acknowledgement keeps the reason and replays the same durable command',async({page})=>{
 const {task}=await fixture(page);await page.goto(`/analytics?taskId=${task.id}`);let lost=false;const keys:string[]=[];
 await page.route(`**/api/v1/tracking/tasks/${task.id}/recalculate`,async route=>{
  keys.push(route.request().headers()['idempotency-key']!);if(lost)return route.continue();lost=true;expect((await route.fetch()).status()).toBe(200);await route.abort('failed');
 });
 await page.getByLabel('Reason for re-evaluation').fill('Keep this reason after a lost response');await page.getByRole('button',{name:'Request re-evaluation',exact:true}).click();
 await expect(page.locator('.tracking-panel [role="alert"]')).toContainText('not acknowledged');await expect(page.getByLabel('Reason for re-evaluation')).toHaveValue('Keep this reason after a lost response');
 await page.getByRole('button',{name:'Retry same request',exact:true}).click();await expect(page.getByText(/Re-evaluation queued/)).toBeVisible();expect(keys).toHaveLength(2);expect(keys[0]).toBe(keys[1]);
 expect(await connection.db.select().from(trackingCorrections).where(eq(trackingCorrections.taskId,task.id))).toHaveLength(1);
});
test('failed evidence continuation keeps loaded rows and can resume without duplicates',async({page})=>{
 const {workspaceId,task}=await fixture(page);
 await connection.db.insert(trackingEvents).values(Array.from({length:51},()=>({id:randomUUID(),workspaceId,taskId:task.id,type:'TASK_STARTED' as const,occurredAt:new Date(),idempotencyKey:randomUUID()})));
 await page.goto(`/analytics?taskId=${task.id}`);await expect(page.locator('[data-tracking-event-id]')).toHaveCount(50);
 let failed=false;await page.route(`**/api/v1/tracking/tasks/${task.id}?eventCursor=*`,async route=>{if(failed)return route.continue();failed=true;await route.abort('failed');});
 await page.getByRole('button',{name:'Load more source events',exact:true}).click();await expect(page.locator('.tracking-panel [role="alert"]')).toBeVisible();await expect(page.locator('[data-tracking-event-id]')).toHaveCount(50);
 await page.getByRole('button',{name:'Load more source events',exact:true}).click();await expect(page.locator('[data-tracking-event-id]')).toHaveCount(53);
});
test('a slow pre-command poll cannot block or overwrite the committed recovery status',async({page})=>{
 const {workspaceId,task}=await fixture(page);await runTrackingCycle(connection.db,workspaceId);await page.goto(`/analytics?taskId=${task.id}`);
 await expect(page.locator('[data-tracking-state]')).toHaveAttribute('data-tracking-state','FRESH');
 let release!:()=>void,held!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>held=resolve);let intercepted=false;
 await page.route(`**/api/v1/tracking/tasks/${task.id}`,async route=>{if(intercepted)return route.continue();intercepted=true;const old=await route.fetch();held();await gate;await route.fulfill({response:old}).catch(()=>{});});
 try{
  await started;
  await page.getByLabel('Reason for re-evaluation').fill('Refresh while an old poll is held');await page.getByRole('button',{name:'Request re-evaluation',exact:true}).click();
  await expect(page.getByText(/Re-evaluation queued/)).toBeVisible();await expect(page.locator('[data-tracking-state]')).toHaveAttribute('data-tracking-state','PENDING');
 }finally{release();}
 await expect(page.locator('[data-tracking-state]')).toHaveAttribute('data-tracking-state','PENDING');
 await runTrackingCycle(connection.db,workspaceId);await expect(page.locator('[data-tracking-state]')).toHaveAttribute('data-tracking-state','FRESH',{timeout:12000});
});
