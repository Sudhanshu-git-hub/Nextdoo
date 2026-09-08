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

Pending. Add failing regressions before changing affected behavior; tenant isolation
is a release blocker. Do not interpret Phase 1's green baseline as security acceptance.

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
