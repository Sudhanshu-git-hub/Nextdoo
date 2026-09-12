import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { users } from '@nextdoo/db';
import { requireTestDatabase } from '../../../../../tests/database';
import { getDb } from '../db';
import { registerUser } from './accounts';
import { hashPassword } from '../auth';
import { requestPasswordReset } from './auth-tokens';
import { requestAccountDeletion } from './data-rights';
await requireTestDatabase();
afterEach(() => { vi.unstubAllEnvs(); });
const fixture = async () => registerUser({ email: `notice-${randomUUID()}@test.local`, passwordHash: await hashPassword('test-password-123'), name: null, timeZone: 'UTC' });
it('missing production email configuration does not turn reset into an account-enumeration oracle', async () => {
  const u = await fixture(); vi.stubEnv('NODE_ENV', 'production');
  const outcome = async (email: string) => requestPasswordReset(email).then(() => 'ok').catch((e: { code: string }) => e.code);
  expect(await outcome(u.email)).toBe(await outcome(`unknown-${randomUUID()}@test.local`));
});
it('email notification failure cannot deny a reauthenticated account-deletion request', async () => {
  const u = await fixture(); vi.stubEnv('NODE_ENV', 'production');
  expect(await requestAccountDeletion(u.id, 'test-password-123')).toMatchObject({ scheduled: true });
  expect((await getDb().select().from(users).where(eq(users.id, u.id)))[0]?.deletionRequestedAt).not.toBeNull();
});
