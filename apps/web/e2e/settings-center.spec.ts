import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const origin = { Origin: 'http://localhost:3100' };
let sequence = 100;
async function setup(page: Page) {
  const response = await page.request.post('/api/v1/auth/register', { headers: { ...origin, 'X-Forwarded-For': `192.0.2.${sequence++}` }, data: { email: `pc7-${randomUUID()}@test.local`, password: 'settings-test-password-123', timeZone: 'UTC' } });
  expect(response.status()).toBe(200);
  await page.goto('/settings');
  return response.json();
}
async function section(page: Page, name: string) {
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name, exact: true }).click();
}
async function choose(page: Page, label: string, value: string) {
  const response = page.waitForResponse(r => r.url().endsWith('/preferences/personalization') && r.request().method() === 'PATCH');
  await page.getByLabel(label, { exact: true }).selectOption(value);
  expect((await response).status()).toBe(200);
  await expect(page.getByLabel(label, { exact: true })).toBeEnabled();
}
test('appearance and accessibility persist across reload and module navigation', async ({ page }) => {
  await setup(page); await section(page, 'Appearance');
  for (const [label, value] of [['Theme','light'],['Accent color','green'],['Density','compact'],['Text size','large'],['Desktop sidebar','compact']] as const) await choose(page,label,value);
  await page.getByLabel('Increase contrast').click();
  await expect(page.getByLabel('Increase contrast')).toBeChecked();
  await page.getByLabel('Reduce motion').click();
  await expect(page.getByLabel('Reduce motion')).toBeChecked();
  await page.reload();
  await expect(page.getByLabel('Theme', { exact:true })).toHaveValue('light');
  await expect(page.getByLabel('Reduce motion')).toBeChecked();
  await page.goto('/today');
  await expect(page.locator('.personalized')).toHaveAttribute('data-theme','light');
  await expect(page.locator('.personalized')).toHaveAttribute('data-sidebar','compact');
});
test('saved start page controls the authenticated home redirect', async ({ page }) => {
  await setup(page); await section(page,'Productivity'); await choose(page,'Start page','/goals');
  await page.goto('/'); await expect(page).toHaveURL(/\/goals$/);
});
test('Calendar and Insights consume saved defaults and explicit report links win', async ({ page }) => {
  await setup(page); await section(page,'Productivity');
  await choose(page,'Default Calendar view','month'); await choose(page,'Default Insights period','week');
  await page.goto('/calendar'); await expect(page.getByRole('button',{name:'Month',exact:true})).toHaveAttribute('aria-pressed','true');
  await page.goto('/insights'); await expect(page.getByLabel('Period',{exact:true})).toHaveValue('week');
  await page.goto('/insights?period=year'); await expect(page.getByLabel('Period',{exact:true})).toHaveValue('year');
});
test('default task list is persisted and can be cleared to Inbox', async ({ page }) => {
  const account=await setup(page);
  const project=await page.request.post('/api/v1/projects',{headers:{...origin,'Idempotency-Key':randomUUID()},data:{workspaceId:account.workspaceId,name:'Capture list'}});
  expect(project.status()).toBe(200); const {id}=await project.json();
  await page.reload(); await section(page,'Productivity');
  await choose(page,'Default task list',id); await page.reload();
  await expect(page.getByLabel('Default task list',{exact:true})).toHaveValue(id);
  await choose(page,'Default project task view','board');
  await page.goto('/projects'); await page.getByRole('button',{name:'Open Capture list',exact:true}).click();
  await expect(page.getByRole('button',{name:'Board',exact:true})).toHaveAttribute('aria-pressed','true');
  await page.goto('/inbox');
  const created=page.waitForResponse(r=>r.url().endsWith('/api/v1/tasks')&&r.request().method()==='POST');
  await page.getByRole('textbox',{name:/Add a task/}).fill('Captured with saved list');
  await page.getByRole('textbox',{name:/Add a task/}).press('Enter');
  expect(await (await created).json()).toMatchObject({projectId:id});
  await page.goto('/settings?section=productivity');
  await choose(page,'Default task list',''); await page.reload();
  await expect(page.getByLabel('Default task list',{exact:true})).toHaveValue('');
});
test('reminder defaults persist without creating a reminder', async ({ page }) => {
  const account=await setup(page); await section(page,'Notifications');
  await page.getByLabel('Default minutes before due').fill('30');
  const saved=page.waitForResponse(r=>r.url().endsWith('/preferences/personalization')&&r.request().method()==='PATCH');
  await page.getByRole('button',{name:'Save reminder default'}).click(); expect((await saved).status()).toBe(200);
  const task=await (await page.request.post('/api/v1/tasks',{headers:{...origin,'Idempotency-Key':randomUUID()},data:{workspaceId:account.workspaceId,title:'Reminder default',priority:'NONE',tagIds:[],dueAt:new Date(Date.now()+86400000).toISOString()}})).json();
  await page.goto('/notifications?taskId='+task.id); await expect(page.getByLabel('Minutes before due',{exact:true})).toHaveValue('30');
});
test('wellbeing control retains its existing API semantics', async ({ page }) => {
  await setup(page); await section(page,'Wellbeing');
  const control=page.getByLabel('Hide tracker streaks'); await control.check(); await expect(control).toBeEnabled();
  expect(await (await page.request.get('/api/v1/preferences')).json()).toMatchObject({disableStreaks:true});
  await page.reload(); await expect(control).toBeChecked();
});
test('sync, integration, billing and security sections show existing capabilities', async ({ page }) => {
  await setup(page); await section(page,'Sync & Data');
  await expect(page.getByRole('region',{name:'Sync and storage'})).toContainText('0 queued changes');
  await expect(page.getByRole('link',{name:'Review sync conflicts'})).toBeVisible();
  await section(page,'Plan & Billing'); await expect(page.getByRole('region',{name:'Plan and billing'})).toContainText('FREE');
  await section(page,'Integrations'); await expect(page.getByRole('heading',{name:/Calendar/}).first()).toBeVisible();
  await section(page,'Security & Privacy'); await expect(page.getByRole('heading',{name:/Sessions|devices/i}).first()).toBeVisible();
});
test('failed saves preserve the applied and persisted appearance', async ({ page }) => {
  await setup(page); await section(page,'Appearance');
  await page.route('**/api/v1/preferences/personalization',route=>route.request().method()==='PATCH'?route.fulfill({status:503,contentType:'application/problem+json',body:JSON.stringify({title:'Unavailable',detail:'Please retry',status:503})}):route.continue());
  await page.getByLabel('Theme',{exact:true}).selectOption('dark');
  await expect(page.getByRole('region',{name:'Appearance preferences'}).getByRole('alert')).toContainText('Please retry');
  await expect(page.getByLabel('Theme',{exact:true})).toHaveValue('system');
  await page.reload(); await expect(page.getByLabel('Theme',{exact:true})).toHaveValue('system');
});
test('mobile Settings fits the viewport and supports accessible light and dark appearances', async ({ page }) => {
  await page.setViewportSize({width:390,height:844}); await setup(page); await section(page,'Appearance');
  for(const theme of ['light','dark']) {
    await choose(page,'Theme',theme);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
    const results=await new AxeBuilder({page}).analyze(); expect(results.violations).toEqual([]);
  }
});
test('server-rendered Settings does not accept input before browser handlers are ready', async ({ browser }) => {
  const context=await browser.newContext({baseURL:'http://localhost:3100',javaScriptEnabled:false});
  try {
    const page=await context.newPage(); await setup(page);
    await expect(page.getByLabel('Display name',{exact:true})).toBeDisabled();
    await expect(page.getByRole('navigation',{name:'Settings sections',includeHidden:true}).getByRole('button',{name:'Appearance',exact:true,includeHidden:true})).toBeDisabled();
  } finally {await context.close();}
});
