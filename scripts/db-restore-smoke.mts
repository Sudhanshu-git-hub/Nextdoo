import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { runMigrations } from '../packages/db/src/migrate.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const MIGRATIONS_DIR = join(REPO_ROOT, 'packages/db/migrations');
const HEALTH_PORT = Number(process.env.RESTORE_SMOKE_PORT ?? 3100);
const SESSION_COOKIE = 'nextdoo_session';
const SMOKE_SESSION_TOKEN = 'm8i7-restore-smoke-session-token';
const AUTH_SECRET = process.env.AUTH_SECRET ?? 'restore-smoke-ci-secret-at-least-32-chars';
const STAGE_PREFIX = '[restore-smoke]';

interface PgTarget {
  host: string;
  port: string;
  user: string;
  password: string;
}

function log(stage: string, message: string): void {
  console.log(`${STAGE_PREFIX} ${stage}: ${message}`);
}

function fail(stage: string, message: string): never {
  throw new Error(`${stage}: ${message}`);
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === 'object') {
    const code = 'code' in error ? String((error as { code?: unknown }).code ?? '') : '';
    const detail = 'detail' in error ? String((error as { detail?: unknown }).detail ?? '') : '';
    const reason = [code, detail].filter(Boolean).join(' ');
    if (reason) return reason;
  }
  return String(error || 'unknown error');
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) fail('config', `${name} is required`);
  return value;
}

function quoteIdent(name: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) fail('config', `unsafe generated database identifier: ${name}`);
  return `"${name}"`;
}

function dbName(prefix: string): string {
  return `nextdoo_${prefix}_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
}

function urlFor(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

function pgTarget(base: string): PgTarget {
  const url = new URL(base);
  return {
    host: url.hostname || 'localhost',
    port: url.port || '5432',
    user: decodeURIComponent(url.username || 'postgres'),
    password: decodeURIComponent(url.password || ''),
  };
}

function runCommand(stage: string, command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; redactArgs?: boolean } = {}): string {
  log(stage, `running ${command}${options.redactArgs ? ' [arguments redacted]' : ` ${args.join(' ')}`}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.stdout.trim()) console.log(result.stdout.trimEnd());
  if (result.stderr.trim()) console.error(result.stderr.trimEnd());
  if (result.error) fail(stage, result.error.message);
  if (result.status !== 0) fail(stage, `${command} exited with ${result.status}`);
  return result.stdout;
}

function pnpmArgs(args: string[]): { command: string; args: string[] } {
  const execPath = process.env.npm_execpath;
  if (execPath && /pnpm/.test(execPath)) return { command: process.execPath, args: [execPath, ...args] };
  return { command: 'pnpm', args };
}

function runPnpm(stage: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  const command = pnpmArgs(args);
  return runCommand(stage, command.command, command.args, { cwd: REPO_ROOT, env });
}

async function createDatabase(adminUrl: string, name: string): Promise<void> {
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE ${quoteIdent(name)} WITH ENCODING 'UTF8' TEMPLATE template0`);
  } finally {
    await admin.end({ timeout: 5 });
  }
}

async function dropDatabase(adminUrl: string, name: string): Promise<void> {
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
  } catch (error) {
    console.error(`${STAGE_PREFIX} cleanup: failed to drop ${name}:`, describeError(error));
  } finally {
    await admin.end({ timeout: 5 }).catch(() => undefined);
  }
}

async function preLatestMigrationsDir(sqlFiles: string[], latest: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'nextdoo-restore-migrations-'));
  for (const file of sqlFiles) {
    if (file === latest) continue;
    await copyFile(join(MIGRATIONS_DIR, file), join(dir, file));
  }
  await copyFile(join(MIGRATIONS_DIR, 'legacy-checksums.json'), join(dir, 'legacy-checksums.json')).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
  return dir;
}

async function seedRepresentativeData(databaseUrl: string): Promise<void> {
  log('source', 'seeding representative non-secret rows');
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    const sessionHash = createHash('sha256').update(SMOKE_SESSION_TOKEN).digest('hex');
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO users (id, email, password_hash, name, time_zone, email_verified_at)
        VALUES ('00000000-0000-4000-8000-000000000001', 'restore-smoke@example.test', 'placeholder-not-a-real-password-hash', 'Restore Smoke User', 'UTC', '2026-09-19T00:00:00Z')
      `;
      await tx`
        INSERT INTO sessions (id, user_id, token_hash, device_label, expires_at)
        VALUES ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', ${sessionHash}, 'restore-smoke', now() + interval '30 days')
      `;
      await tx`
        INSERT INTO workspaces (id, owner_id, name, time_zone, week_start, workday_start_minute, workday_end_minute)
        VALUES ('00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001', 'Restore Smoke Workspace', 'UTC', 1, 540, 1020)
      `;
      await tx`
        INSERT INTO workspace_members (workspace_id, user_id, role)
        VALUES ('00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001', 'OWNER')
      `;
      await tx`
        INSERT INTO projects (id, workspace_id, name, description, color, position)
        VALUES ('00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000003', 'Restore Smoke Project', 'Synthetic restore smoke project', '#336699', 1)
      `;
      await tx`
        INSERT INTO sections (id, workspace_id, project_id, name, position)
        VALUES ('00000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000004', 'Smoke Section', 1)
      `;
      await tx`
        INSERT INTO tags (id, workspace_id, name, color)
        VALUES ('00000000-0000-4000-8000-000000000006', '00000000-0000-4000-8000-000000000003', 'restore-smoke', '#445566')
      `;
      await tx`
        INSERT INTO tasks (id, workspace_id, project_id, section_id, title, description, location, priority, due_at, time_zone, estimate_minutes, actual_minutes, actual_seconds_remainder, position)
        VALUES ('00000000-0000-4000-8000-000000000007', '00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000005', 'Restore smoke task', 'Synthetic restored task', 'Restore Lab', 'HIGH', '2026-09-20T09:00:00Z', 'UTC', 30, 1, 30, 1)
      `;
      await tx`
        INSERT INTO task_tags (task_id, tag_id)
        VALUES ('00000000-0000-4000-8000-000000000007', '00000000-0000-4000-8000-000000000006')
      `;
      await tx`
        INSERT INTO sync_changes (workspace_id, entity_type, entity_id, operation, payload, version, device_id)
        VALUES ('00000000-0000-4000-8000-000000000003', 'task', '00000000-0000-4000-8000-000000000007', 'create', '{"title":"Restore smoke task"}'::jsonb, 1, 'restore-smoke-device')
      `;
      await tx`
        INSERT INTO sync_tombstones (id, workspace_id, entity_type, entity_id, deleted_at, purge_after)
        VALUES ('00000000-0000-4000-8000-000000000008', '00000000-0000-4000-8000-000000000003', 'task', '00000000-0000-4000-8000-000000000008', '2026-09-19T00:00:00Z', '2026-10-19T00:00:00Z')
      `;
      await tx`
        INSERT INTO audit_logs (id, workspace_id, actor_id, action, target_type, target_id, metadata, request_id)
        VALUES ('00000000-0000-4000-8000-000000000009', '00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001', 'restore_smoke.seeded', 'task', '00000000-0000-4000-8000-000000000007', '{"source":"restore-smoke"}'::jsonb, 'restore-smoke')
      `;
      await tx`
        INSERT INTO outbox (id, event_type, workspace_id, actor_id, entity_type, entity_id, correlation_id, payload)
        VALUES ('00000000-0000-4000-8000-000000000010', 'restore_smoke.seeded', '00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001', 'task', '00000000-0000-4000-8000-000000000007', 'restore-smoke', '{"ok":true}'::jsonb)
      `;
      await tx`
        INSERT INTO tracking_events (id, workspace_id, task_id, type, actor_id, occurred_at, payload, idempotency_key)
        VALUES ('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000007', 'TASK_CREATED', '00000000-0000-4000-8000-000000000001', '2026-09-19T00:00:00Z', '{"source":"restore-smoke"}'::jsonb, 'restore-smoke-event')
      `;
      await tx`
        INSERT INTO tracking_results (id, workspace_id, task_id, score, outcome, components, explanation, measured_weight, input_hash, input_snapshot)
        VALUES ('00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000007', 95.0, 'ON_TIME', '{"dueDate":1}'::jsonb, 'Synthetic restore smoke score', 1.00, 'restore-smoke-input-hash', '{"taskId":"00000000-0000-4000-8000-000000000007"}'::jsonb)
      `;
      await tx`
        INSERT INTO calendar_connections (id, user_id, workspace_id, provider, external_account_id, mode, status, last_synced_at)
        VALUES ('00000000-0000-4000-8000-000000000013', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003', 'google', 'restore-smoke-calendar@example.test', 'READ_ONLY', 'DISCONNECTED', '2026-09-19T00:00:00Z')
      `;
      await tx`
        INSERT INTO calendar_events (id, connection_id, workspace_id, external_id, calendar_id, title, starts_at, ends_at, time_zone, is_all_day, busy, etag)
        VALUES ('00000000-0000-4000-8000-000000000014', '00000000-0000-4000-8000-000000000013', '00000000-0000-4000-8000-000000000003', 'restore-smoke-external-event', 'primary', 'Restore Smoke Calendar Event', '2026-09-20T10:00:00Z', '2026-09-20T11:00:00Z', 'UTC', false, true, 'restore-smoke-etag')
      `;
      await tx`
        INSERT INTO calendar_mappings (id, connection_id, task_id, external_id, calendar_id, sync_state, external_updated_at, local_updated_at)
        VALUES ('00000000-0000-4000-8000-000000000015', '00000000-0000-4000-8000-000000000013', '00000000-0000-4000-8000-000000000007', 'restore-smoke-external-event', 'primary', 'SYNCED', '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z')
      `;
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

interface Fingerprint {
  counts: Record<string, number>;
  digest: string;
  syncSequenceMax: number;
}

async function fingerprint(databaseUrl: string): Promise<Fingerprint> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    const [counts] = await sql<[Record<string, number>]>`
      SELECT
        (SELECT count(*)::int FROM users WHERE email = 'restore-smoke@example.test') AS users,
        (SELECT count(*)::int FROM workspaces WHERE id = '00000000-0000-4000-8000-000000000003') AS workspaces,
        (SELECT count(*)::int FROM workspace_members WHERE workspace_id = '00000000-0000-4000-8000-000000000003') AS workspace_members,
        (SELECT count(*)::int FROM projects WHERE id = '00000000-0000-4000-8000-000000000004') AS projects,
        (SELECT count(*)::int FROM sections WHERE id = '00000000-0000-4000-8000-000000000005') AS sections,
        (SELECT count(*)::int FROM tags WHERE id = '00000000-0000-4000-8000-000000000006') AS tags,
        (SELECT count(*)::int FROM tasks WHERE id = '00000000-0000-4000-8000-000000000007') AS tasks,
        (SELECT count(*)::int FROM task_tags WHERE task_id = '00000000-0000-4000-8000-000000000007') AS task_tags,
        (SELECT count(*)::int FROM sync_changes WHERE entity_id = '00000000-0000-4000-8000-000000000007') AS sync_changes,
        (SELECT count(*)::int FROM sync_tombstones WHERE id = '00000000-0000-4000-8000-000000000008') AS sync_tombstones,
        (SELECT count(*)::int FROM audit_logs WHERE id = '00000000-0000-4000-8000-000000000009') AS audit_logs,
        (SELECT count(*)::int FROM outbox WHERE id = '00000000-0000-4000-8000-000000000010') AS outbox,
        (SELECT count(*)::int FROM tracking_events WHERE id = '00000000-0000-4000-8000-000000000011') AS tracking_events,
        (SELECT count(*)::int FROM tracking_results WHERE id = '00000000-0000-4000-8000-000000000012') AS tracking_results,
        (SELECT count(*)::int FROM calendar_connections WHERE id = '00000000-0000-4000-8000-000000000013') AS calendar_connections,
        (SELECT count(*)::int FROM calendar_events WHERE id = '00000000-0000-4000-8000-000000000014') AS calendar_events,
        (SELECT count(*)::int FROM calendar_mappings WHERE id = '00000000-0000-4000-8000-000000000015') AS calendar_mappings
    `;
    const rows = await sql`
      SELECT u.email, u.name, w.name AS workspace_name, p.name AS project_name,
             s.name AS section_name, t.title, t.location, tag.name AS tag_name,
             ce.external_id, ce.title AS calendar_title, tr.outcome, tr.score::text AS score
      FROM users u
      JOIN workspaces w ON w.owner_id = u.id
      JOIN projects p ON p.workspace_id = w.id
      JOIN sections s ON s.project_id = p.id
      JOIN tasks t ON t.section_id = s.id
      JOIN task_tags tt ON tt.task_id = t.id
      JOIN tags tag ON tag.id = tt.tag_id
      JOIN calendar_connections cc ON cc.workspace_id = w.id
      JOIN calendar_events ce ON ce.connection_id = cc.id
      JOIN tracking_results tr ON tr.task_id = t.id
      WHERE u.email = 'restore-smoke@example.test'
      ORDER BY u.email, t.id
    `;
    const [{ max }] = await sql<[{ max: number | null }]>`SELECT max(sequence)::int AS max FROM sync_changes`;
    return {
      counts: counts ?? {},
      digest: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
      syncSequenceMax: max ?? 0,
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function assertFingerprints(source: Fingerprint, restored: Fingerprint): void {
  for (const [table, count] of Object.entries(source.counts)) {
    if (count !== 1) fail('integrity', `source fixture count for ${table} was ${count}, expected 1`);
    if (restored.counts[table] !== count) fail('integrity', `restored count mismatch for ${table}: ${restored.counts[table]} !== ${count}`);
  }
  if (restored.digest !== source.digest) fail('integrity', 'restored deterministic fingerprint did not match source');
}

async function expectSqlState(action: () => Promise<unknown>, state: string, stage: string): Promise<void> {
  try {
    await action();
  } catch (error) {
    if ((error as { code?: string }).code === state) return;
    throw error;
  }
  fail(stage, `expected SQLSTATE ${state}`);
}

async function verifyRestoredIntegrity(databaseUrl: string, sourceFingerprint: Fingerprint, totalMigrationFiles: number, latestMigration: string): Promise<void> {
  log('integrity', 'checking restored data, constraints, sequences and migration ledger');
  const restored = await fingerprint(databaseUrl);
  assertFingerprints(sourceFingerprint, restored);

  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    const [ledger] = await sql<[{ total: number; with_checksum: number; latest: number }]>`
      SELECT count(*)::int AS total,
             count(checksum)::int AS with_checksum,
             count(*) FILTER (WHERE name = ${latestMigration})::int AS latest
      FROM _migrations
    `;
    if (!ledger || ledger.total !== totalMigrationFiles || ledger.with_checksum !== totalMigrationFiles || ledger.latest !== 1) {
      fail('migration', `unexpected migration ledger: ${JSON.stringify(ledger)}`);
    }

    await expectSqlState(
      () => sql`INSERT INTO tags (id, workspace_id, name) VALUES ('00000000-0000-4000-8000-000000000016', '00000000-0000-4000-8000-000000000003', 'restore-smoke')`,
      '23505',
      'integrity',
    );
    await expectSqlState(
      () => sql`INSERT INTO tasks (id, workspace_id, title) VALUES ('00000000-0000-4000-8000-000000000017', '00000000-0000-4000-8000-000000009999', 'Invalid FK task')`,
      '23503',
      'integrity',
    );

    const [{ sequence }] = await sql<[{ sequence: number }]>`
      INSERT INTO sync_changes (workspace_id, entity_type, entity_id, operation, payload, version, device_id)
      VALUES ('00000000-0000-4000-8000-000000000003', 'task', '00000000-0000-4000-8000-000000000007', 'update', '{"smoke":"sequence"}'::jsonb, 2, 'restore-smoke-device')
      RETURNING sequence::int
    `;
    if (sequence <= sourceFingerprint.syncSequenceMax) fail('integrity', `sync_changes sequence did not advance (${sequence} <= ${sourceFingerprint.syncSequenceMax})`);

    await sql`
      INSERT INTO calendar_webhook_deliveries (connection_id, message_id, status, imported, processed_at, expires_at)
      VALUES ('00000000-0000-4000-8000-000000000013', 'restore-smoke-message', 'SUCCEEDED', 1, '2026-09-19T00:00:00Z', '2026-09-20T00:00:00Z')
    `;
    const [webhook] = await sql<[{ count: number }]>`
      SELECT count(*)::int AS count FROM calendar_webhook_deliveries
      WHERE connection_id = '00000000-0000-4000-8000-000000000013' AND message_id = 'restore-smoke-message'
    `;
    if (!webhook || webhook.count !== 1) fail('integrity', 'latest migration table did not accept representative Calendar webhook delivery row');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function runPgTool(stage: string, tool: 'pg_dump' | 'pg_restore', args: string[], target: PgTarget): void {
  runCommand(stage, tool, args, {
    env: { PGPASSWORD: target.password },
    redactArgs: true,
  });
}

async function waitForHealth(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  let last = 'not attempted';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/v1/health`, { cache: 'no-store' });
      const body = await response.json().catch(() => ({}));
      if (response.ok && body?.checks?.database === 'ok') return;
      last = `${response.status} ${JSON.stringify(body)}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  fail('application', `/api/v1/health did not become healthy: ${last}`);
}

async function smokeApplication(databaseUrl: string): Promise<void> {
  log('application', 'starting built Next.js production server against restored database');
  const appUrl = `http://localhost:${HEALTH_PORT}`;
  const pnpm = pnpmArgs(['exec', 'next', 'start', '-H', '0.0.0.0', '-p', String(HEALTH_PORT)]);
  const child = spawn(pnpm.command, pnpm.args, {
    cwd: join(REPO_ROOT, 'apps/web'),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      AUTH_SECRET,
      APP_URL: appUrl,
      NEXT_TELEMETRY_DISABLED: '1',
      TURBO_TELEMETRY_DISABLED: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs: string[] = [];
  const collect = (chunk: Buffer) => {
    const text = chunk.toString();
    logs.push(text);
    if (logs.join('').length > 8_000) logs.splice(0, logs.length - 20);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  try {
    await waitForHealth(appUrl);
    log('application', 'health endpoint reported database ok');
    const me = await fetch(`${appUrl}/api/v1/me`, { headers: { Cookie: `${SESSION_COOKIE}=${SMOKE_SESSION_TOKEN}` } });
    if (!me.ok) fail('application', `/api/v1/me returned ${me.status}`);
    const body = await me.json() as { email?: string; name?: string };
    if (body.email !== 'restore-smoke@example.test' || body.name !== 'Restore Smoke User') {
      fail('application', `authenticated restored-data read returned unexpected profile: ${JSON.stringify(body)}`);
    }
    log('application', 'authenticated /api/v1/me read restored profile data');
  } catch (error) {
    console.error(`${STAGE_PREFIX} application log tail:\n${logs.join('').slice(-4_000)}`);
    throw error;
  } finally {
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 5_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

async function assertBuiltApplicationExists(): Promise<void> {
  try {
    await stat(join(REPO_ROOT, 'apps/web/.next/BUILD_ID'));
  } catch {
    fail('application', 'apps/web/.next/BUILD_ID missing; run pnpm build before db:restore-smoke');
  }
}

async function main(): Promise<void> {
  const baseUrl = requireEnv('DATABASE_URL');
  const base = new URL(baseUrl);
  base.pathname = '/postgres';
  const adminUrl = base.toString();
  const target = pgTarget(baseUrl);
  const sqlFiles = (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith('.sql')).sort();
  if (sqlFiles.length < 2) fail('config', 'at least two migrations are required for pre-latest restore smoke');
  const latest = sqlFiles.at(-1)!;
  const sourceDb = dbName('restore_src');
  const targetDb = dbName('restore_tgt');
  const sourceUrl = urlFor(baseUrl, sourceDb);
  const targetUrl = urlFor(baseUrl, targetDb);
  const tempDir = await mkdtemp(join(tmpdir(), 'nextdoo-restore-smoke-'));
  const dumpPath = join(tempDir, 'nextdoo-restore-smoke.dump');
  let preLatestDir: string | null = null;
  let sourceCreated = false;
  let targetCreated = false;

  try {
    await assertBuiltApplicationExists();
    log('config', `latest migration boundary is ${latest}`);
    preLatestDir = await preLatestMigrationsDir(sqlFiles, latest);

    log('source', `creating disposable source database ${sourceDb}`);
    await createDatabase(adminUrl, sourceDb);
    sourceCreated = true;
    const appliedPreLatest = await runMigrations(sourceUrl, preLatestDir);
    if (appliedPreLatest.length !== sqlFiles.length - 1) fail('source', `expected ${sqlFiles.length - 1} pre-latest migrations, applied ${appliedPreLatest.length}`);
    log('source', `applied ${appliedPreLatest.length} migrations before ${latest}`);
    await seedRepresentativeData(sourceUrl);
    const sourceFingerprint = await fingerprint(sourceUrl);

    log('backup', 'creating PostgreSQL custom-format logical backup with pg_dump -Fc');
    runPgTool('backup', 'pg_dump', ['-Fc', '--no-owner', '--no-acl', '--file', dumpPath, '--host', target.host, '--port', target.port, '--username', target.user, '--dbname', sourceDb], target);
    const dumpStat = await stat(dumpPath);
    if (dumpStat.size <= 0) fail('backup', 'pg_dump produced an empty dump artifact');
    log('backup', `dump produced (${dumpStat.size} bytes, temp artifact not uploaded)`);

    log('restore', `creating disposable target database ${targetDb}`);
    await createDatabase(adminUrl, targetDb);
    targetCreated = true;
    runPgTool('restore', 'pg_restore', ['--exit-on-error', '--single-transaction', '--no-owner', '--no-acl', '--host', target.host, '--port', target.port, '--username', target.user, '--dbname', targetDb, dumpPath], target);
    log('restore', 'pg_restore completed without errors');

    log('migration', 'running normal repository migration command against restored database');
    const migrateOutput = runPnpm('migration', ['--filter', '@nextdoo/db', 'migrate'], { DATABASE_URL: targetUrl });
    if (!migrateOutput.includes(latest)) fail('migration', `normal migration command did not report applying latest migration ${latest}`);
    const rerunOutput = runPnpm('migration', ['--filter', '@nextdoo/db', 'migrate'], { DATABASE_URL: targetUrl });
    if (!/Already up to date/.test(rerunOutput)) fail('migration', 'migration rerun was not idempotent');
    log('migration', 'post-restore migration applied latest migration and rerun was idempotent');

    await verifyRestoredIntegrity(targetUrl, sourceFingerprint, sqlFiles.length, latest);
    await smokeApplication(targetUrl);
    log('complete', 'backup → restore → migration → integrity → application smoke passed');
  } finally {
    log('cleanup', 'removing temporary databases and dump artifacts');
    if (sourceCreated) await dropDatabase(adminUrl, sourceDb);
    if (targetCreated) await dropDatabase(adminUrl, targetDb);
    await rm(tempDir, { recursive: true, force: true });
    if (preLatestDir) await rm(preLatestDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`${STAGE_PREFIX} failed:`, describeError(error));
  process.exit(1);
});
