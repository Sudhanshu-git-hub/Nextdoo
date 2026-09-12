# M2 capture/mutation instrumentation + collection-scale performance acceptance — report

Date: 2026-09-10 (Asia/Calcutta). Scope: the next M2 increment from the
[PHASE1_COMPLETION_PLAN.md](PHASE1_COMPLETION_PLAN.md) milestone table — the
remaining "collection scalability; required capture/mutation instrumentation
and core performance/a11y acceptance" column, implemented as one bounded
increment. **This is not all of M2:** the PRD §19.4 staging load test itself
is an operational qualification that needs a staging environment and is not
executable from this workspace (see *Remaining*).

## PRD requirements addressed

- **§21.3 (Milestone 2 instrumentation):** "capture latency · task creation
  success rate · task mutation error rate · active-task count" — all four
  metrics now have event producers.
- **§20.3 (metric definitions):** capture latency is defined as "time from
  capture UI open to saved task" and must not collect task content ("content
  fields excluded by default") — the client measures open→save, and the
  telemetry payload is schema-strict to exactly `{ latencyMs, success,
  confirmed }`; any extra field (i.e. content) is rejected with 400.
- **§19.4 (performance gate):** read p95 < 300 ms / write p95 < 500 ms and
  the observability requirement that the milestone's metrics exist. The gate's
  *staging load test* remains operational; this increment delivers the
  repeatable measurement harness and measured local reference numbers (below).
- **§6.9 (list scalability):** windowed rendering was delivered in the
  virtualization milestone; this increment extends verified collection scale
  from 250 to **1,000 loaded tasks** (full cursor pagination, bounded DOM,
  deep-page order) and measures deep-page read latency at that scale.

## Design decisions

- **Metrics ride the existing structured logger.** `apps/web/src/server/metrics.ts`
  emits typed single-line JSON events (`task.created`, `task.create_failed`,
  `task.mutated`, `task.mutation_failed`, `workspace.active_tasks`,
  `task.capture`) through the same `logger` sink as M1 request tracing
  (`observability.ts`). No new infrastructure: a real deployment points the
  same sink at an OTel collector/log shipper. Metric emission is
  try/caught — a metrics failure can never break a request.
- **One seam covers every channel.** All eight task mutations (create,
  update, complete, reopen, reschedule, archive, delete, restore) are thin
  `withTaskMetric` wrappers over their byte-identical `*Core` internals.
  HTTP routes, bulk commands and sync all call these service functions, so
  one instrumentation point covers all write channels with zero call-site
  changes except the sync channel tag.
- **Channel tagging via the actor, not a parameter.** `TaskActor` gained an
  optional `via: 'http' | 'sync'`; `pushMutations` is the single place that
  sets `via: 'sync'`. HTTP and bulk keep the default `'http'`.
- **The active-task gauge is best-effort and precise.** `workspace.active_tasks`
  is emitted only after *count-changing* mutations (create/complete/reopen/
  archive/restore/delete — never update/reschedule), outside the committed
  transaction, with its own failure swallowed.
- **Capture latency is client-measured, fire-and-forget.** `QuickCapture`
  stamps `performance.now()` on first focus (the "capture UI open" moment,
  including the `N` shortcut), reports on save success *and* failure with the
  `confirmed` flag set when the save came from the low-confidence
  confirmation strip, and forgets the report if it fails — telemetry never
  retries, never blocks, and never affects the capture UX.
- **Strict content-free telemetry endpoint.** `POST /api/v1/telemetry/capture`
  (`authedRoute`, 60 req/min) parses with a strict zod schema that forbids
  unknown keys and bounds `latencyMs` to 0…3,600,000. Task content cannot
  reach the event by construction.

## Files changed

| File | Change |
|---|---|
| `apps/web/src/server/metrics.ts` | **new** — typed metric events, `withTaskMetric` timing wrapper, `setMetricSink` test hook |
| `apps/web/src/server/services/tasks.ts` | 8 mutation exports → metric wrappers over `*Core`; `TaskActor.via`; `emitActiveTaskCount` gauge |
| `apps/web/src/server/services/sync.ts` | `pushMutations` tags `syncActor` with `via: 'sync'` |
| `apps/web/src/app/api/v1/telemetry/capture/route.ts` | **new** — strict, authed, rate-limited telemetry endpoint |
| `packages/contracts/src/schemas.ts` | **new** `captureTelemetrySchema` (strict, content-free) |
| `apps/web/src/components/QuickCapture.tsx` | open→save latency measurement + fire-and-forget telemetry report |
| `apps/web/src/server/services/metrics.instrumentation.integration.test.ts` | **new** — 6 integration tests around the metric seam |
| `apps/web/e2e/metrics-instrumentation.spec.ts` | **new** — 3 browser tests: telemetry emission/validation + 1000-task scale |
| `scripts/perf-baseline.mjs` | **new** — repeatable API latency baseline harness (PRD §19.4 reference numbers) |
| `eslint.config.mjs` | `fetch`/`performance`/`setTimeout` Node globals for the new script |

## Tests and measured results

**New coverage (all passing):**

- Integration (`metrics.instrumentation.integration.test.ts`, 6 tests):
  `task.created` with duration + `via: 'http'` + gauge; `task.create_failed`
  with the AppError code (`VALIDATION_FAILED`) and rethrow, no success event;
  `task.mutated` for complete/reopen with the gauge moving down then up;
  `task.mutation_failed` with `RESOURCE_VERSION_CONFLICT` on a stale version,
  no success event; no gauge on count-preserving update; sync-channel
  mutations tagged `via: 'sync'`.
- E2E (`metrics-instrumentation.spec.ts`, 3 tests): direct capture emits one
  200 telemetry report `{ latencyMs > 0, success: true, confirmed: false }`
  with exactly the three whitelisted keys; confirmed capture reports
  `confirmed: true`, and the endpoint rejects extra fields (content) with
  400, negative/oversized latency with 400, unauthenticated with 401, and
  accepts a valid body with 200; a 1,000-task inbox paginates fully
  (20 pages), renders a virtualized list of exactly 1,000 `li` with < 400
  real rows and ≥ 600 `aria-hidden` placeholders (bounded DOM), and deep
  pages render in exact newest→oldest order (top `999…`, bottom `000`).

**Measured API latency baseline** (`scripts/perf-baseline.mjs`, 1,000 seeded
tasks, 40 iterations/operation, production `next start` + local Postgres,
single process, localhost — a reference baseline, **not** the PRD staging
load test):

| Operation | p50 (ms) | p95 (ms) | max (ms) | PRD budget (p95) | Result |
|---|---:|---:|---:|---:|---|
| List first page (50 rows) | 10.7 | 13.6 | 41.3 | 300 ms read | PASS |
| List deep page (offset 500) | 9.7 | 12.5 | 24.1 | 300 ms read | PASS |
| Task read | 7.4 | 10.3 | 15.1 | 300 ms read | PASS |
| Task search | 12.7 | 15.4 | 18.5 | 300 ms read | PASS |
| Task create | 16.1 | 21.7 | 22.5 | 500 ms write | PASS |
| Task update | 18.6 | 21.0 | 61.0 | 500 ms write | PASS |
| Task complete | 22.6 | 27.3 | 27.6 | 500 ms write | PASS |

Reproduce: `APP_URL=http://localhost:3100 DATABASE_URL=… node
scripts/perf-baseline.mjs --tasks 1000 --iterations 40`. The benchmark runs
the write path on the unlimited (PRO) plan — the FREE 200-active-task cap
is entitlement behavior, not a performance characteristic.

**Full local gates (this commit):** lint (0 warnings), typecheck, coverage
(87.41% statements, gate met), build, **51 test files / 498 unit+integration
tests** (baseline 50/492; +6 instrumentation tests), **105/105 E2E**
(baseline 102; +3 new). Remote CI is verified against the pushed commit,
separately from this local evidence.

**a11y:** the list's accessibility surface (rows, focus pinning, virtualized
placeholders) was axe-verified in the virtualization milestone and is
structurally unchanged at 1,000 rows (same row markup, same placeholder
pattern with `aria-hidden`); this increment re-asserts the placeholder
`aria-hidden` contract at scale. No new a11y surface was introduced by the
telemetry work (no UI change beyond the existing capture input's
unobservable timestamp).

## Remaining (explicit)

- **PRD §19.4 staging load test** — operational: needs the staging
  environment, load generator and SLO recording. The harness and local
  reference numbers exist; the staging run does not. This is the only M2
  completion work left after this increment.
- Metrics are emitted to the structured log; an OTel/collector hookup and
  alerting on `task.create_failed` / `task.mutation_failed` rates are
  deployment-side work (M1 observability tail), not M2 application work.
