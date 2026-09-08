#!/usr/bin/env node
import { readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// SQL is authoritative. Never generate a second initial schema over the
// recovered hand-authored migrations. Errors (including EEXIST) are fatal.
export async function newMigration(name, directory) {
  if (!/^[a-z][a-z0-9_]{0,70}$/.test(name ?? '')) {
    throw new Error('Usage: pnpm db:generate <lowercase_migration_name> (hand-authored SQL scaffold, not a schema diff)');
  }
  const files = await readdir(directory);
  const sequence = Math.max(-1, ...files.map((f) => /^(\d+)_.*\.sql$/.exec(f)).filter(Boolean).map((m) => Number(m[1]))) + 1;
  const path = `${directory}/${String(sequence).padStart(4, '0')}_${name}.sql`;
  await writeFile(path, `-- ${name}\n-- Add reviewed, backward-compatible SQL below. Never edit an applied migration.\n`, { flag: 'wx' });
  return path;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  newMigration(process.argv[2], fileURLToPath(new URL('../packages/db/migrations', import.meta.url)))
    .then((path) => console.log(`Created ${path}`))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
