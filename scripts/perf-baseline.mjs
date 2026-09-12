#!/usr/bin/env node
/**
 * M2 collection-scalability + API performance baseline (PRD §19.4
 * performance gate, §16.5 "API benchmarks", §6.9 list scalability).
 *
 * Usage:
 *   APP_URL=http://localhost:3100 DATABASE_URL=postgres://... \
 *     node scripts/perf-baseline.mjs [--tasks 1000] [--iterations 40]
 *
 * What it does:
 *   1. Registers a fresh tenant and seeds `--tasks` tasks directly in the
 *      database (bypassing rate limits, the same technique the virtualization
 *      E2E uses).
 *   2. Runs `--iterations` of each operation over HTTP against the running
 *      server and reports p50/p95/max.
 *   3. Compares against the PRD thresholds (read p95 < 300 ms, write p95
 *      < 500 ms) as a PASS/FAIL reference.
 *
 * Honest scope: this is a LOCAL, single-process, single-tenant baseline on
 * whatever machine runs it (here: sandbox + local Postgres). The PRD §19.4
 * gate itself requires a STAGING load test; this script is the repeatable
 * harness that produces the reference numbers the staging run is compared
 * against. It exits 0 even when a threshold is missed (report mode) and 2
 * when the harness itself cannot run.
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';

const APP_URL = (process.env.APP_URL || 'http://localhost:3100').replace(/\/$/, '');
const DATABASE_URL = process.env.DATABASE_URL;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
}
const TASKS = arg('tasks', 1000);
const ITERATIONS = arg('iterations', 40);
const READ_BUDGET_MS = 300;
const WRITE_BUDGET_MS = 500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];

function summary(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return { count: sorted.length, p50: pct(sorted, 50), p95: pct(sorted, 95), max: sorted[sorted.length - 1] };
}

async function main() {
  if (!DATABASE_URL) {
    console.error('DATABASE_URL is required.');
    process.exit(2);
  }

  // 1. Fresh tenant.
  const register = await fetch(`${APP_URL}/api/v1/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: APP_URL, 'x-forwarded-for': '198.51.100.77' },
    body: JSON.stringify({ email: `perf-${Date.now()}@test.local`, password: 'perf-baseline-password-123', timeZone: 'UTC' }),
  });
  if (register.status !== 200) throw new Error(`register failed with ${register.status}`);
  const cookie = (register.headers.get('set-cookie') || '').split(';')[0];
  const { id: userId, workspaceId } = await register.json();
  const headers = { 'content-type': 'application/json', cookie, origin: APP_URL };

  // 2. Seed the collection.
  const sql = postgres(DATABASE_URL, { max: 4 });
  // The FREE plan caps active tasks at 200; the benchmark measures the
  // unlimited (PRO) path so 1000+ seeded tasks never 402 on write.
  // The effective plan is read from subscriptions (see readEffectivePlan).
  await sql.unsafe(`update subscriptions set plan = 'PRO', status = 'ACTIVE' where user_id = $1`, [userId]);
  const now = Date.now();
  const batch = [];
  const batchInsert = async (rows) => {
    await sql.unsafe(
      `insert into tasks (id, workspace_id, title, status, priority, position, due_at, created_at, updated_at)
       values ${rows.map((_, i) => `($${i * 7 + 1},$${i * 7 + 2},$${i * 7 + 3},$${i * 7 + 4},$${i * 7 + 5},$${i * 7 + 6},$${i * 7 + 7},now(),now())`).join(',')}`,
      rows.flat(),
    );
  };
  for (let i = 0; i < TASKS; i += 1) {
    batch.push([randomUUID(), workspaceId, `Perf bench task ${i}`, 'ACTIVE', 'NONE', String(now - (TASKS - i) * 1000), new Date(now + (i % 30) * 86_400_000)]);
    if (batch.length === 250) {
      await batchInsert(batch);
      batch.length = 0;
    }
  }
  if (batch.length) {
    await sql.unsafe(
      `insert into tasks (id, workspace_id, title, status, priority, position, due_at, created_at, updated_at)
       values ${batch.map((_, i) => `($${i * 7 + 1},$${i * 7 + 2},$${i * 7 + 3},$${i * 7 + 4},$${i * 7 + 5},$${i * 7 + 6},$${i * 7 + 7},now(),now())`).join(',')}`,
      batch.flat(),
    );
  }
  console.log(`Seeded ${TASKS} tasks in workspace ${workspaceId}`);

  // Scratch tasks for the write operations (rotate complete/reopen pairs).
  const scratch = [];
  for (let i = 0; i < ITERATIONS; i += 1) {
    scratch.push([randomUUID(), workspaceId, `Perf write target ${i}`]);
  }
  await sql.unsafe(
    `insert into tasks (id, workspace_id, title, status, priority, position, created_at, updated_at)
     values ${scratch.map((_, i) => `($${i * 3 + 1},$${i * 3 + 2},$${i * 3 + 3},'ACTIVE','NONE',0,now(),now())`).join(',')}`,
    scratch.flat(),
  );

  const read = async (path) => {
    const started = performance.now();
    const res = await fetch(`${APP_URL}${path}`, { headers });
    const body = await res.json().catch(() => null);
    const ms = performance.now() - started;
    if (res.status !== 200) throw new Error(`GET ${path} -> ${res.status}`);
    return { ms, body };
  };
  const write = async (method, path, body) => {
    const started = performance.now();
    const res = await fetch(`${APP_URL}${path}`, {
      method,
      headers: { ...headers, 'idempotency-key': randomUUID() },
      body: JSON.stringify(body ?? {}),
    });
    const ms = performance.now() - started;
    if (res.status >= 300) throw new Error(`${method} ${path} -> ${res.status}`);
    return ms;
  };

  // Warm-up (JIT, connection pools, caches) — not measured.
  await read(`/api/v1/tasks?workspaceId=${workspaceId}&status=ACTIVE&limit=50`);
  await sleep(250);

  const results = {};

  // Deep-page cursor: walk to page 11 (offset 500) once, then measure it.
  let deepCursor = null;
  for (let page = 0; page < 10; page += 1) {
    const path = deepCursor
      ? `/api/v1/tasks?workspaceId=${workspaceId}&status=ACTIVE&limit=50&cursor=${encodeURIComponent(deepCursor)}`
      : `/api/v1/tasks?workspaceId=${workspaceId}&status=ACTIVE&limit=50`;
    const { body } = await read(path);
    deepCursor = body?.pagination?.next_cursor ?? null;
    if (!deepCursor) break;
  }
  if (!deepCursor) throw new Error('could not reach a deep page');

  for (let i = 0; i < ITERATIONS; i += 1) {
    (results.list_page_first ??= []).push((await read(`/api/v1/tasks?workspaceId=${workspaceId}&status=ACTIVE&limit=50`)).ms);
    (results.list_page_deep ??= []).push((await read(`/api/v1/tasks?workspaceId=${workspaceId}&status=ACTIVE&limit=50&cursor=${encodeURIComponent(deepCursor)}`)).ms);
    const anyTask = scratch[i % scratch.length][0];
    (results.task_read ??= []).push((await read(`/api/v1/tasks/${anyTask}`)).ms);
    (results.task_search ??= []).push((await read(`/api/v1/tasks?workspaceId=${workspaceId}&status=ACTIVE&limit=50&q=bench`)).ms);
    (results.task_create ??= []).push(await write('POST', '/api/v1/tasks', { workspaceId, title: `Perf created ${Date.now()}-${i}`, priority: 'NONE' }));
    // Each scratch task is touched exactly once per operation: update moves
    // version 1 -> 2, complete then expects version 2.
    (results.task_update ??= []).push(await write('PATCH', `/api/v1/tasks/${anyTask}`, { version: 1, priority: i % 2 ? 'LOW' : 'NONE' }));
    (results.task_complete ??= []).push(await write('POST', `/api/v1/tasks/${anyTask}/complete`, { version: 2 }));
  }

  // Restore the scratch tasks (complete left them COMPLETED).
  await sql.unsafe(`update tasks set status = 'ACTIVE' where workspace_id = $1 and title like 'Perf write target%'`, [workspaceId]);

  const report = {
    environment: {
      note: 'Local single-process baseline (sandbox + local Postgres), not the PRD §19.4 staging load test.',
      tasks: TASKS,
      iterations: ITERATIONS,
    },
    budgetsMs: { readP95: READ_BUDGET_MS, writeP95: WRITE_BUDGET_MS },
    results: {},
  };
  const isWrite = (name) => name.startsWith('task_') && !name.startsWith('task_read') && !name.startsWith('task_search');
  let overallPass = true;
  for (const [name, samples] of Object.entries(results)) {
    const s = summary(samples);
    const budget = isWrite(name) ? WRITE_BUDGET_MS : READ_BUDGET_MS;
    const pass = s.p95 < budget;
    if (!pass) overallPass = false;
    report.results[name] = { ...s, budgetMs: budget, pass };
  }
  report.overall = overallPass ? 'PASS (local reference)' : 'MISS (local reference — see staging load test)';
  console.log(JSON.stringify(report, null, 2));
  await sql.end();
}

main().catch((error) => {
  console.error('perf harness error:', error.message);
  process.exit(2);
});
