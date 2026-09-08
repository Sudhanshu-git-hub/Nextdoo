import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';

test('unauthenticated users cannot enter the app or query tasks', async ({ page, request }) => {
  await page.goto('/today');
  await expect(page).toHaveURL(/\/login$/);
  const response = await request.get(`/api/v1/tasks?workspaceId=${randomUUID()}`);
  expect(response.status()).toBe(401);
  expect((await response.json()).code).toBe('UNAUTHENTICATED');
});

test('register, capture using keyboard, complete, and review real persisted work', async ({ page }) => {
  await page.goto('/register');
  await page.getByLabel('Email', { exact: true }).fill(`e2e-${randomUUID()}@test.local`);
  await page.getByLabel('Password', { exact: true }).fill('e2e-only-password-123');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page).toHaveURL(/\/today$/);
  const title = `Review ${randomUUID()}`;
  await page.keyboard.press('n');
  await expect(page.locator('#capture')).toBeFocused();
  await page.locator('#capture').fill(`${title} today at 11:59pm for 30 minutes`);
  await page.locator('#capture').press('Enter');
  await expect(page.getByText(title, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: `Complete "${title}"`, exact: true }).click();
  await expect(page.getByText(title, { exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: /Analytics/ }).click();
  await expect(page.getByText('1 of 1 planned', { exact: true })).toBeVisible();
  await expect(page.getByText('Execution score', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: /Settings/ }).click();
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
});
