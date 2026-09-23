import { randomUUID } from 'node:crypto';
import { expect,test,type Page } from '@playwright/test';
import { createTrackerDefinition } from '@nextdoo/core';
const origin={Origin:'http://localhost:3100'},headers=()=>({...origin,'Idempotency-Key':randomUUID()});
async function post(page:Page,path:string,data:object){const r=await page.request.post('/api/v1'+path,{headers:headers(),data});expect(r.status(),await r.text()).toBe(200);return r.json();}
async function fixture(page:Page){
  const r=await page.request.post('/api/v1/auth/register',{headers:{...origin,'X-Forwarded-For':`198.51.100.${100+Math.floor(Math.random()*100)}`},data:{email:`connected-${randomUUID()}@test.local`,password:'connected-test-password-123',timeZone:'UTC'}});expect(r.status()).toBe(200);
  const {workspaceId}=await r.json(),day=new Date().toISOString().slice(0,10),dueAt=day+'T12:00:00Z';
  const goal=await post(page,'/goals',{workspaceId,title:'Connected goal',dueAt});
  const milestone=await post(page,`/goals/${goal.id}/milestones`,{title:'Connected milestone',dueAt});
  const task=await post(page,'/tasks',{workspaceId,title:'Connected task',dueAt});
  await post(page,`/milestones/${milestone.id}/tasks`,{version:1,taskId:task.id,linked:true});
  const tracker=await post(page,'/trackers',{workspaceId,name:'Connected tracker',startDate:'2026-01-01',timeZone:'UTC',definition:createTrackerDefinition()});
  await post(page,`/trackers/${tracker.id}/tasks`,{version:1,taskId:task.id,linked:true});
  const database=await post(page,'/knowledge/databases',{name:'Connected library',properties:[{name:'Title',type:'TITLE'},{name:'Date',type:'DATE'}]});
  const record=await post(page,`/knowledge/databases/${database.id}/records`,{title:'Connected reference',values:{[database.properties.find((p:{type:string})=>p.type==='DATE').id]:day}});
  return {goal,milestone,task,tracker,record,day};
}
test('links Knowledge from a task and navigates to its goal, milestone and tracker',async({page})=>{
  const f=await fixture(page);await page.goto(`/tasks/${f.task.id}`);
  const context=page.getByRole('region',{name:'Connected work',exact:true});await expect(context.getByRole('link',{name:'Connected goal',exact:true})).toBeVisible();
  await expect(context.getByRole('link',{name:'Connected milestone',exact:true})).toHaveAttribute('href',`/goals/${f.goal.id}#milestone-${f.milestone.id}`);
  await expect(context.getByRole('link',{name:'Connected tracker',exact:true})).toBeVisible();
  const refs=page.getByRole('region',{name:'Knowledge references',exact:true});await refs.getByRole('button',{name:'Link Knowledge',exact:true}).click();
  await refs.getByRole('button',{name:'Link reference Connected reference',exact:true}).click();
  await refs.getByRole('link',{name:'Connected reference',exact:true}).click();await expect(page).toHaveURL(`/knowledge/records/${f.record.id}`);
  await expect(page.getByRole('region',{name:'Relations',exact:true})).toContainText('Connected task');
});
test('links references directly from Goal, Milestone and Tracker',async({page})=>{
  const f=await fixture(page);
  for(const [url,index] of [[`/goals/${f.goal.id}`,0],[`/goals/${f.goal.id}`,1],[`/trackers/${f.tracker.id}`,0]] as const){
    await page.goto(url);const refs=page.getByRole('region',{name:'Knowledge references',exact:true}).nth(index);
    await refs.getByRole('button',{name:'Link Knowledge',exact:true}).click();await refs.getByRole('button',{name:'Link reference Connected reference',exact:true}).click();
    await expect(refs.getByRole('link',{name:'Connected reference',exact:true})).toBeVisible();
  }
  const relations=await (await page.request.get(`/api/v1/knowledge/records/${f.record.id}`)).json();expect(relations.relations.data.map((r:{kind:string})=>r.kind).sort()).toEqual(['goal','milestone','tracker']);
});
test('finds typed search results and opens a real task on mobile',async({page})=>{
  const f=await fixture(page);await page.setViewportSize({width:390,height:844});await page.goto('/search');
  await page.getByLabel('Search all your work').fill('Connected');await page.getByRole('button',{name:'Search',exact:true}).click();
  await page.getByLabel('Result type').selectOption('task');await expect(page.getByRole('link',{name:'Connected task',exact:true})).toBeVisible();await expect(page.getByRole('link',{name:'Connected goal',exact:true})).toHaveCount(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.getByRole('link',{name:'Connected task',exact:true}).click();await expect(page).toHaveURL(`/tasks/${f.task.id}`);await expect(page.getByRole('region',{name:'Connected work',exact:true})).toBeVisible();
});
test('shows connected Today context and toggles real Calendar dates',async({page})=>{
  const f=await fixture(page);await post(page,`/knowledge/records/${f.record.id}/relations`,{version:1,kind:'task',targetId:f.task.id,linked:true});
  await page.goto('/today');const today=page.getByRole('region',{name:'Connected today',exact:true});
  for(const title of ['Connected goal','Connected milestone','Connected reference','Connected tracker'])await expect(today.getByRole('link',{name:title,exact:true}).first()).toBeVisible();
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:test.info().outputPath('connected-today-mobile.png'),fullPage:true});await page.setViewportSize({width:1280,height:900});
  await page.goto('/calendar');const layers=page.getByRole('region',{name:'Connected calendar layers',exact:true});await expect(layers).toBeVisible();
  await expect(page.locator('.cal-connected').filter({hasText:'Connected reference'})).toBeVisible();await layers.getByLabel('Knowledge dates').uncheck();await expect(page.locator('.cal-connected').filter({hasText:'Connected reference'})).toHaveCount(0);await layers.getByLabel('Knowledge dates').check();await page.locator('.cal-connected').getByRole('link',{name:'Connected reference',exact:true}).click();await expect(page).toHaveURL(`/knowledge/records/${f.record.id}`);
});
test('requires authentication and isolates shared search, Today, Calendar and task context',async({page,browser})=>{
  const f=await fixture(page),context=await browser.newContext(),other=await context.newPage();
  for(const path of ['search','today',`tasks/${f.task.id}`,`calendar?start=${f.day}T00:00:00Z&end=${f.day}T23:59:59Z`])expect((await other.request.get(`/api/v1/connected/${path}`)).status()).toBe(401);
  await fixture(other);expect((await other.request.get(`/api/v1/connected/tasks/${f.task.id}`)).status()).toBe(404);
  const search=await (await other.request.get('/api/v1/connected/search')).json();expect(search.data.some((i:{id:string})=>i.id===f.goal.id)).toBe(false);
  await context.close();
});
test('replays a reference command once and rejects unbounded connected queries',async({page})=>{
  const f=await fixture(page),h=headers(),data={version:1,kind:'task',targetId:f.task.id,linked:true};
  const first=await page.request.post(`/api/v1/knowledge/records/${f.record.id}/relations`,{headers:h,data});
  const replay=await page.request.post(`/api/v1/knowledge/records/${f.record.id}/relations`,{headers:h,data});
  expect(first.status()).toBe(200);expect(replay.status()).toBe(200);expect(await replay.json()).toEqual(await first.json());
  const backlinks=await (await page.request.get(`/api/v1/knowledge/backlinks?kind=task&id=${f.task.id}`)).json();expect(backlinks.data).toHaveLength(1);
  expect((await page.request.get('/api/v1/connected/search?limit=101')).status()).toBe(400);
  expect((await page.request.get('/api/v1/connected/calendar?start=2026-01-01T00:00:00Z&end=2027-01-01T00:00:00Z')).status()).toBe(400);
});
