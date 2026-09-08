# Development and verification

The recovered implementation is not a release-complete MVP. `docs/PRD.md` on
main is the product authority. This guide describes actual behavior, not planned integrations.

## Toolchain and local services

- Node 22.22+ (CI: 22.22.3), pnpm **9.15.4**.
- PostgreSQL 16+; CI uses PostgreSQL 16, the embedded local distribution uses 18.4.
- Next.js 15 App Router hosts both the web UI and `/api/v1` route handlers.
- Shared contracts/core/DB packages expose TypeScript source. Worker runs with tsx.

```bash
corepack enable
pnpm install --frozen-lockfile

# Terminal 1: isolated UTF-8 test database; don't reuse valuable/production data.
PGPORT=55433 PGDATABASE=nextdoo_test PGDATA_DIR="$PWD/.data/test-postgres" pnpm dev:services

# Terminal 2: export explicitly; pnpm/tsx do not load .env files automatically.
export DATABASE_URL=postgres://postgres:postgres@localhost:55433/nextdoo_test
export AUTH_SECRET=test-only-secret-at-least-32-characters
export APP_URL=http://localhost:3000
pnpm db:migrate
pnpm db:migrate  # safe rerun
pnpm dev
```

For a separate development database, omit `PGPORT/PGDATABASE`: defaults are
55432/nextdoo. Existing initialized clusters are reused, never reinitialized.
Initialization failures now fail rather than being swallowed. Keep the service
process running until testing ends. Never run test fixtures against production.

## Quality gates

```bash
pnpm lint              # ESLint recommended JS/TS correctness + unused imports/variables, zero warnings
pnpm typecheck         # all five packages
pnpm test:unit         # pure core and tooling; no database required
pnpm test              # all tests; integration collection FAILS without a configured, migrated DB
pnpm test:coverage     # V8 text, HTML, JSON summary and LCOV in coverage/
pnpm build             # production web build; other packages currently execute TypeScript source
pnpm --filter @nextdoo/web exec playwright install --with-deps chromium
pnpm test:e2e          # production build + real database + real Chromium; owns server on port 3100
pnpm audit --audit-level high
pnpm verify            # lint → typecheck → coverage/tests → build → E2E
```

Core coverage thresholds: **85% statements, branches, functions and lines**,
including all non-test core files. Server-service coverage is also reported,
including untouched/uncovered files; it is not disguised as complete route coverage.

Playwright discovers only `apps/web/e2e/`, never Vitest's integration files. Tests
use unique accounts, one worker and no automatic retries. Account/data flows use the real server;
the cache-isolation case deliberately aborts task requests to exercise fallback.
A test failure cannot become a pass through retries. The suite starts its own
production server and refuses to reuse a developer's running server. CI rejects
focused tests, provisions PostgreSQL and uploads coverage/trace artifacts.

If browser CDN access is unavailable locally, `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`
can point to an already installed real Chromium. Do not disable browser security
or replace tests with mocked responses to claim E2E success. The fallback binary
is an environment dependency, not part of NEXTDOO or its lockfile.

## Migrations

**Hand-authored SQL is authoritative.** Never edit an applied migration.

```bash
pnpm db:generate meaningful_change_name
# Review/edit the newly numbered SQL file, then:
pnpm db:migrate
```

`db:generate` now explicitly scaffolds the next SQL migration; it **does not infer
schema differences**. It validates the name, uses exclusive file creation and
fails nonzero on invalid arguments or filesystem errors. The obsolete Drizzle Kit
command was removed: it emitted an ESM exception with exit 0 and could not safely
diff the hand-authored baseline. Drizzle remains the ORM. `drizzle.config.ts` is
retained as a schema-reference configuration, not an executable generator.
Keep `packages/db/src/schema.ts` and new SQL migrations aligned and test both
fresh installation and upgrade. Backups/restore and deployment rollback are still
separate, outstanding operational gates.

## Environment

Required for database-backed web flows: `DATABASE_URL`, `AUTH_SECRET` (32+ chars).
`APP_URL` controls absolute links. `.env.example` documents development settings.
Next can read `apps/web/.env.local`; the worker and tests require exported values.
Turbo explicitly passes the declared application configuration to package tasks.
Do not put production secrets in checked-in env files.

Optional names (`REDIS_URL`, `SMTP_URL`, `GOOGLE_*`, `STRIPE_*`, `S3_*`) are **not
proof of integrations**. Currently:

- Login account/IP backoff and export quotas are durable in PostgreSQL; other
  route throttles remain in-process. Redis is not wired.
- Worker scheduling uses intervals, but SMTP messages have durable PostgreSQL
  leases/retry/expiry. This is not a complete BullMQ/general event-consumer system.
- Configured SMTP queues encrypted auth email for a real worker transport. Without
  SMTP, development/test may log local links; production fails explicitly.
- WEB reminders atomically write an in-app notification. EMAIL/DESKTOP reminder
  channels fail honestly; unhandled outbox events remain unpublished. Neither
  external notification delivery nor inbox UI is established by these rows.
- Google Calendar, Stripe checkout/webhooks, S3 upload/scanning and AI providers
  are not implemented. Static plan limits are not a billing integration.

## Actual product coverage and limitations

Online account provisioning, basic task APIs, normal completion, a weekly task
calendar, focus UI and summary analytics exist. Pure domain and selected database
rules have tests. The 2026-09-08 recovered baseline had **191 tests**, not 188.
Use test output for the current count; new regressions are added incrementally.

Still incomplete: rich task/project/board flows, persisted recurrence generation,
real notifications, full analytics/corrections/wellbeing controls, offline capture
and reconciliation, conflict UX, attachments, async expiring exports, Windows
client, integrations and production operations. IndexedDB helpers exist but core
capture/edit does not yet enqueue offline work. JSON export is synchronous and is
not the PRD's signed, expiring CSV/JSON export job.

`pnpm dev:worker` runs the current worker; supply DATABASE_URL explicitly. Do not
run it against customer data until retention and dispatch behavior is qualified.
See `docs/IMPLEMENTATION_LOG.md` for approved security repairs, evidence and remaining scope.


## Repair verification (2026-09-08)

The accepted prior report is `REPAIR_REPORT.md`; the latest A–H inventory, results
and stop point are in `AUDIT_REMEDIATION_REPORT.md`. Fresh SQL migrations 0000–0009
plus replay, 278 tests and 11 E2E/API scenarios passed locally. Apply forward
migrations before starting services. The sync sequence trigger serializes writes
through commit; production throughput remains unmeasured. Legacy pause history and
previously discarded seconds cannot be fabricated. Unsupported recurrence capture preserves original input with an explicit error.
The later online workflow milestone now supports confirmed tags/existing projects
and task editing; see `ONLINE_WORKFLOW_PHASE.md` for its bounded acceptance.

These results do not establish production readiness. Remote PG16 CI, breached-
password checking, managed secrets/key rotation, load, accessibility, backup restore,
legal retention and staged provider delivery remain gates. The full offline client,
external event consumers and larger PRD features remain incomplete.

### Audit-remediation delivery configuration

Auth email now has a real SMTP worker adapter. Supply the same `AUTH_SECRET` to web
and worker (mail ciphertext uses a distinct HKDF purpose), `SMTP_URL` to both, and
`MAIL_FROM` to web. Apply all forward migrations before running either. Never put actual
credentials in source control or chat. Production SMTP requires TLS and normal
certificate validation; provision sender/domain authentication separately.

`mail.deliver` claims one message per tick, with durable leases, expiry, retry and
terminal failure. The queue payload is encrypted and scrubbed after delivery or
expiry. SMTP acknowledgement is not proof of inbox arrival; crash-after-ACK can
redeliver the same Message-ID. Provision a shutdown grace period longer than the
bounded SMTP connection/greeting/socket timeouts. Inspect `mail_deliveries` status,
`last_error`, due time and attempts for failures; do not print decrypted reset links.
Missing production SMTP fails explicitly; deletion/credential changes are not
rolled back just because their subsequent notification is unavailable.

WEB reminder SENT currently means a durable **in-app notification row**, not web
push. EMAIL/DESKTOP reminder delivery is unsupported and marked FAILED. General
outbox consumers are still absent: rows remain unpublished with
`NO_CONSUMER_REGISTERED` and the worker warns. Do not enable external consumers or
claim reliable product notification delivery until their integration gates pass.

### Migration safety

The forward-only runner serializes deployments with a PostgreSQL session lock and
checksums applied SQL. Do not edit or delete previously applied migrations; add a
new forward migration. For pre-checksum installations, `legacy-checksums.json`
contains the audited 0000–0008 baseline. A mismatch requires investigation, not
editing the ledger/manifest until the warning disappears. Keep the entire migrations
directory (including that manifest) in deployment artifacts. Test DB accounts need
CREATE DATABASE permission for the isolated concurrent-migration regression suite.


## Online workflow milestone

See `ONLINE_WORKFLOW_PHASE.md`: confirmed tag/project capture, version-safe task
editing, navigable project task lists, and continuation controls for Today/Inbox/
Projects/Focus. At that milestone, verification was 285 tests and 16 E2E/API scenarios; editor
keyboard and scoped axe checks pass. Existing API conventions are preserved by
explicit user choice. Full task-management, cursor lifetime/virtualization, offline
and production-release gates are not implied by this milestone.

## Project lifecycle continuation

`PROJECT_LIFECYCLE_MILESTONE.md` describes the preceding online-workflow delivery:
project metadata, non-destructive archive/restore, versioned/idempotent API writes,
and plan-safe restoration. At that milestone, full validation was 290 tests, 19 E2E/API scenarios,
all gates and zero dependency findings. Project settings have scoped keyboard/axe
coverage; production and full-PRD qualification remain incomplete.


## Project sections and board continuation

`PROJECT_BOARD_MILESTONE.md` describes section creation/renaming, exact fractional
single-section-row reorder, and loaded-page List/Board views with drag-and-drop and
keyboard task moves. Existing task editing also supports cross-project movement.
Section changes are versioned/idempotent, tenant scoped, and atomically synced,
outboxed and audited; archived projects reject section writes. Default sections
created with new projects now participate in those same transactional records.

At that milestone, full validation was **301 tests across 33 files, 25 E2E/API scenarios**, all
existing gates green, zero dependency findings. Board and editor keyboard/axe
checks are scoped, not full WCAG qualification. See the report for exact API
contracts, density limits, bounded paging and remaining production/PRD gaps.
Deploy the API before the board UI; this is not mixed-version/offline qualification.


## Project execution analytics continuation

`PROJECT_ANALYTICS_MILESTONE.md` describes aggregate project reports for UTC days
and rolling seven-day windows. Reports reuse existing current-project/due-date
cohorts and stored scores, with explicit measurement coverage and no fabricated
missing scores. New reads use a read-only repeatable-read snapshot; global and
project summaries now preserve sub-minute recorded time.

At that milestone, full validation was **310 tests in 35 files, 29 browser/API scenarios**, all
existing gates green and zero dependency findings. The report defines temporal
semantics and remaining analytics/production gaps; this is not historical project
attribution, local-time reporting, full score-settings delivery or MVP completion.


## Phase 1 core tasks: subtasks and dependencies

See `TASK_RELATIONSHIPS_MILESTONE.md` for parent/prerequisite editing, task navigation,
cycle prevention, paged relation lists and conflict-safe controls in the task editor.
Apply **0010_non_cascading_task_parent.sql** before enabling this UI: referenced
parents can no longer silently cascade-delete live children on permanent deletion.
Whole-account purge remains tested. Existing migrations are immutable.

At that milestone, full validation was **322 tests in 36 files, 34 browser/API scenarios**, all
existing gates green and zero dependency findings. Task cursors now preserve database
microseconds. Dependency commands remain online-only and are explicitly rejected
by generic sync; this is not completion of offline relationships or all core tasks.
At that milestone, task lifecycle/recovery UI, filtering/sorting and bulk operations remained next work; see the continuations below.


## Phase 1 task archive, deletion and recovery

`TASK_LIFECYCLE_MILESTONE.md` documents task-editor lifecycle controls and the
workspace-wide Completed/Archived/Trash views linked from Inbox and project tasks.
New controls send versions and retain retry identity; legacy bodyless delete/restore
remain compatible. Only explicit deleted-status queries expose recoverable Trash
content, and the 30-day cutoff remains enforced server-side.

At that milestone, full validation was **329 tests across 37 files and 39 browser/API scenarios**,
all existing gates green, zero dependency findings. No new migration was added.
Deploy the API before the UI; older servers cannot provide its lifecycle concurrency
protection. Filtering/sorting follows below; safe bulk operations remain next.


## Task filtering and sorting continuation

`TASK_FILTERING_MILESTONE.md` documents the online-only `/tasks` browser and
compatible optional `sortBy`, `sortOrder`, `priority` and `hasDueDate` query fields.
The new view combines existing filters, applies browser-local inclusive due days,
and sorts with exact database keys and nulls last. Inbox/Today remain unchanged.

Current full validation: **349 tests across 38 files and 44 browser/API scenarios**,
all existing gates green and zero dependency findings. No migration/dependency was
added. The new real-DB regression file is `services/task-query.integration.test.ts`;
the browser suite is `e2e/task-query.spec.ts`.

Deploy API support before the UI. New cursors bind workspace/filter/order and allow
changing page size; legacy newest-first cursors remain an unbound compatibility
exception. Cursors are unsigned, not authorization, and mutable sorts are live
rather than snapshot pagination. Mixed-version cursor routing and production-scale
query-plan/load qualification are not established. Next: safe bulk operations,
separate from this read-only query increment and from broader Phase 1 completion.
