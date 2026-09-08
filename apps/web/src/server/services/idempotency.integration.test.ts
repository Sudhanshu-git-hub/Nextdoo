import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { tasks, trackingEvents, outbox } from '@nextdoo/db';
import { createTaskSchema } from '@nextdoo/contracts';
import { requireTestDatabase } from '../../../../../tests/database';
import { getDb } from '../db';
import { registerUser } from './accounts';
import { createTask } from './tasks';

const state = vi.hoisted(() => ({ auth: null as any }));
vi.mock('../auth', async (original) => ({ ...await original<typeof import('../auth')>(), requireAuth: async () => state.auth }));
const { authedRoute, parseBody } = await import('../http');
await requireTestDatabase();
beforeAll(async () => {
  const u = await registerUser({ email: `idempotency-${randomUUID()}@test.local`, name: null, passwordHash: 'test-not-login', timeZone: 'UTC' });
  state.auth = { userId: u.id, workspaceId: u.workspaceId, sessionId: randomUUID() };
});
const request = (key: string | null, body: unknown, path = '/api/v1/tasks') => new Request(`http://localhost${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: JSON.stringify(body),
});
const handler = authedRoute({ routeName: 'tasks.create', idempotent: true }, async (r) => {
  await getDb().execute(sql`select pg_sleep(0.05)`); // Widen the concurrent replay-check window.
  return createTask(state.auth, await parseBody(r, createTaskSchema));
});
const input = () => ({ workspaceId: state.auth.workspaceId, title: `idempotent-${randomUUID()}` });

describe('atomic HTTP idempotency', () => {
  it('five concurrent creates commit one task, tracking event, outbox event and canonical response', async () => {
    const key = randomUUID(), body = input();
    const responses = await Promise.all(Array.from({ length: 5 }, () => handler(request(key, body))));
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    const values = await Promise.all(responses.map((r) => r.json()));
    expect(new Set(values.map((r) => r.id)).size).toBe(1);
    expect(await getDb().select().from(tasks).where(eq(tasks.title, body.title))).toHaveLength(1);
    expect(await getDb().select().from(trackingEvents).where(eq(trackingEvents.taskId, values[0].id))).toHaveLength(1);
    expect(await getDb().select().from(outbox).where(eq(outbox.entityId, values[0].id))).toHaveLength(1);
  });
  it('rejects changed request bodies and changed target resources for the same key', async () => {
    const key = randomUUID(), body = input();
    expect((await handler(request(key, body))).status).toBe(200);
    const changed = await handler(request(key, { ...body, title: 'changed' }));
    expect(changed.status).toBe(409); expect((await changed.json()).code).toBe('IDEMPOTENCY_CONFLICT');
    expect((await handler(request(key, body, '/api/v1/tasks/different-target'))).status).toBe(409);
  });
  it('rejects absent mandatory keys before mutation', async () => {
    const body = input();
    expect((await handler(request(null, body))).status).toBe(400);
    expect(await getDb().select().from(tasks).where(eq(tasks.title, body.title))).toHaveLength(0);
  });
  it('rolls back domain state if response recording cannot complete, then permits a retry', async () => {
    const body = input(), key = randomUUID(); let fail = true;
    const wrapped = authedRoute({ routeName: 'test.rollback', idempotent: true }, async (r) => {
      const result = await createTask(state.auth, await parseBody(r, createTaskSchema));
      if (fail) throw new Error('simulated failure before ledger commit');
      return result;
    });
    expect((await wrapped(request(key, body))).status).toBe(500);
    expect(await getDb().select().from(tasks).where(eq(tasks.title, body.title))).toHaveLength(0);
    fail = false;
    expect((await wrapped(request(key, body))).status).toBe(200);
    expect(await getDb().select().from(tasks).where(eq(tasks.title, body.title))).toHaveLength(1);
  });
  it('canonicalizes JSON key order without treating semantic retries as conflicting', async () => {
    const body = input(), key = randomUUID();
    const a = await handler(request(key, body));
    const b = await handler(request(key, { title: body.title, workspaceId: body.workspaceId }));
    expect(await b.json()).toEqual(await a.json()); expect(b.headers.get('Idempotent-Replay')).toBe('true');
  });
});
