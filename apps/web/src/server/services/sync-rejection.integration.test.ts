import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { requireTestDatabase } from '../../../../../tests/database';
import { registerUser } from './accounts';
import { pushMutations } from './sync';
await requireTestDatabase();
it('replaying a rejected mutation never converts it into an applied acknowledgement', async () => {
  const u = await registerUser({ email: `rejected-${randomUUID()}@test.local`, passwordHash: 'test', name: null, timeZone: 'UTC' });
  const actor = { userId: u.id, workspaceId: u.workspaceId };
  const input = { deviceId: 'test', mutations: [{ mutationId: randomUUID(), entityId: randomUUID(), entityType: 'task' as const, operation: 'update' as const, baseVersion: 1, payload: { title: 'Keep this content' }, createdAt: new Date().toISOString() }] };
  expect((await pushMutations(actor, input)).results[0]?.status).toBe('rejected');
  expect((await pushMutations(actor, input)).results[0]?.status).toBe('rejected');
});
it('a stale client workspace cannot be relabeled as the current account during push', async () => {
  const u = await registerUser({ email: `scope-${randomUUID()}@test.local`, passwordHash: 'test', name: null, timeZone: 'UTC' });
  await expect(pushMutations({ userId: u.id, workspaceId: u.workspaceId }, { workspaceId: randomUUID(), deviceId: 'test', mutations: [] })).rejects.toMatchObject({ code: 'FORBIDDEN' });
});
