import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import postgres from 'postgres';
import { expect, it } from 'vitest';
import { requireTestDatabase } from '../../../../../tests/database';
import { registerUser } from './accounts';
import { currentCursor, pullChanges } from './sync';

await requireTestDatabase();
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

it('a cursor never passes a lower sequence that commits later (real concurrent transactions)', async () => {
  const user = await registerUser({ email: `cursor-${randomUUID()}@test.local`, passwordHash: 'test-not-login', name: null, timeZone: 'UTC' });
  const marker = `cursor-${randomUUID()}`;
  const a = postgres(process.env.DATABASE_URL!, { max: 1 });
  const b = postgres(process.env.DATABASE_URL!, { max: 1, connection: { application_name: marker } });
  const observer = postgres(process.env.DATABASE_URL!, { max: 1 });
  const allocated = latch(), release = latch();
  const firstId = randomUUID(), secondId = randomUUID();
  const cursor = await currentCursor(user.workspaceId);
  const first = a.begin(async (tx) => {
    await tx`insert into sync_changes(workspace_id,entity_type,entity_id,operation,payload,version)
      values(${user.workspaceId},'task',${firstId},'create','{}',1)`;
    allocated.resolve();
    await release.promise;
  });
  let second: Promise<unknown> | undefined;
  try {
    await allocated.promise;
    second = b`insert into sync_changes(workspace_id,entity_type,entity_id,operation,payload,version)
      values(${user.workspaceId},'task',${secondId},'create','{}',1)`.then((x) => x);
    // Wait for B to either commit (the defect) or block on A (the repair).
    // This observes PostgreSQL's wait state, not a timing-only assertion.
    let completed = false;
    void second.then(() => { completed = true; });
    for (let i = 0; i < 500; i++) {
      const [state] = await observer`select wait_event from pg_stat_activity where application_name=${marker}`;
      if (completed || state?.wait_event === 'advisory') break;
      if (i === 499) throw new Error('Second transaction neither committed nor blocked');
      await setTimeout(10);
    }
    const during = await pullChanges(user.workspaceId, cursor, 100);
    release.resolve();
    await Promise.all([first, second]);
    const after = await pullChanges(user.workspaceId, during.cursor, 100);
    expect([...during.changes, ...after.changes].map((c) => c.entityId).sort()).toEqual([firstId, secondId].sort());
  } finally {
    release.resolve();
    await Promise.allSettled([first, second]);
    await Promise.all([a.end(), b.end(), observer.end()]);
  }
});
