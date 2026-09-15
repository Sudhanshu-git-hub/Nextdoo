import postgres from 'postgres';

/** Integration tests must never silently turn green without PostgreSQL. */
export async function requireTestDatabase(): Promise<true> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required for integration tests. Use pnpm test:unit for offline unit tests.');
  const connection = postgres(url, { max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    await connection`select name from _migrations limit 1`;
    return true;
  } finally {
    await connection.end({ timeout: 1 });
  }
}
