import { setImmediate } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import { schedule, shutdown, sql } from './runtime';

it('shutdown drains in-flight jobs before closing their database pool', async () => {
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const began = new Promise<void>((r) => { started = r; });
  let completed = false, prematureClose = false;
  const end = sql.end.bind(sql);
  const spy = vi.spyOn(sql, 'end').mockImplementation(async (options) => { prematureClose = !completed; await end(options); });
  schedule([{ name: 'test.drain', intervalMs: 10000, run: async () => { started(); await gate; completed = true; return { processed: 0 }; } }]);
  await began;
  const stop = shutdown('test');
  try { await setImmediate(); expect(prematureClose).toBe(false); }
  finally { release(); await stop; spy.mockRestore(); }
  expect(completed).toBe(true);
});
