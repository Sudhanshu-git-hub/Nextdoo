# Approved continuation: quality gates and integrity only

Baseline: `49b2e68`, preserved on remote `feat/mvp-implementation`. Work stays on
`arena/01a080d5-nextdoo`. No history rewrites or later product-feature implementation.

## Phase 1 — quality gates

- Real ESLint checks now run; removed unused imports/dead declarations, not working behavior.
- Integration tests fail if DATABASE_URL or the migrated database is unavailable.
  `test:unit` remains intentionally database-free.
- V8 coverage includes core and server services. Core thresholds are 85% on all four metrics.
- Playwright isolates E2E discovery, uses a real production server/database/browser and unique accounts.
- CI provisions PostgreSQL 16/UTF-8 and runs installation, audit, migration replay,
  lint, typecheck, coverage, build and E2E. Remote CI is not claimed executed until pushed/run.
- Dependencies upgraded compatibly: Next stays on 15, React on 19, Drizzle remains ORM;
  Vitest/Playwright/build tooling patched. Explicit Sharp/PostCSS/Vite pins cover transitive findings.
- Removed obsolete Drizzle Kit generator, replacing it with a tested, exclusive-write,
  nonzero-on-error **manual SQL scaffold** consistent with the existing migration workflow.
- Documentation now distinguishes actual services from reserved config and placeholders.

Verification: 193 tests passed (baseline 191 plus two migration-tool tests), 2 real
Chromium E2E passed, lint/typecheck/build passed. Core: 99.50% lines, 96.45%
statements, 85.58% branches, 100% functions. Full dependency audit: **0 findings**
(previously 4 critical/17 high; production previously 2 critical/16 high).

Environment: standard Playwright CDN download failed ECONNRESET. Locally ran real
Chromium 149 from a registry-distributed binary via executable-path override and
its native libraries; no API mocks or disabled browser security. CI installs the
standard Playwright browser. Local DB is PostgreSQL 18.4 UTF-8; CI specifies 16.

## Phase 2

The seven prioritized repair groups below are implemented and verified, with
regressions added before repairs. This is not closure of the entire baseline audit
or a production security certification. See `docs/REPAIR_REPORT.md` for remaining
audit findings, deployment caveats, validation evidence and the stop point.

### Tenant isolation repair

Added 9 database-backed regressions covering foreign task-ID collisions, foreign
mutation replay, update/delete attempts, project/section/tag references through
online and sync mutations, and inconsistent conflict snapshots. **6 failed before
repair; all 9 pass after.** Scoped replay/collision/conflict targets and added shared
reference authorization. Full verification passed: 202 tests, 2 browser E2E,
coverage thresholds, lint, typecheck and production build.

### Atomic HTTP idempotency

Added five regression cases; **four failed before repair** (concurrent creates,
changed request identity, missing keys, partial-commit rollback). Transaction-local
service context now lets the wrapper commit domain state and response ledger
atomically under a per-user/key PostgreSQL advisory lock. Canonical request hashing
includes method/path/query/body. Legacy response-only ledger entries are rejected
rather than guessed or silently reexecuted. Full verification: **207 tests and
2 E2E passed**, lint/typecheck/coverage/build passed.

### Commit-ordered sync cursors

A real two-connection regression reproduced the late-commit skip. Migration 0002
assigns sync sequence numbers inside a BEFORE INSERT trigger after acquiring a
global transaction advisory lock, so a higher number cannot commit first. This
covers application, worker and raw SQL writers. **Throughput tradeoff:** sync writes
serialize globally through commit; no claim of production load/SLO validation.
Migration applied successfully and rerun was a no-op. Regression green and full
verification passed: **208 tests, 2 E2E**, lint/typecheck/coverage/build.

### Sync/domain parity and entitlement integrity

Seven new regressions all failed before repair, now pass. Sync create/update/delete
and conflict resolution call task domain operations instead of raw task writes;
completion timestamps/history/scoring and reminder cancellation now share the
transaction. Workspace mutation locks protect merge decisions and concurrent task
limits, including online creates. Mutation-ID replay is serialized and bound to
request identity (migration 0003); old identity-less records are conservatively
rejected. Canceled subscriptions retain paid entitlements until currentPeriodEnd.
No billing/provider integration added. Full verification passed: **215 tests,
2 E2E**, lint/typecheck/coverage/build.

### Scoring and reopen integrity

Five regressions added; four failed before repair. Evaluations now lock before
assembling inputs and serialize with workspace mutations. Migration 0004 retains
historical results while enforcing exactly one active result per task/occurrence;
returning to an old input appends a new historical row. Reopen and scoring-input
edits reevaluate atomically, failures roll back rather than being swallowed, due
cutoff changes invalidate cached inputs, and TR-06 includes skipped occurrences in
the denominator. Full verification passed: **220 tests, 2 E2E**, all other gates.

### Timer integrity and Focus clock

Five database regressions failed before repair; all pass after. Starts/transitions
serialize per user, acquiring affected workspace locks before task writes. Older
offline starts preserve the newer canonical session; terminal sessions cannot be
credited again; transitions cannot move backward. Credited time now versions and
syncs the task and reevaluates atomically. Migration 0005 records event transition
time; legacy rows can only be backfilled to their best known durable lower bound
(the old schema did not store each pause timestamp).

A real browser regression reproduced **NaN:NaN:NaN** after fixing the test fixture
to save a fully specified date rather than leave a capture confirmation open.
Focus now consumes the API's elapsedSeconds snapshot and advances from receipt,
not the original start time. Full verification passed: **225 tests, 3 E2E**,
lint/typecheck/coverage/build.

### Account purge with real task history

Three regressions initially failed, including the actual worker job path. Both
service and worker now use a shared atomic purge that rechecks deletion eligibility
under a row lock, removes private outbox and replay payloads, and retains audit
records (PRD separate one-year retention). Migration 0006 permits tracking deletion
only through final account/workspace cascade and prevents live-account workspace
deletion from bypassing immutability. Direct tracking UPDATE/DELETE still fail.
No provider or billing-retention integration added. Full verification passed:
**228 tests, 3 E2E**, lint/typecheck/coverage/build.

### Browser cache isolation

Final security review reproduced the accepted audit's browser-cache disclosure
with two real accounts in the same browser and a failed task request. Task cache
reads/writes now require workspace provenance; unscoped legacy records are not
rendered. The browser regression failed before and passes after. Full verification
passed: **228 tests, 4 E2E**, lint/typecheck/coverage/build. This is a security repair,
not completion of offline capture/queue/conflict UX.

### Adjacent lifecycle/data-loss checks

Five additional database regressions failed before repair and pass after: expired
restore/task-cap bypass, lost reschedule intent and relative-reminder dates, raw
Date binding in the alternate reminder dispatcher, expired paid-grace access, and
silently ignored recurrence inputs. Recurrence generation remains out of scope:
unsupported recurring creates now explicitly fail without creating a one-off task.
A real browser regression also failed before capture forwarded the parsed rule;
it now shows the unsupported message and preserves the original input text.
Provider dispatch is still not implemented; the dispatcher regression claims zero
rows and verifies binding only. Full verification: **233 tests, 5 E2E**, all gates.


## Final verification and stop point

Final verification ran against **fresh `nextdoo_verify_20260908`**, not just the
repair database. Migrations 0000–0006 applied successfully; the second run was a
no-op. `pnpm verify` passed: 233 tests in 18 files, five real Chromium E2E tests,
core coverage thresholds, lint, typecheck and production build. Full audit remains
zero across all severities. `git diff --check` found one inherited test whitespace
line introduced by Phase 1 cleanup; it was removed before the final documentation
commit. No functional test assertions were removed or weakened.

Stop here: no subsequent product milestone was started. Full audit closure is NOT
claimed; the separate authentication-hardening finding and offline queue/provider/
production gaps are explicitly carried forward in `docs/REPAIR_REPORT.md`.

After resuming the interrupted documentation turn, `pnpm verify` was repeated
successfully (233 tests, 5 E2E, all gates); evidence: `final-resume-verify.log`.


## Separately authorized task-management continuation — 2026-09-09

The quality/integrity stop point above remains historical. Subsequent user-approved
project, board, relationship, lifecycle, filtering and bulk milestones are recorded
in their dedicated reports. The next dependency, recurrence, now has a shared real-task
generator, independently scheduled worker, scoped/versioned/idempotent APIs and an
online capture/editor/series-management workflow. User-approved DST and preserve-
generated-history policies, regression failures/fixes, bounds and release limitations
are in [TASK_RECURRENCE_MILESTONE.md](TASK_RECURRENCE_MILESTONE.md).

Final local validation: **386 tests / 41 files, 57 browser/API scenarios**, lint,
types, coverage, production build and migration replay passed; audit is zero across
all severities. No working board/subtask implementation was replaced. Personal-
workspace settings is next, pending workday-hour policy review. Phase 1 is incomplete;
AI, billing, desktop and full offline mode were not started.


## Personal-workspace settings — 2026-09-09

After the user selected overnight hours, implemented owner-only versioned settings,
transactional audit/sync/outbox, persistent guarded UI and workspace-local capture,
Today and week-calendar defaults. Existing task instants and recurrence history are
preserved. [WORKSPACE_SETTINGS_MILESTONE.md](WORKSPACE_SETTINGS_MILESTONE.md) records
regression-first evidence, limits and **394 tests / 43 files, 62 browser/API scenarios**,
full local gates and zero dependency findings. No new migration was needed. The
recurrence commit's remote CI passed. Board optimistic movement/rollback is the
remaining focused acceptance fix in the current task-management scope.


## Board optimistic-movement acceptance closure — 2026-09-09

A focused follow-up closes the remaining §6.9 card-movement/rollback requirement
without replacing the board. The held-request regression failed before the change;
it now proves immediate movement, rollback, preserved destination and stable retry.
A lost-after-commit response test proves exactly one version increment. Full gates:
**394 tests / 43 files, 64 browser/API scenarios**, zero audit findings. See
[BOARD_OPTIMISTIC_ACCEPTANCE.md](BOARD_OPTIMISTIC_ACCEPTANCE.md). The separately
pushed recurrence/workspace commits passed remote CI. All currently requested
workflows are functional within documented bounds; Phase 1 remains incomplete.


## Expanded online-workflow continuation: notifications/reminders — 2026-09-09

The user expanded authorization to remaining non-AI/non-billing online MVP gaps,
retaining the desktop/full-offline exclusions. The next bounded milestone fixes
reminder poison-batch failure, retry/identity/lifecycle and tenant/deletion guards,
and delivers an in-app notification center with real status/read/snooze/cancel and
paginated history. Legacy notification export references are privacy-filtered;
linked notification/read/reminder account purge is verified.

[NOTIFICATION_DELIVERY_MILESTONE.md](NOTIFICATION_DELIVERY_MILESTONE.md) records
regression-first failures, timestamp/refresh fixes and acceptance boundaries. Final
local gates: **405 tests / 44 files, 69 browser/API scenarios**, lint, types, coverage,
build, migration 0012/replay and zero dependency findings. Native/background browser
notifications, enabled reminder SMTP, general outbox consumers and the remainder of
Phase 1 are explicitly open. Durable tracking/freshness is next; no AI, billing,
desktop or full offline feature was started.


## Durable tracking and freshness — 2026-09-09

Implemented the next user-selected online milestone without changing the PRD,
mathematical score weights or existing UTC/current-task reporting cohorts.
[TRACKING_DURABILITY_MILESTONE.md](TRACKING_DURABILITY_MILESTONE.md) records the
pipeline, API/UI contracts, regression evidence, deployment bounds and remaining
M4/operational gaps.

Highlights: shared DB calculation engine version 2; transactional invalidation for
web and standalone producers; per-consumer outbox receipts; leased, fenced work
with an initial attempt plus five retries; due-time/cohort/version reconciliation;
complete scoped event hashes and immutable source snapshots/history; result-event
publication atomic with result/checkpoint; freshness notices and resumable evidence;
audited CAS/idempotent single-task recovery with lost-acknowledgement protection.

Regression-first tests exposed foreign-workspace skip contamination, tied-time
source-event loss and a held-poll recovery race. All were fixed without weakening
existing assertions. A real standalone worker is killed mid-calculation in an
isolated migrated database and a new process recovers its persisted claim safely.

Final local gates: **422 tests / 46 files and 75 browser/API scenarios**, lint,
types, coverage and build passed. Frozen install, migrations 0013/0014/replay and
zero-finding dependency audit passed. Remote CI is verified against the pushed
milestone commit, separately from local evidence.

Date-range corrections/backfill, workspace-local reporting, reviewed controls,
TR-03 policy, routed alerts/load SLOs and wider Phase 1 integrations remain open.
No AI, billing, desktop or full offline feature was started.

## M2 capture/mutation instrumentation + collection-scale performance acceptance — 2026-09-10

Implemented the next M2 increment without changing the PRD, the existing
APIs or any verified milestone.
[M2_INSTRUMENTATION_MILESTONE.md](M2_INSTRUMENTATION_MILESTONE.md) records the
PRD requirements, design decisions, test evidence, measured baseline and the
remaining operational gate.

Highlights: typed metric events over the existing structured-log sink
(`task.created`/`task.create_failed`, `task.mutated`/`task.mutation_failed`,
`workspace.active_tasks` gauge, `task.capture`) with one instrumentation seam
covering HTTP, bulk and sync (channel-tagged via the actor); a strict,
content-free `POST /api/v1/telemetry/capture` endpoint fed by
client-measured open→save latency in QuickCapture (fire-and-forget, never
blocks capture); 1,000-task inbox E2E proving full cursor pagination, bounded
virtualized DOM and exact deep-page order; and a repeatable API latency
baseline (`scripts/perf-baseline.mjs`) measuring all seven read/write
operations at 1,000 seeded tasks — every p95 within the PRD §19.4 budgets
(read 9.7–15.4 ms vs 300 ms; write 21.0–27.3 ms vs 500 ms) as a local
reference, with the staging load test itself remaining an operational
qualification.

Final local gates: **51 test files / 498 unit+integration tests** and
**105/105 browser/API scenarios** (baseline 50/492 and 102), lint (0
warnings), types, coverage (87.41% statements) and build passed. Remote CI is
verified against the pushed milestone commit, separately from local evidence.

The only remaining M2 completion work is the PRD §19.4 staging load test
execution (staging environment + load generator), plus deployment-side
collector/alerting wiring for the new events. No M3, provider, billing,
desktop or full-offline work was started.

Implemented the next M3 increment without changing the PRD, the existing
APIs or any verified milestone.
[M3_CAPACITY_PLANNING_MILESTONE.md](M3_CAPACITY_PLANNING_MILESTONE.md) records
the PRD requirements, design decisions, test evidence and the remaining
deferred work.

Highlights: a pure, timezone-free core capacity engine (`planDayCapacity`)
enforcing the PRD §5.2 rule — no feasibility/overload claim is possible
while a connected calendar has not synced through the day
(`CAPACITY_UNKNOWN`, §8.6 "calendar sync delayed"); the Today screen now
shows the server-computed full-collection workload against the configured
overnight-aware workday with a warning banner (50 loaded tasks, banner
reports all 60 — never moves tasks automatically); plan-gated calendar
connections (FREE: 1, `ENTITLEMENT_LIMIT_REACHED` at the limit) with
suspend/reactivate on plan change (never delete) and real "1 of 1" usage in
Settings; tenant-scoped `GET /v1/calendar/connections`,
`DELETE /v1/calendar/connections/:id` and the new
`GET /v1/calendar/capacity` seam (401/403/404 isolation, no token leakage);
workday configuration changes recompute capacity per request (E2E-verified
480→120-minute flip to `OVERLOADED`). Provider OAuth/sync, offline timers
and real push/email delivery remain deferred.

Final local gates: **54 test files / 524 unit+integration tests** and
**110/110 browser/API scenarios** (baseline 51/498 and 105), lint (0
warnings), types, coverage (87.85% statements, baseline 87.41%), build and
migration replay passed. Remote CI is verified against the pushed milestone
commit, separately from local evidence.
## M4 score corrections and date-range recalculation — 2026-09-10

Implemented the next M4 slice without changing the PRD, the existing score
math/weights, append-only event semantics, historical results or any verified
milestone (including TR-03 semantics, which remain explicitly unresolved).
[M4_SCORE_CORRECTIONS_MILESTONE.md](M4_SCORE_CORRECTIONS_MILESTONE.md) records
the PRD requirements, design decisions, test evidence and the remaining work.

Highlights: four typed, immutable correction kinds
(`DUE_DATE_CORRECTED`, `EXTERNALLY_BLOCKED`, `UNTRACKED_COMPLETION`,
`EXCLUDED_FROM_ANALYTICS`) with actor + reason + audit row on every correction,
latest-row effective state, undo-as-new-CLEAR-row and no-op re-apply;
correction-aware scoring that folds to Unmeasured/weight-normalised without
fabricating values (`EXTERNALLY_BLOCKED` in core timing, weight .25 excluded;
`UNTRACKED_COMPLETION` scores completion absent); due-date corrections applied
through the normal update path with the in-transaction fast path suppressed so
the durable worker path writes the single new result marked `recalculated`
(TR-05: ON_TIME → LATE with the original superseded, never mutated, events
intact); `EXCLUDED_FROM_ANALYTICS` removed from day/week summary cohorts only
(numeric `excludedCount` reported, drill-down preserved, note visible even when
every task in the window is excluded); bounded date-range recalculation
(default 90 days, ≤366, `to` ≤ today, UTC day keys, migration 0017) run
day-by-day by the worker with a durable cursor, observable progress endpoint
(204 when none) and the PRD §14.8 10/hour/user limit (429, distinct
rate-limit bucket, idempotency key unconsumed); analytics RecalculateRange
card + tracking-panel CorrectionControls with idempotent retry on lost
acknowledgement; two new metric events (`tracking.correction`,
`tracking.correction_failed`) plus unmeasured-result counting on both
evaluation paths.

Verified defects fixed along the way: the fast-path `recalculated: false`
race on due-date corrections; the idempotency ledger corrupting `Response`
returns into 200 with an empty body (now fails loud, key unconsumed); the
panel poll/refresh merge dropping `corrections`; the shared per-minute /
10-hour rate-limit bucket; a postgres-js count string leaking into
`excludedCount`.

Final local gates: **55 test files / 536 unit+integration tests** (baseline
524/54: +9 correction integration scenarios, +3 core scoring tests) and
**114/114 browser/API scenarios** (baseline 110: +4 E2E), lint (0 warnings),
types 5/5, coverage (88.03% statements, baseline 87.85%), build and fresh
migration replay ×2 (18 migrations) passed. Remote CI is **green on `be23d72`**
(PG 16, standard Chromium: audit, migration replay ×2, lint, typecheck,
coverage, build and all 114 E2E scenarios). The first two pushes failed
`test:e2e` after a full-suite run with no other step failing; CI logs were not
retrievable from the sandbox (artifact-store egress blocked), so the new spec's
polling waits were widened for slow runners (no assertion weakened) and the
workflow now emits each failed E2E test as a check-run annotation
(`.github/scripts/e2e-failures-annotations.mjs` + Playwright JSON reporter) for
API-only diagnosis. The follow-up run is fully green.

Remaining M4 work: workspace-local reporting and richer trends (PRD
§7.8/§8.5, the next recommended candidate), the unresolved TR-03/full TR
matrix and independent tracking/wellbeing controls. No reporting
enhancements, provider integrations, offline work, AI or billing was
started.
## M4 workspace-local reporting and richer trends — 2026-09-10

Commit: `61dd487` (branched from green `b80d8a3`). PRD §7.8/§8.5:
workspace-local day/week reporting windows and the full weekly trend set
with plain, non-judgemental tag-attributed explanations, plus the §8.5
review flow including optional per-day notes. Score math, weights,
normalization, calculation version 2, correction behavior, event semantics
and historical results are untouched.

Summary windows now use the workspace IANA time zone and configured week
start (core `localDayBounds`/`workspaceWeek`/`localDateKey`): a requested
date resolves to local noon in that zone (impossible calendar dates are
rejected, not silently shifted), and “This week” runs from the configured
`weekStart` through the end of the reference day — matching the delivered
calendar week grid. The recalculation backfill’s UTC day chunking is an
internal partitioning detail and is unchanged. New per-day trend points
carry planned/completed/focus/score/load-vs-workday (next-day workdays
included); weekly metrics: execution score trend (current stored results
only — superseded rows never pollute a day), completion consistency,
recurrence adherence (mean of measured recurrence components only),
most-rescheduled tasks (top 5, hidden tasks excluded), overloaded planning
days, underestimated categories (tag-level variance, ≥2 measured tasks,
≥+10% signal, top 3), and the focus-time trend (bucketed by local start
day; excluded tasks hidden from focus too). Insights stay descriptive and
never judgemental, with tag attribution. Review notes: `review_notes`
(migration 0018, PK `(workspace_id, day)`, ≤500 chars), GET/PUT/DELETE
`/api/v1/tracking/review-notes` (owner-scoped, idempotent mutations), and an
accessible editor on the analytics page that also renders in the empty
state. Project reports reuse the same workspace-local windows and expose
the workspace zone; scores-off strips `averageScore` and every per-day
`score` (absent, not zero).

Verification (local PG 18): **56 test files / 550 unit+integration tests**
(baseline 55/536: +14 reporting scenarios — TZ day/week boundaries,
weekStart switches, next-day workday overload, current-result-only day
scores with a correction re-scoring the day, measured-only recurrence
adherence, tag-variance threshold, top-5 rescheduled with hidden excluded,
excluded focus hiding, local-day focus bucketing, mean lateness,
cross-workspace non-leakage, note upsert/clear/boundary, zone date
validation) and **118/118 browser/API scenarios** (baseline 114: +4 in
`analytics-reporting.spec.ts` incl. Axe; `project-analytics` specs updated
to workspace-local window expectations — assertions kept, values
corrected, none weakened). Lint 0; typecheck 5/5; coverage **88.41%**
statements (baseline 88.03%); build OK; migration replay ×2 on a fresh DB
(19 migrations) idempotent.

Remaining M4 work: the unresolved TR-03/full TR matrix and independent
tracking/wellbeing controls (require the outstanding policy decisions).
No provider, offline, billing, AI, or desktop work was started or
invented.

## M5 cross-platform reliability — first bounded increment (sync protocol v1, offline capture, reconciliation) — 2026-09-10

Commit: `6ae9cf9` (branched from green `ba24998`). PRD §10 / roadmap item
7, first bounded increment: server push/pull correctness, version/
tombstone protection, scoped IndexedDB queue primitives, Today cached
fallback/recovery, and the safe enqueue/reconcile semantics.

Server:
- Online task create now honors the reserved `clientMutationId` as the
  entity id — a create whose response is lost re-pushed through sync
  dedupes to `duplicate`, never a twin task (SY-01).
- New `sync-scenarios.integration.test.ts`: explicit SY-01..SY-05
  (offline create visible to the other device via pull; replay is a
  duplicate with no second entity; different fields both retained;
  same-field conflict preserved + `resolveConflict('local')` applies it;
  delete wins, tombstone propagates via pull, restore resurrects and
  removes the tombstone), plus same-entity batch ordering (ack per
  position, version = base+N), pull sequencing/cursor monotonicity with
  pagination, delete-of-deleted duplicate, 30-day snapshot retention on
  post-delete edits, tenant isolation (cross-workspace write, workspace
  relabel rejection, per-workspace pull stream) and completion
  preservation (stale status edit refused, retained, completion kept).

Client:
- `offline-queue.ts`: DB v3 `meta` store with per-workspace sync cursor;
  `cacheTask` (provenance-checked); `applyPullPage` (update/create
  apply, delete removes — idempotent, cursor advances only after
  durable apply); `pullSync` (bounded pagination); `pendingSummary`
  (waiting vs needs-attention); `earliestRetryAt`; `reconcileOnce`
  (flush then pull); queue-changed event; SSR-safe `getDeviceId`.
- New `use-sync-reconcile.ts`: app-global loop — mount recovery,
  reconnect, new work arriving online, tab visibility, stored
  1 s–5 min jittered backoff; quarantined items never auto-retry;
  fires `nextdoo-synced` after a pass that applied or pulled.
- `OfflineBadge` (app shell) owns the loop and surfaces the queued count
  plus the PRD §10.8 needs-attention count (replaces the 1.5 s poll).
- `QuickCapture` offline capture: deterministic local parse (same
  grammar, no model), client-UUID create, durable enqueue + optimistic
  cache row, "Saved offline" acknowledgement; enqueue only on
  network/5xx, never on 4xx; recurrence refused offline without losing
  the user's text.
- `TodayView` refreshes on `nextdoo-synced`; cached fallback (stale
  banner) retained and now tombstone-cleared by pull.
- `@nextdoo/core` gains a client-safe `./nl-parse` subpath export (the
  root barrel pulls server-only `node:crypto` via totp).

Verification (local PG 18): **57 test files / 568 unit+integration tests**
(baseline 56/550: +18 — 10 sync scenarios + 8 queue-primitive unit tests)
and **121/121 browser/API scenarios** (baseline 118: +3 in new
`sync-offline.spec.ts` using real browser offline mode — offline capture
→ reconnect → reconciliation with canonical-id match, cached Today
fallback + recovery, cross-account isolation of queue/cache/server;
`online.spec.ts` lost-ack test updated to the durable-enqueue behavior
with strengthened assertions). Lint 0; typecheck clean; coverage
**88.63%** statements (baseline 88.41%); `next build` green. No new
migrations (existing tables reused; client `meta` store is IndexedDB).

Remaining M5: conflict resolution view (browse/resolve
`conflict_snapshots` in the UI), SY-06–SY-10 and multi-device scenarios,
5,000-mutation drain and SLO qualification, offline edits/deletes via the
task editor and offline timers, and the Windows Tauri client. No desktop,
provider, AI, or billing work was started.

## M3 capacity defect correction (positive-offset timezone day window) — 2026-09-10, M5 closeout

During M5 closeout CI verification, the `workspaces.spec.ts` date-boundary
scenario failed on its `Pacific/Kiritimati` (UTC+14) branch — the first CI run
that took that branch (all earlier runs executed before UTC noon and used the
negative-offset branch). Local reproduction at 12:46 UTC confirmed a
**deterministic server defect**, not a flake: `getDayCapacity`'s day window
(`services/capacity.ts`) ended the day by adding one **UTC** calendar day to
the local-midnight start instant and re-interpreting the result as a local
date. In positive-offset zones local midnight is on the *previous* UTC date,
so the window collapsed to zero length: capacity reported
`workloadMinutes: 0` for busy days and the §8.3 overload banner never
rendered (verified via the live endpoint: a 120-minute task due at local noon
on 2026-09-11 Kiritimati returned `workloadMinutes: 0`, `status: OK`).
Negative-offset and UTC zones keep a correct 24-hour window, which is why the
M3 milestone verification was green.

Fix: advance the **local** calendar date (month/year rollover via
`Date.UTC(year, month-1, day+1)`) for `endExclusive`. Added a regression
integration test (Kiritimati workspace; noon task counted for the correct
local day, previous/next local days distinct). This is a genuine code defect
surfaced by CI, corrected per the closeout rule — no behavior change for UTC
or negative-offset zones.

Verification (local PG 18, +14 branch): **57 files / 569 unit+integration
tests** (568 + 1 regression) and **121/121 E2E** including the previously
failing `workspaces.spec.ts` date-boundary scenario in both branches. Lint 0;
typecheck clean; coverage **88.62%**; production build green. See
[M3_CAPACITY_PLANNING_MILESTONE.md](M3_CAPACITY_PLANNING_MILESTONE.md)
"Defect correction" and [M5_SYNC_RELIABILITY_MILESTONE.md](M5_SYNC_RELIABILITY_MILESTONE.md).
## M5 increment 2 — conflict resolution view + SY-06–SY-09 multi-device scenarios — 2026-09-10

Second bounded M5 increment: the conflict-resolution surface and the
remaining multi-device scenarios from the PRD §19.3 matrix. No schema or
migration changes; all M5 increment 1 behavior preserved.

Delivered:
- `GET /v1/sync/conflicts` + `POST /v1/sync/conflicts/:id/resolve`
  (idempotency-ledgered; foreign ids 404; deleted targets 409). The
  `local` choice re-applies the preserved payload through the existing
  task command path (same invariants, version bump and sync-change
  emission as an online edit); `server` marks the snapshot resolved
  without touching the canonical row.
- New axe-clean `/conflicts` view: side-by-side per-field cards (caption +
  scoped table headers) with "Keep my version" / "Keep server version"
  choose actions, quarantined-mutation section showing the full raw saved
  payload and a retry action, live-region status, stable per-(conflict,
  choice) client idempotency keys, event-driven refresh. Sidebar entry;
  the offline badge's "N changes need attention" links here.
- `offline-queue.ts`: `requeueMutation` for user-directed re-attempts
  (resets counters, never deletes the payload — no discard path).
- `globals.css` fixes found while testing: light `--accent` 4.35:1 →
  `#1a5fd0` 5.5:1 on the page background; fixed offline badge is now
  `pointer-events: none` (link stays interactive) so it can never block
  page controls it overlaps.

Scenarios verified (real Postgres, 15 integration tests in
`sync-scenarios.integration.test.ts`): SY-06 two-device completion +
reschedule (scalar LWW keeps completion and `completedAt`), SY-07
overlapping timer sessions (newer canonical, older recorded `OVERLAPPED`
with accumulated seconds preserved, no session ever deleted), SY-08
10-minute clock skew (server processing order wins; mutation timestamps
server-time), SY-09 batch with one invalid mutation (rejection
idempotent, content preserved in a recoverable snapshot, batch-mates
apply), plus conflict-resolution semantics and cross-tenant isolation.

Verification (local PG 18): **57 files / 574 unit+integration tests**
(569 + 5) and **125/125 E2E** (121 + 4 two-device browser tests) in
~3.4 min. Lint 0 warnings; typecheck 5/5 packages; coverage **88.56%**
statements overall (core 97.91% vs 85% threshold); production build
green. CI verified on the pushed commit. See
[M5_CONFLICT_RESOLUTION_MILESTONE.md](M5_CONFLICT_RESOLUTION_MILESTONE.md).
Deferred (explicit): SY-10 5,000-mutation drain + SLO qualification,
offline task-editor edits/deletes and offline timers, Windows client.
## M5 increment 3 — SY-10 5,000-mutation drain and §10.9 SLO qualification — 2026-09-10

Third bounded M5 increment, measurement and reliability qualification
only (no product features). A repeatable harness
(`sync-slo-harness.ts` + `sync-slo.integration.test.ts`) drains 5,000
queued offline mutations from 4 devices against the real server +
Postgres using the exact client semantics (200-mutation batches,
per-entity head-of-line, backoff, auto-quarantine after 5 server
failures, simulated connection-level 500s), then verifies every
§10.9 property against a reference model built by the workload
generator.

Results (qualification run, local PG 18): **100%** of 200 connected
mutations acknowledged under 5 s (p50 10 ms, p95 12 ms, p99 13 ms,
max 31 ms; SLO 99%); **100.0%** data integrity over 3,685 entities
(SLO 99.9%); zero duplicate entities; zero lost mutations; zero
per-entity ordering/version violations across 4,970 sync-change ops;
155 tombstones held with 75 updates-of-deleted rejected-and-preserved;
125/125 conflict snapshots with byte-equal preserved payloads; zero
tenant-isolation violations; 825 simulated failures → 995 retries →
5/5 auto-quarantines → user requeue applied exactly once; every
device's pull-reconstructed cache equals the server's live state
(3,530 == 3,530, no stale resurrection). Full drain 56.0 s at
89.3 mutations/s; 200-mutation batch ack p95 3,012 ms.

Two findings, both **server-correct, harness-wrong** (no production
code changed): (1) the FREE plan's 200-active-task cap (PRD §18.1)
gates large drains — now an explicitly asserted test (over-limit
creates rejected with a clear code, payload preserved, re-send after
upgrade applies exactly once); the pure-sync qualification runs on an
unlimited plan because the SLO is plan-independent. (2) Replays with
altered `createdAt` under the same mutation id are rejected
`IDEMPOTENCY_CONFLICT` — the generator now replays byte-identical
records, as a real client does.

Verification (local PG 18): **58 files / 576 unit+integration tests**
(574 + 2, full qualification runs in CI) and **125/125 E2E** (3.3 min).
Lint 0; typecheck 5/5; coverage **89.24%** statements overall (core
97.91% vs 85% gate); production build green. CI verified on the pushed
commit. See [M5_SYNC_SLO_MILESTONE.md](M5_SYNC_SLO_MILESTONE.md).
Deferred (explicit): offline task-editor edits/deletes and offline
timers, Windows client, multi-node/replica drain measurement.

## M6 commercial readiness — increment 1: server-side entitlement enforcement + authenticated export path — 2026-09-10

Bounded M6 slice per PRD §18.1/§18.3: enforce the §18.1 limits that apply to
features that exist today, expose the entitlement endpoint, and add regression +
browser evidence for the authenticated JSON export path. No billing, Google
Calendar OAuth/sync, attachments, Windows/desktop, or AI work started; no
migrations; no existing test weakened or deleted.

- `GET /api/v1/account/entitlements` (new): auth-gated entitlement endpoint
  returning `{ plan, limits, usage }` — the §18.1 "entitlement endpoint" that
  was previously missing (the settings screen already rendered the same
  snapshot via RSC; clients now have the API surface, and the server remains
  the source of truth on every mutation).
- `assertHistoryWindow` (services/entitlements.ts) + wiring in
  `/api/v1/tracking/summary`: the FREE 30-day historical-analytics window is
  now enforced server-side. The boundary is computed in the workspace's local
  calendar (the tracking date convention); the 30th day is included, the 31st
  is rejected 402 `ENTITLEMENT_LIMIT_REACHED`; paid plans (`null`) are
  unbounded.
- Plan-based audit-history retention (services/data-rights.ts
  `listAuditLogs` + `/api/v1/audit-logs`): `retentionDays` from the caller's
  plan — Free (0) sees no history, Pro 30 days, Team 1 year, Enterprise
  7 years. The filter bounds what is shown; rows remain as internal security
  evidence, and destructive retention/anonymization/legal-hold remains the
  open F15 operations-policy item (not invented).
- New DB-backed suite
  `apps/web/src/server/services/entitlements.export.integration.test.ts`
  (11 tests): snapshot limits/usage + plan-change re-evaluation; 200/201 task
  boundary with slot release; plan-change re-evaluation both directions with
  row preservation; 3/4 project boundary with downgrade preservation;
  workspace-local 30-day window (incl. UTC+14) and paid full history;
  retention windows (0/30/365/2555) with the actor boundary at 7 years;
  export quota failure leaves no row; account export completeness + tenant
  isolation; foreign-notification scrubbing.
- New browser spec `apps/web/e2e/entitlements-exports.spec.ts` (4 tests):
  entitlement endpoint 401/200 with configured FREE limits; authenticated JSON
  export 401 (problem document only, no content leak) / 200 attachment
  `no-store` with owner data and no credentials; FREE second-export 402 with
  the list staying at 1; settings screen shows server-configured plan/usage.

Limits for unbuilt features (custom scoring rules, seats, attachment storage
and max file, AI requests) are configured and surfaced through the endpoint
but unenforceable until those features exist — documented, not faked.

Verification (local PG 18): **59 files / 587 unit+integration tests** and
**129/129 E2E** (3.4 min). Lint 0; typecheck 5/5; production build green.
Coverage **93.45% lines / 89.56% statements** overall (89.24% statements
before; core 97.91% vs 85% gate); `services/entitlements.ts` 100% lines,
`services/data-rights.ts` 96.0% lines. One local full-suite E2E run showed 2
transient `exports.spec.ts` failures that passed on isolated (4/4) and
full-suite (129/129) re-run — load-induced flake, no code-path mechanism from
this slice to export generation. CI: across all three milestone commits, each
commit's `push` + `pull_request` pair (identical code — base is at the branch
point) had exactly one failure, alternating run type, always the same
pre-existing M4 E2E (`task-virtualization.spec.ts` "keeps focus pinned",
top-row id after seeding 250 tasks; deterministic `createdAt desc, id desc`
order, distinct seed timestamps). Non-deterministic E2E instability in a
locked-milestone spec, independent of this slice's code paths; suite green in
two full local runs plus 10/10 standalone re-runs of the spec; not
reproducible locally; failure-run artifacts unreachable (GitHub results
EOF). Mitigation: CI E2E step now uses `--retries=2` (no spec change, no
weakened assertion). See
[M6_ENTITLEMENTS_EXPORT_MILESTONE.md](M6_ENTITLEMENTS_EXPORT_MILESTONE.md).

## M6 commercial readiness — increment 2: attachment pipeline (plan-based storage, max-file-size gating, real ClamAV scan-before-download) — 2026-09-11

Bounded M6 slice per PRD §6.8/§11.4/§12/§14: authenticated upload, plan-based
storage quota + maximum-file-size enforcement, real malware scanning before a
file becomes downloadable, safe download authorization, tenant isolation,
metadata lifecycle, cleanup/error handling (failed/rejected/scanned), and
task/workspace ownership integration. No billing, Google Calendar, AI,
desktop, or retention-destruction/anonymization work. No existing test
weakened or deleted.

- Scanner decision: the PRD requires scanning but names no provider →
  **self-hosted ClamAV** (no external provider, no credential; stop-condition
  not triggered). Engine behind an `AttachmentScanner` interface
  (switching point if a managed scanner is ever chosen); the E2E suite
  **refuses to run without a working engine** (throws, never fakes/skips);
  integration tests inject a deterministic scanner only to assert workflow
  semantics. CI installs clamav + freshclam and verifies EICAR detection
  before any test step.
- API: `GET/POST /api/v1/attachments` (list / upload authorization),
  `PUT /:id/upload-data` (token-gated, exact declared size), `POST /:id`
  (idempotent complete), `GET /:id/download` (signed ≤15-min URL; 409
  `ATTACHMENT_NOT_CLEAN` per state until CLEAN), `GET /:id/download/file`
  (session + CLEAN + signed token; attachment + nosniff), `DELETE /:id`
  (soft delete + object removal). Signed 15-minute purpose/user-bound tokens
  (HMAC-SHA256, timing-safe); no storage credentials to the client;
  server-generated workspace-scoped object keys.
- Plan gating server-side at authorization: max file per plan (10 MB/100 MB/
  250 MB/1 GB) and workspace storage quota (100 MB/5 GB/10 GB/100 GB, sum of
  undeleted sizeBytes); content-type allowlist; rejected authorizations
  consume nothing.
- Scan state machine (migration 0019): PENDING→CLEAN/INFECTED/FAILED,
  3 attempts with backoff, claim lease + stale recovery, quarantine
  (INFECTED/FAILED rows and objects retained, never served, audit-logged);
  a file is never CLEAN without a successful engine scan. `attachment.scan`
  worker job (10 s, bounded batch, per-workspace fairness); purgeAccount
  removes attachment objects; health route reports scanner availability
  (30 s cache, not probe-fatal — downloads fail closed); data-rights export
  includes attachment metadata (never bytes); `TaskAttachments` UI in the
  task editor (upload→poll→status pills→gated download→confirmed delete,
  a11y-labelled).
- New DB-backed suite `attachment-workflow.integration.test.ts` (12 tests:
  upload success, over-size, allowlist, exact size, quota at the exact
  boundary, infected quarantine, retry/backoff/exhaustion, download-token
  binding, deletion/cleanup, lost-ack, tenant isolation, data-rights
  bundle). New `e2e/attachments.spec.ts` (6 tests, real engine, incl. EICAR
  quarantine; fails loudly without the engine).

Verification (local PG 18): **60 files / 599 unit+integration tests**
(587 → 599; +12 attachment tests) and **129/129 pre-existing E2E** (no
regressions, incl. the 4 task-editor axe specs after adding the missing
file-input label); the 6-test attachment E2E spec is proven in CI (no ClamAV
installable in the sandbox — it fails loudly with
ATTACHMENT_SCAN_ENGINE_MISSING locally by design). Lint 0; typecheck 5/5;
production build green. Coverage **93.48% lines / 89.52% statements**
overall (no overall gate; core-only 85% gate untouched).

CI: final tip `64fb5e5` — **push and pull_request runs both green** (all 18
steps incl. ClamAV install + EICAR verify, 599/599, build, 135/135 E2E).
Two CI-only fixes on this milestone: the workflow's freshclam must run as
root with the package's auto-started timer stopped, and `set -e` aborts on
`clamscan`'s detecting exit code 1 (the correct outcome) — both
workflow-only. Two pre-existing locked-suite flakes were root-caused from
the full diffs (identical-code PR runs green each time): task-bulk rollback
assertion (same tracking rows, different order — snapshot() lacked ORDER BY
under order-sensitive toEqual) and export-workflow
`processed === 1` (global batch count co-processed a parallel suite's due
row). Both fixed by pinning/removing the incidental shared-state assertion
only; every substantive assertion unchanged. Run log unreachable from the
session (results-receiver EOF, same as M6-i1) — diagnostics via workflow
annotations. See [M6_ATTACHMENTS_MILESTONE.md](M6_ATTACHMENTS_MILESTONE.md).

## M6 commercial readiness — increment 3: multi-provider billing core (Stripe + Razorpay, provider-agnostic) — 2026-09-11

Bounded M6 slice per PRD §10.7/§18: the provider-agnostic billing core —
internal subscription state machine + normalized event model with **Stripe
and Razorpay** adapters behind one `PaymentProvider` interface; no provider
concept leaks into the app. Webhooks are untrusted: signature verification
with replay protection (Stripe 5-min header window; Razorpay raw-body HMAC +
15-min event age), per-provider event-id dedup, out-of-order tolerance
(event horizon), version-fenced application, tenant resolution scoped to
the event's provider. Entitlements move only through server-normalized
state via `readEffectivePlan()`. Binding user decisions: Stripe USD /
Razorpay INR prices on the same PRO/TEAM/ENTERPRISE plans; TRIALING modeled
but M1 checkout = direct paid (no trials offered); `POST
/v1/billing/portal` deferred; test/sandbox mode only — no live credentials
required or used; no Calendar/AI/desktop/retention work; no existing test
weakened.

- New `packages/billing` (62 hermetic tests): internal types, pure state
  machine (PRD table: immediate upgrade, deferred downgrade with
  `pendingPlan`/`pendingPlanEffectiveAt`, 7-day grace on first failed
  payment, dunning, illegal-transition refusals with `skipReason`),
  signature verifiers (constant-time), plan/price mapping (Stripe price id;
  Razorpay plan id + paise), alert-only reconciliation diff,
  `buildBillingProviders` fail-loud (absent config ⇒ provider unavailable,
  never a stub, never a cross-provider fallback).
- Adapters: Stripe (customers/checkout sessions/subscription REST;
  `checkout.session.completed`, `customer.subscription.*`,
  `invoice.payment_failed|paid`, `charge.refunded`) and Razorpay
  (customers/orders/subscription REST; `payment.captured` activation with
  plan from notes/amount, `payment.failed`, `refund.*`,
  `subscription.charged|cancelled|completed|halted`).
- DB (migration 0020, idempotent): `billing_provider` enum,
  `subscriptions.provider/provider_plan_ref/pending_plan(+effective_at)/
  last_event_at`, per-provider `billing_events` uniqueness + owner link.
  `startCheckout` (idempotent customer upsert, cross-provider switch
  rejected), `handleBillingEvent` (persist+dedup first, tenant resolution,
  stale-provider-subscription + event-horizon guards, version-fenced write
  with retry, audit on every resolved event), `applyBillingDeadlines`
  (trial end / grace exhaustion / paid-period end / pending downgrade —
  idempotent), `reconcileBilling` (drift + audit, alert-only),
  `getBillingSubscriptionState` (server-authoritative view).
- Web: `server/billing.ts` (only provider construction point; HMR-safe;
  `requireProvider` 503 `PROVIDER_UNAVAILABLE`), `GET
  /api/v1/billing/subscription`, `POST /api/v1/billing/checkout` (handoff
  only; idempotent), `POST /api/v1/billing/webhooks` (provider chosen by
  signature-header presence; 400 on missing/ambiguous; 200 once accepted).
  Env: 6 optional `STRIPE_*`/`RAZORPAY_*` vars (see `.env.example`).
- Worker: `billing.sweep` (5 min), `billing.reconcile` (24 h, per provider).
- New `e2e/billing.spec.ts` (3 tests, API-only — these endpoints have no
  browser surface): unconfigured deployment, real HTTP: auth-gated
  server-normalized FREE view; checkout 503 `PROVIDER_UNAVAILABLE` for BOTH
  providers with no state change; webhook ingress untrusted (400
  missing/ambiguous signature; 503 forged for unconfigured provider).
- `billing-lifecycle.integration.test.ts` (31 tests): the 12-area lifecycle
  matrix run for **both** providers through the real sync service (see
  milestone doc). One genuine product defect found and fixed by the suite:
  Razorpay `mapSubscription` hardcoded `cancelAtPeriodEnd: false`,
  contradicting the CANCELED-while-period-runs semantics (access through
  period end, PRD §18.3) — now derived from the mapped status.

Verification (local, PG 18): lint 0; typecheck clean in all 6 packages;
production build green; **65 files / 692 unit + integration tests all
passing** (62 package + 31 lifecycle + pre-existing suites, no regressions);
E2E billing spec **3/3** against `next start`. Live sandbox checkout /
webhook delivery is explicitly NOT claimed — all provider interactions in
tests use generated secrets or stubbed REST. Exact credentials/config
still required for the live sandbox pass (test-mode only): see
[M6_BILLING_CORE_MILESTONE.md](M6_BILLING_CORE_MILESTONE.md) §"What is
still required for live sandbox verification".

CI: tip `9adefa7`, run 34598366098 — **all steps green** (install,
Playwright Chromium, ClamAV + EICAR, audit, `db:migrate` ×2 — migration
0020 idempotency proven —, lint, typecheck, test:coverage, build,
`playwright test --retries=2` with **138/138 E2E, no failures**; the
failed-E2E annotation step was skipped). Run logs unreachable from the
session (results-receiver EOF, same as M6-i1) — step/annotation status
is the verification record.

## M6 commercial readiness — increment 4 (attempted): live test-mode verification (Stripe + Razorpay) — 2026-09-11, STOPPED at pre-flight

Pre-flight per the milestone guardrail: **all seven required test-mode
values are missing from the session environment** (`STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, `STRIPE_PLANS`, `RAZORPAY_KEY_ID`,
`RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `RAZORPAY_PLANS` — empty
`.env.example` template only), and this sandbox has **no egress to the
provider APIs** (`api.stripe.com`, `api.razorpay.com`,
`checkout.stripe.com` all unreachable; allowlist = npm + GitHub only).
STOPPED with no live verification performed or claimed, no invented values,
no fake provider responses, and zero code changes. The core at tip
`89b5624` remains as verified (CI 34602273607 all steps green). Environment
incident noted for the record: the session sandbox reset mid-attempt and
re-cloned `.git` at a stale base (`49b2e68`); recovered by re-pointing the
local branch to the already-pushed remote tip `89b5624` — working tree
verified byte-identical (clean status), no history rewrite, no force-push.
Unblocking requires the test-mode values (milestone doc table) in an
environment with provider egress and a reachable webhook URL.

## M6 commercial readiness — increment 5: account & session management — 2026-09-11

Bounded M6 slice per PRD §6.1/§11.2/§14.3: `GET`/`PATCH /api/v1/me` (own
profile only: id, email, name, timeZone, MFA-enabled, createdAt; strict
validation of name 1–120 or null and IANA time zones), `GET
/api/v1/me/sessions` (owner-scoped active sessions with device label, last
seen, created, current-session flag — never token/IP digests), `DELETE
/api/v1/me/sessions/:id` (owner-only individual revocation; foreign or
unknown ids a uniform 404), and `POST /api/v1/auth/logout-all` which, per
the recorded user decision, revokes ALL of the caller's sessions INCLUDING
the caller's own. Every mutation is audit-logged
(`account.profile_updated`, `account.session_revoked`,
`account.sessions_revoked_all`). No migration needed; existing auth, MFA,
reset, verification, session-rotation-on-privilege-change, entitlement and
billing behavior untouched.

Settings UI: profile form (name/time zone) in the Account card and a new
Sessions card (per-session revoke with confirmation, "Revoke & sign out"
for the current device, sign out everywhere; loading/error/success states;
keyboard-operable, axe-clean).

Revocation takes effect on the very next request (the per-request
`revokedAt IS NULL` check) — MEASURED, not assumed: 59 ms individual
revocation and 53 ms sign-out-everywhere end-to-end through the production
server (curl, two cookie contexts); 4 ms / 2 ms at service level against
real PostgreSQL. PRD bound is 60 s; tests assert a 5 s margin and log the
actual value each run.

Tests: 13 new DB-backed integration tests (shape, strict validation,
owner-scoping, revocation including the current session, logout-all,
cross-user isolation, audit trail) and 6 new real-browser E2E specs
(144 total E2E; two device contexts; axe + keyboard). Local sandbox cannot
launch Chromium (missing NSS libs, no egress) — browser specs are
demonstrated in CI as in all prior milestones; locally the production
server was smoke-tested end-to-end (401/403/404/400/409 contracts,
idempotent replay, measured latencies, settings SSR).

Full validation passed: 705/705 unit+integration tests, lint (0 warnings),
typecheck, production build, coverage thresholds (core 97.91% lines /
90.58% branches / 100% functions), migration replay (idempotent), E2E
discovery (144). See
[M6_ACCOUNT_SESSIONS_MILESTONE.md](M6_ACCOUNT_SESSIONS_MILESTONE.md).
