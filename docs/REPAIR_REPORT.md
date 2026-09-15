# Quality gates and prioritized integrity repairs

**Date:** 2026-09-08  
**Branch:** `arena/01a080d5-nextdoo`  
**Recovered baseline:** `49b2e6869bc16be59a56f27e45b8ba9df373a7c7`

## Status and scope

The quality-gate milestone and the **seven prioritized security/data-integrity repair groups** have been implemented and verified. Work preserved the recovered implementation and architecture. No AI, billing-provider, desktop, Google Calendar or other subsequent product milestone was started.

**This is not closure of every finding in the accepted baseline audit, and is not production security approval.** Authentication hardening and other unresolved findings are listed explicitly below. The browser cache disclosure was repaired, but the unused offline mutation queue is not a completed or qualified offline system.

## Verification: before and after

| Gate | Recovered baseline | Final result |
|---|---|---|
| Lint | No-op script | Real ESLint correctness checks; zero warnings |
| Type checking | Passed | Passed across all five packages |
| Unit/integration/tooling tests | 191 passing | **233 passing in 18 files** |
| Browser E2E | Not a functioning independent gate | **5 passing**, real Chromium and production Next server |
| Coverage | Missing working provider | V8 reporting; all four core thresholds enforced at 85% |
| Core coverage | Not trustworthy as a gate | 99.50% lines, 96.45% statements, 85.58% branches, 100% functions |
| Entire configured coverage set | No working report | 83.74% lines, 79.02% statements, 72.22% branches, 79.92% functions |
| Database-backed tests | Could silently skip | Fail without a migrated database |
| Production build | Passed | Passed after each repair group and in final verification |
| Migration generation | Failures could exit successfully | Tested manual SQL scaffold; invalid invocation exits nonzero |
| Full dependency audit | 51 findings: 4 critical, 17 high, 25 moderate, 5 low | **0 at every severity**, 359 audited dependencies |

The final full verification used a **fresh database**, `nextdoo_verify_20260908`. Migrations `0000` through `0006` applied successfully; a second migration run was a no-op. `pnpm verify` then passed lint → typecheck → coverage/tests → production build → E2E.

Local execution used PostgreSQL **18.4, UTF-8**, and real Chromium **149**. Standard Playwright browser download failed with `ECONNRESET`; a registry-distributed Chromium binary and native libraries were used through the supported executable-path override. Browser security was not disabled. CI is configured for PostgreSQL **16** and the standard Playwright browser, but **remote CI was not executed**.

### Five browser scenarios

1. Unauthenticated app access and task queries are denied.
2. Register → keyboard capture → complete → persisted analytics → settings.
3. Focus clock remains numeric through start/pause/resume/stop.
4. Switching accounts in the same browser cannot expose the previous workspace's task cache when the task API fails.
5. Unsupported recurring capture preserves its original text instead of silently creating a one-off task.

The cache scenario intentionally aborts the task request to exercise the failure path; account provisioning and authentication still use the real server/database. These tests do not establish provider integration or comprehensive endpoint contract coverage.

## Regression-first repairs

| Repair group | Before repair | Verified repair |
|---|---|---|
| Tenant isolation | 6 of 9 new regressions failed | Foreign sync task-ID collisions and mutation replay no longer disclose entities; project/section/tag references are authorized; inconsistent conflict snapshots cannot mutate foreign tasks. All 9 pass. |
| Atomic HTTP idempotency | 4 of 5 failed | Per-user/key transaction lock; canonical request identity includes method/path/query/body; domain writes and response ledger commit together; failures roll back; changed requests conflict. All 5 pass. |
| Commit-ordered sync cursor | Concurrent-transaction regression failed | Database trigger takes a transaction advisory lock before assigning the sequence, preventing a higher visible cursor from skipping a lower late commit. Regression passes. |
| Sync/domain parity | All 7 failed | Sync uses domain operations for task creation, lifecycle and conflict resolution; completion history/scoring/reminders are transactional; concurrent task caps and mutation identity are enforced; canceled paid subscriptions retain access through their paid period. All 7 pass. |
| Scoring/reopen/recurrence denominator | 4 of 5 failed | Inputs are read under lock; A → B → A preserves history and one active result; reopening/input changes reevaluate; due-time changes invalidate cached scoring inputs; skipped occurrences count in the denominator. All 5 pass. |
| Timer integrity | All 5 failed; browser displayed `NaN:NaN:NaN` | Starts/transitions serialize, newer canonical sessions survive older offline starts, timestamps cannot regress, terminal sessions cannot be credited twice, credited time versions/syncs/recalculates the task. Five regressions and browser scenario pass. |
| Account purge | Three-test suite failed, including real worker path | Shared purge rechecks eligibility under lock, removes private replay/outbox data, permits final account-history cascade and retains audit evidence. Live tracking history remains immutable. All 3 pass. |
| Adjacent lifecycle/data-loss checks | All 5 failed | Restore retention/task limits, reschedule intent/relative reminder dates, raw Date binding, paid-grace expiry and explicit rejection of unsupported recurrence creation. All 5 pass. |
| Browser cache isolation | Real two-account browser regression disclosed a private task | Cache reads/writes require workspace provenance; foreign and unscoped legacy rows are not rendered. Browser regression passes. |

There are **40 new integrity integration tests**, plus the two Phase 1 migration-tool tests: 191 → 233. No test assertions were removed or weakened to make the repairs pass. Initial fixture/import mistakes were corrected before treating the corresponding red runs as defect evidence.

### Important implementation details

- `AsyncLocalStorage` carries the active transaction into nested service operations; the idempotency wrapper does not record success outside the domain transaction.
- Legacy HTTP/sync ledger records lacking trustworthy request identity are conservatively rejected, rather than guessed or silently executed again.
- Task mutations serialize workspace state checks with writes. Timer mutations additionally serialize per user and acquire affected workspace locks before task writes.
- Scoring history remains stored. Migration `0004` replaces historical-input uniqueness with one-active-result uniqueness; returning to an old input appends a new historical row.
- Tracking event UPDATE/DELETE is still rejected for live accounts. Final account cascade is a narrow exception; direct live-account workspace deletion cannot masquerade as that cascade.
- Purge explicitly removes private outbox and idempotency response data, which lacked cascade foreign keys. Audit evidence is retained under its separate policy; a complete configurable retention system is not claimed.
- Recurrence generation was **not** implemented. Unsupported recurring creates now fail explicitly, and capture keeps the original text. This repairs silent data loss, not the missing scheduling feature.
- The alternate reminder-dispatch regression verifies timestamp binding with an empty claim; it does not certify delivery or repair the provider stubs.

## Commits

All implementation commits are on the fixed session branch. The recovered branch was not reset, rebased, amended, force-pushed or otherwise rewritten. No push or pull request was performed.

| Commit | Change |
|---|---|
| `4eff95e` | Establish real quality gates and remediate dependency advisories |
| `5f134aa` | Close sync tenant disclosures and authorize task references |
| `f502cbd` | Make HTTP idempotency atomic with domain mutations |
| `75f3d86` | Allocate sync cursors in commit order for every database writer |
| `6c2fca9` | Route sync through atomic task invariants and enforce entitlements |
| `bd9b9a2` | Preserve scoring history and atomically refresh active results |
| `bec85a8` | Serialize timer transitions and publish accurate credited time |
| `759dced` | Purge expired accounts without weakening live tracking history |
| `7cc6e0d` | Isolate cached task fallback across browser accounts |
| `8b141a4` | Enforce lifecycle retention and prevent silent recurrence data loss |

A final documentation commit records this report and the stop point.

## Dependency remediation

Compatible direct/transitive upgrades include Next **15.5.25**, React **19.0.8**, Vitest/coverage **4.1.11**, Playwright **1.63.0**, Drizzle ORM **0.45.2**, tsx **4.23.13**, Turbo **2.10.12**, uuid **14.0.2**, Vite **8.2.2**, Sharp **0.35.4** and PostCSS **8.5.28**. Obsolete Drizzle Kit was removed in favor of a tested manual SQL scaffolder consistent with the repository's existing forward SQL migrations.

The final full audit reports **zero critical, high, moderate, low or informational findings**. This is a dependency-advisory result, not a claim that all application vulnerabilities are eliminated.

## Remaining failures, risks and PRD gaps

### Final gate failures

**None in the final local verification.** Expected pre-repair regression failures are documented above. The unauthenticated E2E emits an expected server-side `UNAUTHENTICATED` log while the redirect and API-denial assertions pass.

### Still-open audit findings — do not treat as approved for production

- **Authentication/security hardening (audit F14):** password-reset TTL/atomicity, MFA session rotation, account/IP rate limiting, origin/CSRF controls, wildcard Server Actions origins, security headers and production token-link logging remain separate unresolved work. This report does not claim these fixed.
- **Offline queue (remaining F07):** core capture/edit still does not enqueue offline work. Queue isolation, retry/quarantine behavior and rejected-content retention are not qualified. Repairing the displayed cache boundary does not make the unused queue safe to activate.
- **Provider delivery (remaining F08):** SMTP, reminder provider delivery and outbox publication remain stubs. Configuration does not establish delivery. No provider integration was fabricated or added.
- **Recurrence (remaining F12):** rule persistence, generation jobs, occurrence workflow and full capture-field preservation remain missing product work; unsupported creation is now explicit.
- **Reporting/data rights (remaining F15):** synchronous incomplete JSON export is not a signed, expiring CSV/JSON export job; comprehensive corrections/rollups, wellbeing controls and configurable audit/security retention are incomplete.
- Rich task/project/section/board workflows, desktop, Calendar, Stripe, attachments/storage/scanning, AI and later PRD features remain outside this repair pass.

### Deployment caveats

- **Global serialization:** the sync sequence trigger serializes sync writers through commit. This is a correctness-first tradeoff, not validated production throughput. Load/SLO qualification remains necessary.
- **Legacy timer data:** the old schema did not retain exact pause transition times on each timer. Migration `0005` backfills only the best known durable lower bound; it does not invent missing history or certify all pre-existing malformed timer data repaired.
- Apply forward migrations before starting repaired services. Legacy replay keys may return conflicts because their original request identity cannot be proven.
- PostgreSQL 16 remote CI, normal CDN-installed Chromium, production restore/PITR, provider behavior, accessibility and production load were not verified locally.
- The earlier audit remains the authoritative inventory of wider PRD gaps. This report closes the verified prioritized repair paths, **not the entire audit**.

## Evidence and reproduction

Evidence files are under `/home/user/nextdoo-implementation/` and are intentionally not committed as bulk artifacts:

- `phase1-verify.log`, `audit1.json`
- `isolation-red.log`, `isolation-green.log`, `isolation-verify.log`
- `idempotency-red.log`, `idempotency-green.log`, `idempotency-verify.log`
- `cursor-red.log`, `cursor-green.log`, `cursor-verify.log`
- `sync-domain-red.log`, `sync-domain-green.log`, `sync-domain-verify.log`
- `scoring-red.log`, `scoring-green.log`, `scoring-verify.log`
- `timers-red.log`, `timers-green.log`, `focus-red.log`, `timers-verify.log`
- `purge-red.log`, `purge-green.log`, `purge-verify.log`
- `cache-red.log`, `cache-verify.log`
- `lifecycle-red.log`, `lifecycle-green.log`, `recurrence-capture-red.log`, `lifecycle-verify.log`
- **`final-migrations.log`, `final-verify.log`, `final-audit.json`**
- `final-resume-verify.log`: full verification repeated successfully after the interrupted report-writing turn.

Use `docs/DEVELOPMENT.md` for setup. With a migrated disposable database, `AUTH_SECRET` and a Playwright browser available:

```sh
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm db:migrate
pnpm audit --audit-level high
pnpm verify
```

**Stop point:** no later product implementation is authorized or represented as complete by this report.

## Changed-file inventory

Paths changed since the recovered baseline (including removed/renamed configuration paths).
Most broad import/dead-code cleanup belongs to the ESLint quality-gate commit.

```text
.env.example
.github/workflows/quality.yml
README.md
apps/web/e2e/core.spec.ts
apps/web/next-env.d.ts
apps/web/package.json
apps/web/playwright.config.ts
apps/web/src/app/api/v1/projects/route.ts
apps/web/src/app/api/v1/tasks/[id]/archive/route.ts
apps/web/src/app/api/v1/tasks/[id]/complete/route.ts
apps/web/src/app/api/v1/tasks/[id]/reopen/route.ts
apps/web/src/app/api/v1/tasks/[id]/reschedule/route.ts
apps/web/src/app/api/v1/tasks/[id]/restore/route.ts
apps/web/src/app/api/v1/tasks/route.ts
apps/web/src/components/MfaSettings.tsx
apps/web/src/components/QuickCapture.tsx
apps/web/src/components/views/FocusView.tsx
apps/web/src/components/views/TodayView.tsx
apps/web/src/lib/offline-queue.ts
apps/web/src/server/db.ts
apps/web/src/server/http.ts
apps/web/src/server/idempotency.ts
apps/web/src/server/mailer.ts
apps/web/src/server/services/account-security.integration.test.ts
apps/web/src/server/services/accounts.ts
apps/web/src/server/services/cursor.integrity.integration.test.ts
apps/web/src/server/services/data-rights.ts
apps/web/src/server/services/entitlements.ts
apps/web/src/server/services/events.ts
apps/web/src/server/services/idempotency.integration.test.ts
apps/web/src/server/services/isolation.integration.test.ts
apps/web/src/server/services/lifecycle.integrity.integration.test.ts
apps/web/src/server/services/purge.integrity.integration.test.ts
apps/web/src/server/services/reminders.ts
apps/web/src/server/services/scoring.integrity.integration.test.ts
apps/web/src/server/services/sync-domain.integration.test.ts
apps/web/src/server/services/sync.integration.test.ts
apps/web/src/server/services/sync.ts
apps/web/src/server/services/task-references.ts
apps/web/src/server/services/tasks.integration.test.ts
apps/web/src/server/services/tasks.ts
apps/web/src/server/services/timers.integrity.integration.test.ts
apps/web/src/server/services/timers.ts
apps/web/src/server/services/tracking.ts
apps/web/src/server/services/transactions.ts
apps/worker/package.json
apps/worker/src/jobs.ts
docs/DEVELOPMENT.md
docs/IMPLEMENTATION_LOG.md
docs/REPAIR_REPORT.md
eslint.config.mjs
package.json
packages/contracts/package.json
packages/core/package.json
packages/db/drizzle.config.ts
packages/db/migrations/0002_commit_ordered_sync_cursor.sql
packages/db/migrations/0003_sync_request_identity.sql
packages/db/migrations/0004_active_tracking_history.sql
packages/db/migrations/0005_timer_transition_clock.sql
packages/db/migrations/0006_account_history_purge.sql
packages/db/package.json
packages/db/src/index.ts
packages/db/src/purge.ts
packages/db/src/schema.ts
pnpm-lock.yaml
scripts/dev-services.mjs
scripts/new-migration.mjs
scripts/new-migration.test.ts
tests/database.ts
turbo.json
vitest.config.mts
vitest.config.ts
```
