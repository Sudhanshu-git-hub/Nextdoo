import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

/**
 * Minimal forward-only migration runner.
 * Session-locked, checksum-verified; each file and ledger write commit together.
 * Legacy checksums require the checked-in audited baseline, never blind adoption.
 */
export async function runMigrations(databaseUrl: string, migrationsDir?: string): Promise<string[]> {
  const dir = migrationsDir ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  const applied: string[] = [];
  let locked = false;
  try {
    // max:1 pins this session lock across the individual file transactions.
    await sql`SELECT pg_advisory_lock(hashtextextended('nextdoo:migrations', 0))`;
    locked = true;
    await sql`CREATE TABLE IF NOT EXISTS _migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`;
    await sql`ALTER TABLE _migrations ADD COLUMN IF NOT EXISTS checksum text`;
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    const done = new Map((await sql`SELECT name, checksum FROM _migrations`).map((r) => [r.name as string, r.checksum as string | null]));
    let legacy: Record<string, string> = {};
    try { legacy = JSON.parse(await readFile(join(dir, 'legacy-checksums.json'), 'utf8')) as Record<string, string>; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const sources = await Promise.all(files.map(async (file) => {
      const body = await readFile(join(dir, file), 'utf8');
      return { file, body, checksum: createHash('sha256').update(body).digest('hex') };
    }));
    // Validate ALL historical sources before applying any new migration.
    for (const [name, checksum] of done) {
      const source = sources.find((s) => s.file === name);
      if (!source) throw new Error(`Applied migration missing: ${name}`);
      if ((checksum ?? legacy[name]) !== source.checksum) throw new Error(`Migration checksum mismatch or missing trusted legacy baseline: ${name}`);
    }
    for (const { file, body, checksum } of sources) {
      if (done.has(file)) {
        if (done.get(file) === null) await sql`UPDATE _migrations SET checksum=${checksum} WHERE name=${file} AND checksum IS NULL`;
        continue;
      }
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`INSERT INTO _migrations (name, checksum) VALUES (${file}, ${checksum})`;
      });
      applied.push(file);
    }
    return applied;
  } finally {
    try { if (locked) await sql`SELECT pg_advisory_unlock(hashtextextended('nextdoo:migrations', 0))`; }
    finally { await sql.end({ timeout: 5 }); }
  }
}

if (process.argv[1] && process.argv[1].endsWith('migrate.ts')) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  runMigrations(url)
    .then((a) => console.log(a.length ? `Applied: ${a.join(', ')}` : 'Already up to date'))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
