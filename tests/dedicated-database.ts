// Relative (not @nextdoo/db): this helper is imported into per-app test
// programs where the workspace package is not resolvable from the repo root.
import { runMigrations } from '../packages/db/src/migrate';
import postgres from 'postgres';

/**
 * M6-i6: the retention purge sweeps are global by design (the real job takes
 * no workspace argument), so its regression suite must not share its database
 * with the rest of the parallel integration suite — deleting one file's
 * back-dated fixtures would corrupt the other files' assertions.
 *
 * Creates a fresh, disposable database (dropped first, so a rerun is clean)
 * and applies the same migration chain the service uses.
 */
export interface DedicatedDatabase {
  url: string;
  close: () => Promise<void>;
}

export async function dedicatedDatabase(name: string): Promise<DedicatedDatabase> {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error('DATABASE_URL is required for integration tests. Use pnpm test:unit for offline unit tests.');

  // postgres: is a non-special URL scheme (no .origin), so swap the path
  // instead of rebuilding from the origin.
  const adminUrl = new URL(base);
  adminUrl.pathname = '/postgres';
  const admin = postgres(adminUrl.toString(), {
    max: 1,
    connect_timeout: 5,
    onnotice: () => {},
  });
  try {
    // FORCE disconnects any stragglers from a crashed previous run.
    await admin.unsafe(`drop database if exists "${name}" with (force)`);
    await admin.unsafe(`create database "${name}"`);
  } finally {
    await admin.end({ timeout: 2 });
  }

  const url = new URL(base);
  url.pathname = `/${name}`;
  const finalUrl = url.toString();
  await runMigrations(finalUrl);

  return { url: finalUrl, close: async () => {} };
}
