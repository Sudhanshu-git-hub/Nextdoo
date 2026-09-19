#!/usr/bin/env node
/**
 * Starts an embedded PostgreSQL for local development.
 * Real deployments use a managed PostgreSQL; this exists so `pnpm dev` works
 * on a machine with no database installed.
 */
import EmbeddedPostgres from 'embedded-postgres';
import { existsSync, mkdirSync } from 'node:fs';

const PORT = Number(process.env.PGPORT ?? 55432);
const DIR = process.env.PGDATA_DIR ?? new URL('../.pgdata', import.meta.url).pathname;
mkdirSync(DIR, { recursive: true });

const pg = new EmbeddedPostgres({
  databaseDir: DIR, user: 'postgres', password: 'postgres', port: PORT, persistent: true, initdbFlags: ['--encoding=UTF8'],
});

const initialised = !existsSync(`${DIR}/PG_VERSION`);
if (initialised) await pg.initialise();
await pg.start();
const database = process.env.PGDATABASE ?? 'nextdoo';
try { await pg.createDatabase(database); } catch (error) {
  if (error.code !== '42P04') throw error; // Only duplicate_database is safe to ignore.
}

console.log(`PostgreSQL ready on port ${PORT}${initialised ? ' (initialised)' : ''}`);
console.log(`DATABASE_URL=postgres://postgres:postgres@localhost:${PORT}/${database}`);

const shutdown = async () => { await pg.stop(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
setInterval(() => {}, 1 << 30);
