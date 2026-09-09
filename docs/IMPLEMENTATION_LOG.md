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
