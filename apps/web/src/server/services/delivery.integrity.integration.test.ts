import { randomUUID } from 'node:crypto';
import { afterAll, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { notifications, outbox, reminders } from '@nextdoo/db';
import { requireTestDatabase } from '../../../../../tests/database';
import { getDb } from '../db';
import { registerUser } from './accounts';
import { createTask } from './tasks';
import { JOBS } from '../../../../worker/src/jobs';
import { sql as workerSql } from '../../../../worker/src/runtime';
await requireTestDatabase();
afterAll(async () => { await workerSql.end(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
async function fixture() {
  const u = await registerUser({ email: `delivery-${randomUUID()}@test.local`, name: null, passwordHash: 'test', timeZone: 'UTC' });
  const task = await createTask({ userId: u.id, workspaceId: u.workspaceId }, { workspaceId: u.workspaceId, title: 'Private reminder title', priority: 'NONE', tagIds: [] });
  return { u, task };
}
it('worker WEB acknowledgement has exactly one durable notification even with concurrent passes', async () => {
  const { u, task } = await fixture(), id = randomUUID();
  await getDb().insert(reminders).values({ id, workspaceId: u.workspaceId, taskId: task.id, userId: u.id, channel: 'WEB', scheduledAt: new Date(Date.now() - 1000) });
  await Promise.all([JOBS.find((j) => j.name === 'reminders.dispatch')!.run(), JOBS.find((j) => j.name === 'reminders.dispatch')!.run()]);
  expect(await getDb().select().from(notifications).where(eq(notifications.taskId, task.id))).toHaveLength(1);
  expect((await getDb().select().from(reminders).where(eq(reminders.id, id)))[0]?.status).toBe('SENT');
});
it('unconfigured external reminder channels fail honestly and inactive tasks never dispatch', async () => {
  const { u, task } = await fixture(), email = randomUUID(), inactive = randomUUID();
  await getDb().insert(reminders).values({ id: email, workspaceId: u.workspaceId, taskId: task.id, userId: u.id, channel: 'EMAIL', scheduledAt: new Date(Date.now() - 1000) });
  await JOBS.find((j) => j.name === 'reminders.dispatch')!.run();
  expect((await getDb().select().from(reminders).where(eq(reminders.id, email)))[0]?.status).toBe('FAILED');
  const { tasks } = await import('@nextdoo/db');
  await getDb().update(tasks).set({ status: 'COMPLETED' }).where(eq(tasks.id, task.id));
  await getDb().insert(reminders).values({ id: inactive, workspaceId: u.workspaceId, taskId: task.id, userId: u.id, channel: 'WEB', scheduledAt: new Date(Date.now() - 1000) });
  await JOBS.find((j) => j.name === 'reminders.dispatch')!.run();
  expect((await getDb().select().from(reminders).where(eq(reminders.id, inactive)))[0]?.status).toBe('CANCELED');
});
it('outbox without consumers remains unpublished instead of fabricating successful delivery', async () => {
  const { task } = await fixture();
  await getDb().update(outbox).set({ occurredAt: new Date(0) }).where(eq(outbox.entityId, task.id));
  await JOBS.find((j) => j.name === 'outbox.relay')!.run();
  const rows = await getDb().select().from(outbox).where(eq(outbox.entityId, task.id));
  expect(rows.length).toBeGreaterThan(0); expect(rows.every((r) => r.publishedAt === null)).toBe(true);
});
it('mail delivery has a durable worker rather than only a success logger', async () => {
  expect(JOBS.some((j) => j.name === 'mail.deliver')).toBe(true);
});
it('configured SMTP never logs mail.sent without transport acknowledgement', async () => {
  vi.stubEnv('SMTP_URL', 'smtp://127.0.0.1:1');
  vi.resetModules();
  const { sendMail } = await import('../mailer');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  await sendMail('password-changed', 'delivery@test.local').catch(() => {});
  expect(JSON.stringify(log.mock.calls)).not.toContain('mail.sent');
  vi.unstubAllEnvs(); vi.restoreAllMocks();
});
