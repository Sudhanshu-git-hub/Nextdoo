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
use unique accounts, one worker, no automatic retries and no network/API mocks.
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

- Rate limiting is in-process, not Redis-backed.
- Worker is an interval scheduler, not BullMQ or a durable queue.
- SMTP transport is not implemented. The mail stub logs test/development links;
  configuring SMTP does not send mail. Do not deploy this as account recovery.
- Reminder and outbox jobs still contain placeholder acknowledgement behavior;
  they do not establish provider delivery. Do not mark these features complete.
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

The prioritized integrity repairs and final evidence are in `REPAIR_REPORT.md`.
Fresh SQL migrations 0000–0006 plus replay, 233 tests and five real browser E2E
passed locally. Apply forward migrations before starting the repaired services.
The sync sequence trigger serializes sync writes globally through commit; measure
throughput before production rollout. Legacy timer pause timestamps cannot be
fully reconstructed from the previous schema. Unsupported recurrence creation now
fails explicitly and capture retains the original text; scheduling was not added.

These results do not certify all audit findings fixed or the app production-ready.
In particular, authentication/origin/logging hardening, unused offline-queue
isolation and real provider delivery remain outstanding. Remote PostgreSQL 16 CI,
load, backup restore and end-to-end provider behavior are not claimed verified.
