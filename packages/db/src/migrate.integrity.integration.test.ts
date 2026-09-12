import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { expect, it } from 'vitest';
import { runMigrations } from './migrate';
import { requireTestDatabase } from '../../../tests/database';
await requireTestDatabase();
async function fixture(run: (url: string, dir: string) => Promise<void>) {
  const admin = postgres(process.env.DATABASE_URL!, { max: 1 });
  const name = `migration_test_${randomUUID().replaceAll('-', '')}`;
  const dir = await mkdtemp(join(tmpdir(), 'nextdoo-migrations-'));
  const url = new URL(process.env.DATABASE_URL!); url.pathname = '/' + name;
  try {
    await admin.unsafe(`create database "${name}" with encoding 'UTF8' template template0`);
    await writeFile(join(dir, '0000_test.sql'), 'create table probe(id integer primary key); select pg_sleep(0.05);');
    await run(url.toString(), dir);
  } finally {
    await admin.unsafe(`drop database if exists "${name}" with (force)`);
    await admin.end(); await rm(dir, { recursive: true, force: true });
  }
}
it('concurrent migration runners coordinate before inspecting or modifying the ledger', async () => {
  await fixture(async (url, dir) => {
    const results = await Promise.allSettled([runMigrations(url, dir), runMigrations(url, dir)]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(results.flatMap((r) => r.status === 'fulfilled' ? r.value : [])).toEqual(['0000_test.sql']);
  });
});
it('changed applied SQL is rejected instead of silently reported up-to-date', async () => {
  await fixture(async (url, dir) => {
    await runMigrations(url, dir);
    await writeFile(join(dir, '0000_test.sql'), 'create table different_schema(id integer);');
    await expect(runMigrations(url, dir)).rejects.toThrow(/checksum/i);
  });
});
