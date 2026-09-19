import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { newMigration } from './new-migration.mjs';

it('migration CLI fails nonzero for invalid input without creating files', () => {
  const result = spawnSync(process.execPath, ['scripts/new-migration.mjs', '../unsafe'], { encoding: 'utf8' });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Usage:');
});
it('scaffolds the next SQL migration without overwriting recovered history', async () => {
  const dir = await mkdtemp(`${tmpdir()}/nextdoo-migrations-`);
  try {
    await writeFile(`${dir}/0001_existing.sql`, '-- preserved');
    const path = await newMigration('safety', dir);
    expect(path).toBe(`${dir}/0002_safety.sql`);
    expect(await readFile(`${dir}/0001_existing.sql`, 'utf8')).toBe('-- preserved');
    await expect(newMigration('anything', `${dir}/missing`)).rejects.toThrow();
  } finally { await rm(dir, { recursive: true }); }
});
