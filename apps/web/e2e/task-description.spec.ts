import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
const origin = { Origin: 'http://localhost:3100' };
let ipCounter = 60;
const nextIp = () => `198.51.100.${ipCounter++}`;

async function account(page: Page) {
  const response = await page.request.post('/api/v1/auth/register', {
    headers: { ...origin, 'X-Forwarded-For': nextIp() },
    data: { email: `description-${randomUUID()}@test.local`, password: 'description-test-password-123', timeZone: 'UTC' },
  });
  expect(response.status()).toBe(200);
  return await response.json() as { workspaceId: string };
}
async function createTask(page: Page, workspaceId: string, title: string, extra: Record<string, unknown> = {}) {
  const response = await page.request.post('/api/v1/tasks', { headers: { ...origin, 'Idempotency-Key': randomUUID() }, data: { workspaceId, title, ...extra } });
  expect(response.status()).toBe(200);
  return await response.json() as { id: string; version: number; description: string | null };
}

const RICH = [
  '# Plan',
  'Intro with **bold** and a [site](https://example.com/notes).',
  '',
  '- [ ] first step',
  '- [x] second step',
  '  - nested detail',
  '',
  '> a quote',
  '',
  '```',
  'code **not parsed** <tag>',
  '```',
].join('\n');

test('rich description edits, previews and persists through the editor', async ({ page }) => {
  const { workspaceId } = await account(page);
  const task = await createTask(page, workspaceId, 'Doc task');
  expect(task.description).toBeNull();

  await page.goto('/inbox');
  await page.getByRole('button', { name: 'Edit "Doc task"', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit task', exact: true });
  const notes = editor.getByLabel('Description', { exact: true });
  const previewButton = editor.getByRole('button', { name: 'Preview description', exact: true });

  // Empty preview state before any text.
  await previewButton.click();
  const preview = page.locator('#description-preview');
  await expect(preview).toBeVisible();
  await expect(preview).toContainText('No description yet.');
  await editor.getByRole('button', { name: 'Edit description', exact: true }).click();
  await expect(notes).toBeVisible();

  await notes.fill(RICH);
  await expect(editor.locator('#edit-description-count')).toHaveText(`${RICH.length} / 20,000 characters`);
  await previewButton.click();
  await expect(preview).toBeVisible();
  await expect(preview.getByRole('heading', { name: 'Plan' })).toBeVisible();
  await expect(preview).toContainText('Intro with bold and a site.');
  await expect(preview.locator('li')).toHaveCount(3);
  await expect(preview.locator('li input[type="checkbox"]')).toHaveCount(2);
  await expect(preview.locator('li input[type="checkbox"]').first()).not.toBeChecked();
  await expect(preview.locator('li input[type="checkbox"]').last()).toBeChecked();
  const link = preview.getByRole('link', { name: 'site' });
  await expect(link).toHaveAttribute('href', 'https://example.com/notes');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(preview.locator('pre code')).toContainText('code **not parsed** <tag>');
  await expect(preview.locator('blockquote')).toContainText('a quote');

  // Save; the storage remains the raw Markdown source.
  await editor.getByRole('button', { name: 'Edit description', exact: true }).click();
  await editor.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(editor).not.toBeVisible();
  const saved = await (await page.request.get(`/api/v1/tasks/${task.id}`)).json();
  expect(saved.description).toBe(RICH);

  // Reopen: the raw source is back in the editor and renders identically.
  await page.getByRole('button', { name: 'Edit "Doc task"', exact: true }).click();
  const reopened = page.getByRole('dialog', { name: 'Edit task', exact: true });
  await expect(reopened.getByLabel('Description', { exact: true })).toHaveValue(RICH);
  await reopened.getByRole('button', { name: 'Preview description', exact: true }).click();
  await expect(page.locator('#description-preview').getByRole('heading', { name: 'Plan' })).toBeVisible();
});

test('preview sanitization: hostile markup renders literally and never executes', async ({ page }) => {
  const { workspaceId } = await account(page);
  const hostile = [
    '<script>window.__pwned = 1</script>',
    '<img src=x onerror="window.__pwned = 2">',
    '<svg onload="window.__pwned = 3">',
    '<a href="javascript:window.__pwned = 4">click me</a>',
    '[tricky](javascript:window.__pwned = 5)',
    '<div style="color: red" onmouseover="window.__pwned = 6">styled</div>',
    '[safe](https://example.com/ok)',
  ].join('\n');
  const task = await createTask(page, workspaceId, 'Safe doc', { description: 'placeholder' });

  await page.goto('/inbox');
  await page.getByRole('button', { name: 'Edit "Safe doc"', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit task', exact: true });
  await editor.getByLabel('Description', { exact: true }).fill(hostile);
  await editor.getByRole('button', { name: 'Preview description', exact: true }).click();
  const preview = page.locator('#description-preview');
  await expect(preview).toBeVisible();

  // Nothing in the preview may execute or embed an executable element.
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  await expect(preview.locator('script')).toHaveCount(0);
  await expect(preview.locator('img')).toHaveCount(0);
  await expect(preview.locator('svg')).toHaveCount(0);
  await expect(preview.locator('a[href^="javascript:"]')).toHaveCount(0);
  // The hostile source is shown as literal text.
  await expect(preview).toContainText('<script>window.__pwned = 1</script>');
  await expect(preview).toContainText('[tricky](javascript:window.__pwned = 5)');
  // The one allowed link is real and safe.
  await expect(preview.getByRole('link', { name: 'safe' })).toHaveAttribute('href', 'https://example.com/ok');
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();

  // Storage keeps the raw source; the server does not rewrite it.
  await editor.getByRole('button', { name: 'Edit description', exact: true }).click();
  await editor.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(editor).not.toBeVisible();
  expect((await (await page.request.get(`/api/v1/tasks/${task.id}`)).json()).description).toBe(hostile);
});

test('the 20,000 character limit is surfaced, enforced and validated', async ({ page }) => {
  const { workspaceId } = await account(page);
  const task = await createTask(page, workspaceId, 'Long doc');
  await page.goto('/inbox');
  await page.getByRole('button', { name: 'Edit "Long doc"', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit task', exact: true });
  const notes = editor.getByLabel('Description', { exact: true });
  await expect(notes).toHaveAttribute('maxlength', '20000');

  const atLimit = 'a'.repeat(20000);
  await notes.fill(atLimit);
  await expect(editor.locator('#edit-description-count')).toHaveText('20,000 / 20,000 characters');
  await expect(editor.locator('#edit-description-count')).toHaveClass(/desc-count-limit/);

  // The API contract rejects over-limit descriptions without persisting.
  const tooLong = await page.request.patch(`/api/v1/tasks/${task.id}`, {
    headers: { ...origin, 'Idempotency-Key': randomUUID() },
    data: { version: task.version, description: 'a'.repeat(20001) },
  });
  expect(tooLong.status()).toBe(400);
  expect((await tooLong.json()).code).toBe('VALIDATION_FAILED');
  expect((await (await page.request.get(`/api/v1/tasks/${task.id}`)).json()).description).toBeNull();

  // The at-limit value itself saves fine.
  await editor.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(editor).not.toBeVisible();
  expect((await (await page.request.get(`/api/v1/tasks/${task.id}`)).json()).description).toBe(atLimit);
});

test('conflict handling keeps the user draft and renders the server notes', async ({ page }) => {
  const { workspaceId } = await account(page);
  const task = await createTask(page, workspaceId, 'Contended', { description: 'old **notes**' });
  const myDraft = ['# Mine', '- [ ] keep', '- [x] already'].join('\n');

  await page.goto('/inbox');
  await page.getByRole('button', { name: 'Edit "Contended"', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit task', exact: true });
  await editor.getByLabel('Description', { exact: true }).fill(myDraft);

  // A concurrent write bumps the version and changes other fields.
  await page.request.patch(`/api/v1/tasks/${task.id}`, {
    headers: { ...origin, 'Idempotency-Key': randomUUID() },
    data: { version: task.version, title: 'Remote title', priority: 'HIGH', description: 'Server side `notes`' },
  });
  await editor.getByRole('button', { name: 'Save changes', exact: true }).click();

  // The banner shows the server version (notes rendered) while the draft survives.
  await expect(editor.locator('#task-editor-error')).toBeVisible();
  await expect(editor).toContainText('The task changed elsewhere. Your draft below has not been replaced.');
  await expect(editor).toContainText('Remote title');
  const serverNotes = editor.getByRole('region', { name: 'Server description' });
  await expect(serverNotes).toBeVisible();
  await expect(serverNotes.locator('code')).toHaveText('notes');
  await expect(editor.getByLabel('Description', { exact: true })).toHaveValue(myDraft);

  // Keep my changes against the new version: only the changed field is patched.
  await editor.getByRole('button', { name: 'Keep my changes against this version', exact: true }).click();
  await editor.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(editor).not.toBeVisible();
  const final = await (await page.request.get(`/api/v1/tasks/${task.id}`)).json();
  expect(final.title).toBe('Remote title');
  expect(final.priority).toBe('HIGH');
  expect(final.description).toBe(myDraft);
});

test('description editing and preview are keyboard accessible and axe clean', async ({ page }) => {
  const { workspaceId } = await account(page);
  await createTask(page, workspaceId, 'A11y doc', { description: '# Heading\n- [ ] item' });
  await page.goto('/inbox');
  await page.getByRole('button', { name: 'Edit "A11y doc"', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit task', exact: true });

  const notes = editor.getByLabel('Description', { exact: true });
  await expect(notes).toBeVisible();
  const previewButton = editor.getByRole('button', { name: 'Preview description', exact: true });

  // Keyboard-only toggle round trip (the button label flips with the mode).
  await previewButton.focus();
  await page.keyboard.press('Space');
  const editButton = editor.getByRole('button', { name: 'Edit description', exact: true });
  await expect(editButton).toHaveAttribute('aria-pressed', 'true');
  const preview = page.locator('#description-preview');
  await expect(preview).toBeVisible();
  await expect(preview).toHaveAccessibleName('Description preview');
  await expect(preview).toContainText('item');
  await editButton.focus();
  await page.keyboard.press('Space');
  await expect(previewButton).toHaveAttribute('aria-pressed', 'false');
  await expect(notes).toBeVisible();

  const { default: AxeBuilder } = await import('@axe-core/playwright');
  const tags = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];
  expect((await new AxeBuilder({ page }).include('dialog').withTags(tags).analyze()).violations).toEqual([]);
});

test('description flows through search and sync without changing task flows', async ({ page }) => {
  const { workspaceId } = await account(page);
  const searchable = await createTask(page, workspaceId, 'Plain title', { description: 'zebra migration schedule' });
  const id = randomUUID();

  // Whole-word search still matches description text (search index untouched).
  await page.goto('/tasks');
  await page.locator('#filter-search-words').fill('zebra');
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit "Plain title"', exact: true })).toBeVisible();

  // Sync push/pull carry description through the writable-field boundary.
  const created = await page.request.post('/api/v1/sync/push', {
    headers: { ...origin, 'Idempotency-Key': randomUUID() },
    data: {
      deviceId: 'description-e2e',
      mutations: [{ mutationId: randomUUID(), entityType: 'task', entityId: id, operation: 'create', payload: { title: 'Offline notes', description: 'synced **draft**' }, baseVersion: null, createdAt: new Date().toISOString() }],
    },
  });
  expect(created.status()).toBe(200);
  expect((await created.json()).results[0].status).toBe('applied');
  const read = await (await page.request.get(`/api/v1/tasks/${id}`)).json();
  expect(read.description).toBe('synced **draft**');
  const updated = await page.request.post('/api/v1/sync/push', {
    headers: { ...origin, 'Idempotency-Key': randomUUID() },
    data: {
      deviceId: 'description-e2e',
      mutations: [{ mutationId: randomUUID(), entityType: 'task', entityId: id, operation: 'update', payload: { description: 'synced `edited`' }, baseVersion: read.version, createdAt: new Date().toISOString() }],
    },
  });
  expect((await updated.json()).results[0].status).toBe('applied');
  const pull = await (await page.request.get(`/api/v1/sync/pull?workspaceId=${workspaceId}&cursor=0`)).json();
  const changes = pull.changes.filter((c: { entityType: string; entityId: string }) => c.entityType === 'task' && c.entityId === id);
  expect(changes.map((c: { operation: string }) => c.operation)).toEqual(['create', 'update']);
  expect(changes.map((c: { payload: { description: string | null } }) => c.payload.description)).toEqual(['synced **draft**', 'synced `edited`']);

  // Normal task flows are unaffected: complete from the list works.
  await page.goto('/inbox');
  await page.locator('li', { has: page.getByRole('button', { name: 'Complete "Plain title"' }) }).getByRole('button', { name: 'Complete "Plain title"' }).click();
  await expect(page.getByText('Completed: Plain title')).toBeVisible();
  expect((await (await page.request.get(`/api/v1/tasks/${searchable.id}`)).json()).status).toBe('COMPLETED');
  expect((await (await page.request.get(`/api/v1/tasks/${searchable.id}`)).json()).description).toBe('zebra migration schedule');
});
