# NEXTDOO

**A personal productivity and life-management workspace.** NEXTDOO connects your goals, milestones, tasks, trackers, knowledge and data, calendar, and progress insights into one coherent workspace — so you can plan, do, track, store, schedule, and understand how your life is actually moving.

> **Status: active open-source development · not yet a release-complete product.** The web workspace implements a substantial personal core (accounts, tasks, goals, trackers, knowledge, calendar, insights, sync). Several planned surfaces are intentionally gated, deferred, or unbuilt. See [Project maturity](#project-maturity-and-current-limitations) and [Roadmap](docs/ROADMAP.md).

---

## Table of contents

- [What problem does NEXTDOO solve?](#what-problem-does-nextdoo-solve)
- [Project objectives and intended users](#project-objectives-and-intended-users)
- [Key features](#key-features)
- [Product screenshots](#product-screenshots)
- [Architecture overview](#architecture-overview)
- [Technology stack](#technology-stack)
- [Local installation](#local-installation)
- [Environment configuration](#environment-configuration)
- [Database setup and migrations](#database-setup-and-migrations)
- [Development startup](#development-startup)
- [Testing and verification](#testing-and-verification)
- [Documentation](#documentation)
- [Security reporting](#security-reporting)
- [Contributing](#contributing)
- [Roadmap and changelog](#roadmap-and-changelog)
- [License](#license)
- [Maintainers](#maintainers)
- [Project maturity and current limitations](#project-maturity-and-current-limitations)

---

## What problem does NEXTDOO solve?

Most productivity tools isolate your data: tasks live in one app, habits in another, notes in a third, calendar events in a fourth — and none of them connect back to what you actually *did*. Progress, when it exists at all, is usually a list of completed items rather than a measurement of the relationship between what you planned, the time you had, the effort you estimated, and what actually happened.

NEXTDOO starts from one personal workspace and connects the pieces:

- **Goals → milestones → tasks → progress** — outcomes cascade down to daily work, and completed work flows back up into measurable goal progress.
- **Planning → execution → tracking** — tasks become execution records with explainable scores (due-date discipline, planning accuracy, reschedule behavior, recurrence adherence), never fabricated "Unmeasured" values.
- **Capture → calendar → capacity** — tasks and events share one workspace calendar, with provider-aware capacity planning against your configured workday.
- **Work → knowledge** — tasks connect to tracker observations, notes, and typed personal databases through real, owner-scoped relations.
- **Activity → insight** — a cross-module Insights view and period reports show what happened across tasks, goals, trackers, calendar, and knowledge, with honest comparison windows and opt-outs.

The goal is measurable improvement in execution reliability — alongside connected planning, tracking, information, and time management — for people who want to understand their progress rather than just maintain a checklist.

## Project objectives and intended users

**Objectives**

1. Provide one personal workspace that connects planning, execution, knowledge, and review.
2. Measure execution honestly: planned work vs. available time vs. actual effort, with explainable results and corrections that never rewrite history.
3. Stay personal-first: single-user ownership, real offline-first foundations (queued capture, scoped caches, conflict resolution), and a self-hostable web backend.
4. Sequence platforms deliberately: web first, then Windows/Android/iOS clients.

**Intended users**

- Individuals managing their own goals, tasks, habits, information, time, and progress — the primary launch segment.
- Power users who want their productivity data in a self-hostable system with exportable, auditable data rights.
- Developers who want a readable, tested reference for a Next.js + PostgreSQL personal-workspace application.

## Key features

Status labels follow the actual implementation: **Implemented** (shipped in the current code with tests), **Partially implemented** (core flow exists with named boundaries), **Planned** (accepted but not built), **Deferred** (deliberately sequenced later), **Not supported** (explicitly out of scope for the first release).

### Accounts & security — Implemented

- Email/password registration with email verification, password reset (single-use tokens, ≤30 min expiry), optional TOTP MFA with recovery codes.
- Session listing, per-session revocation, sign out everywhere, durable login backoff (account + IP).
- Argon2id password hashing, hashed session/reset tokens, generic error responses, password-confirmed account deletion with grace period and transactional purge.
- Owner-scoped data isolation (every read/write is bound to the authenticated account's workspace), transactional audit/outbox writes, idempotent request identities.
- Structured logging with credential-field redaction, secure cookie flags in production, origin/Fetch-Metadata protections.

### Tasks & Task Center — Implemented

- Capture and editing with tags, priorities, due dates, estimates, free-text `location`, rich Markdown descriptions (sanitized renderer, 20k limit), subtasks and dependencies (with cycle prevention).
- Projects with sections and a drag-and-drop board (with keyboard alternatives and optimistic movement with rollback), archive/restore lifecycle, trash with 30-day recovery.
- Browse tasks: combined filters, six sorts, virtualized rendering above 200 rows, atomic all-or-nothing bulk complete/archive/reschedule (up to 100 selected tasks).
- Recurring tasks with rule editing, occurrence lifecycle, bounded generation and retries; task cursors preserve database microseconds.
- Task Center: Home (configurable cards), Inbox, Today/Tomorrow/Upcoming/Overdue/Backlog/Completed destinations, quick capture with a real offline queue, command palette (`?`), shared search.
- Focus: stopwatch and Pomodoro sessions, manual time logging with audited corrections, one active timer per device with `OVERLAPPED` preservation.
- Reminders: durable in-app delivery with history, snooze/cancel, bounded retries.

### Goals — Implemented

- Goal Center: goals → sub-goals → milestones with stable `G1` / `G1.M1` identifiers, task linking/unlinking, derived progress that deduplicates linked tasks and never fabricates completion.

### Trackers — Implemented

- Configurable personal trackers: typed observation fields (number, text, checkbox, select, duration, date/date-time), all/any condition rules, editable statuses, 0–5 star scores.
- Durable worker ingestion every 10 seconds with leases, retries, and unique source receipts; task completion evidence feeds scoring without duplicating daily stars.
- Eleven editable templates (Exercise, Water Intake, Reading, Study, Sleep, Meditation, Weight, Learning, Finance, Mood, Custom Score), monthly reports with independent channel settings.
- Paused/archived periods are never backfilled; missing days never receive fabricated rows.

### Knowledge & Data — Implemented

- Typed personal databases: TITLE, TEXT, RICH_TEXT, NUMBER, CHECKBOX, SELECT, MULTI_SELECT, DATE, URL, EMAIL, PHONE, FILE, RELATION — with owned composite foreign keys and discriminator guards.
- Records with rich text, standalone or attached notes, workspace tags, attachments, duplicate/soft-delete/restore.
- Knowledge relations with backlinks: records/notes can reference tasks, goals, milestones, tracker entries, calendar events and other knowledge items.

### Calendar — Implemented (native/ICS) · Google withheld for first release

- Calendar Center: Day/Week/Month/Year/Agenda views, native calendars, read-only ICS snapshot uploads (1 MB / 2,000 events / 3-year bounds), source visibility and colors, drag rescheduling, archive/restore.
- Calendar events appear in Today/Home/Insights; task, goal, tracker activity, and knowledge dates layer over the calendar.
- Google Calendar mirrors, OAuth sync, and webhook ingestion exist behind `GOOGLE_CALENDAR_ENABLED` (default **false**) and are withheld from the first release until live provider acceptance passes.

### Insights & reporting — Implemented (bounded)

- Cross-module Insights overview and period reports (1–366 local dates, closed-period comparisons) covering tasks, goals, trackers, calendar, knowledge, focus time.
- Existing task/project execution analytics with explainable scores, corrections (`DUE_DATE_CORRECTED`, `EXTERNALLY_BLOCKED`, `UNTRACKED_COMPLETION`, `EXCLUDED_FROM_ANALYTICS`), bounded date-range recalculation, and immutable history.
- JSON/CSV export of reports; durable authenticated export pipeline with signed 24-hour download URLs and plan quotas.

### Settings & data rights — Implemented

- Personalization: themes, contrast/reduced-motion, accent/density/sizing, sidebar/view defaults, default task list, reminder form defaults, wellbeing opt-outs.
- Account: profile, timezone, MFA, sessions, audit history (plan-retention-bounded), authenticated JSON export, deletion/grace cancellation/purge.
- Push settings (browser), storage quota display, offline queue status, billing entitlement state display.

### Offline & sync — Partially implemented

- Sync protocol v1: offline quick capture durably enqueues (client-UUID create, lost-response/re-push dedupe), scoped IndexedDB caches, pull applies remote updates/tombstones, app-shell reconcile loop with backoff.
- Conflict resolution UI: side-by-side per-field snapshots, `local`/`server` choose actions, quarantine review with retry.
- Boundaries: only quick capture and Today-cache read are offline-capable; task editor/lifecycle, relationships, recurrence, and other modules require connectivity. Offline edits/deletes and offline timers are **not** claimed.

### Attachments — Implemented (local storage) · production storage planned

- Upload pipeline with signed short-lived URLs, byte caps, MIME allowlists, real ClamAV malware scanning, clean-only download gating, storage outside the web root.
- Local-disk object storage is wired; S3-compatible storage is a documented switching point (fields exist; adapter not production-qualified).

### Worker & durability — Implemented

- `apps/worker` schedules: reminder dispatch, recurrence generation, tracking ingestion/evaluation, mail delivery (durable encrypted queue with leases/retries/expiry), retention purge, outbox relay.
- PostgreSQL-backed durability: no in-memory queues are required for reminders, tracking, mail, or retention.

### Billing — Partially implemented (scaffolding only)

- Plan model, entitlement endpoint, provider webhook verification (Stripe/Razorpay signature + window checks, event dedupe), plan-gated limits enforced server-side.
- No live payment provider is enabled; checkout is test-mode only with a complete provider configuration.

### Notifications — Partially implemented

- Reminders deliver as durable in-app notifications (WEB/SENT means a receipt row, not a native popup).
- Email delivery through a durable SMTP queue when `SMTP_URL` is configured (requires TLS and verified sender in production); task EMAIL reminders are **not supported**.
- Browser push (Web Push) plumbing exists with a test-only VAPID keypair for E2E; real push delivery requires deployment configuration.

### Native clients — Planned

- Windows (Tauri/WebView2), Android, iOS/macOS clients per the PRD platform sequence. No native client code exists yet; the web sync protocol is the foundation.

### AI & collaboration — Planned / Deferred

- Deterministic natural-language task parsing and advisory suggestions exist; LLM/voice features, team workspaces, roles, plugins, and a marketplace are deferred or out of scope.

## Product screenshots

NEXTDOO is under active development and has no public demo deployment yet. The screenshots below were captured from a locally running production build against a real PostgreSQL database — see [docs/SHOWCASE.md](docs/SHOWCASE.md) for the verified procedure.

| Today & quick capture | Task editor | Browse tasks |
|---|---|---|
| ![Today](docs/assets/02-today.png) | ![Task editor](docs/assets/03-task-editor.png) | ![Browse tasks](docs/assets/04-tasks-browser.png) |

| Calendar Center | Insights | Settings |
|---|---|---|
| ![Calendar](docs/assets/09-calendar.png) | ![Insights](docs/assets/10-insights.png) | ![Settings](docs/assets/11-settings.png) |

More screenshots (login, projects, goals, trackers, knowledge) are in [docs/assets/](docs/assets/). All screenshots were captured from a fresh demo account — no personal data appears in them.

> **No public deployment is claimed.** A hosted demo requires deployment configuration, provider gating decisions, and maintainer approval; see [docs/SHOWCASE.md](docs/SHOWCASE.md) for the requirements.

## Architecture overview

NEXTDOO is a pnpm/Turborepo monorepo with two applications and five shared packages:

```
Nextdoo/
├── apps/
│   ├── web/            # Next.js 15 App Router app (UI + /api/v1 route handlers)
│   └── worker/         # Background job runner (tsx; reminders, tracking, mail, purge)
├── packages/
│   ├── contracts/      # Zod request/response contracts and error taxonomy
│   ├── core/           # Pure TypeScript domain logic (scoring, recurrence, NL parse, knowledge, calendar math)
│   ├── db/             # PostgreSQL schema, hand-authored SQL migrations, runner
│   ├── calendar/       # ICS parsing and calendar domain logic
│   └── billing/        # Plan/entitlement model and provider signature verification
├── scripts/            # dev:services, security scan, migration scaffolder, restore smoke, perf baseline
├── tests/              # Vitest database helpers (integration test entry points)
└── .github/workflows/  # CI: security scan → audit → migrations → lint → types → coverage → build → E2E
```

**Data flow.** The web app exposes the Next.js UI and `/api/v1` route handlers. All mutations go through server services that enforce workspace ownership, optimistic versioning (`RESOURCE_VERSION_CONFLICT` on stale writes), and idempotent request identities. Domain events are written to a transactional outbox and relayed by the worker. PostgreSQL (Drizzle ORM + hand-authored, checksum-verified SQL migrations) is the single system of record. The worker owns scheduling and delivery: reminder dispatch, recurrence generation, tracking ingestion/evaluation, mail delivery, retention purge, and outbox relay.

**Sync.** Clients sync through `POST /api/v1/sync/push` and `POST /api/v1/sync/pull` using commit-ordered cursors. Offline quick capture is queued in IndexedDB with client mutation identities and deduped server-side on replay. Same-field conflicts surface in the conflict UI for explicit resolution.

## Technology stack

Verified against `package.json` manifests:

| Layer | Technology | Version |
|---|---|---|
| Runtime | Node.js | ≥ 22.22 (CI: 22.22.3) |
| Package manager | pnpm | 9.15.4 (lockfile-pinned) |
| Framework | Next.js (App Router) | 15.5.25 |
| UI | React | 19.0.8 |
| Language | TypeScript | 5.7.2 (strict) |
| ORM | Drizzle ORM | 0.45.2 |
| Database | PostgreSQL | 16+ required (embedded 18.4 local; CI uses 16) |
| Monorepo | Turborepo | 2.10.12 |
| Unit/integration tests | Vitest (+ V8 coverage) | 4.1.11 |
| Browser tests | Playwright + axe-core | 1.63.0 / 4.13.0 |
| Lint/types | ESLint (typescript-eslint) | 9.39.5 |
| Auth | Argon2id (`@node-rs/argon2`), TOTP MFA | 2.0.2 |
| Mail | Nodemailer (durable PostgreSQL queue) | 10.0.1 |
| ICS | ICAL.js | 2.2.1 |
| Push | web-push (browser push) | ^3.6.7 |
| Malware scan | ClamAV (CI/attachment pipeline) | — |

## Local installation

**Prerequisites**

- Node.js **22.22+**
- pnpm **9.15.4** (`corepack enable` ships it via the `packageManager` field)
- PostgreSQL **16+** — or no database at all: the repo can start an embedded PostgreSQL for development (see below)

**Steps**

```bash
# 1. Install dependencies (lockfile-pinned; do not use --no-frozen-lockfile)
corepack enable
pnpm install --frozen-lockfile

# 2. Start a local PostgreSQL (embedded; no system install required)
#    Terminal 1 — isolated test database, never reuse valuable data
PGPORT=55432 PGDATABASE=nextdoo_test PGDATA_DIR="$PWD/.data/test-postgres" pnpm dev:services
#    It prints: DATABASE_URL=postgres://postgres:postgres@localhost:55432/nextdoo_test

# 3. Export the environment (pnpm/tsx do not load .env files automatically)
export DATABASE_URL=postgres://postgres:postgres@localhost:55432/nextdoo_test
export AUTH_SECRET=test-only-secret-at-least-32-characters
export APP_URL=http://localhost:3000

# 4. Apply migrations (safe to rerun; second run reports "Already up to date")
pnpm db:migrate

# 5. Start development
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000), register an account, and verify your email (development SMTP logs local links when `SMTP_URL` is unset).

To run the background worker alongside the web app (reminders, recurrence, tracking, mail, retention):

```bash
pnpm dev:worker
```

## Deployment

NEXTDOO ships with complete deployment infrastructure — a multi-stage
Dockerfile (web + worker), `docker-compose.yml` (Postgres + migrations + web +
worker in one command), and platform configs for Fly.io, Vercel, and Railway.

**Quickest path — Docker:**

```bash
cp .env.example .env          # edit AUTH_SECRET, APP_URL
# Set DATABASE_URL in .env to point at the compose db service (host: db, port: 5432)
docker compose up --build -d
# → http://localhost:3000
```

| Platform | Config | Notes |
|---|---|---|
| **Docker** | `Dockerfile` + `docker-compose.yml` | Full stack (web + worker + Postgres), one command |
| **Fly.io** | `fly.toml` | Web + worker as two processes; bring your own Postgres |
| **Vercel** | `vercel.json` | Web only — run the worker on a separate host |
| **Railway** | `railway.toml` | Web + worker as two Railway services |

**No public demo is claimed yet.** The deployment infrastructure is complete and
verified (the standalone Next.js server boots, connects to Postgres, and serves
the health endpoint). Deploying to a real host requires the maintainer to
provide credentials and accept the provider gating decisions. See
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the full guide with platform-specific
steps, environment variables, health checks, and cost estimates.

## Environment configuration

The required and optional environment variables are documented in [.env.example](.env.example).

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | ✅ | PostgreSQL connection string |
| `AUTH_SECRET` | ✅ | 32+ random characters; derives session and encryption keys. **Never commit real values.** |
| `APP_URL` | ✅ | Public application URL (absolute links) |
| `EXPORT_STORAGE_DIR` | — | Export artifact directory (web and worker must agree) |
| `REDIS_URL` | — | Reserved; not wired (durable limits live in PostgreSQL) |
| `GOOGLE_CALENDAR_ENABLED` | — | Default `false`; Google integrations withheld for the first release |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | — | Google OAuth (isolated provider development only) |
| `SMTP_URL` / `MAIL_FROM` | — | Authentication-email delivery; both web and worker need `SMTP_URL` |
| `STRIPE_*` / `RAZORPAY_*` | — | Billing provider (test mode only; endpoints answer 503 otherwise) |
| `S3_*` | — | S3-compatible attachment storage (local disk is the current default) |
| `LOG_LEVEL` | — | Log verbosity (default `info`) |

Environment names alone are **not** proof of integration: Google, Stripe/Razorpay, S3, and browser push require provider configuration and acceptance evidence. See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Database setup and migrations

- **Hand-authored SQL is authoritative.** Migrations live in `packages/db/migrations/` as checksummed, transactionally applied SQL files. Never edit an applied migration — add a new forward migration.
- `pnpm db:generate meaningful_change_name` scaffolds the next numbered SQL file. It does **not** infer schema differences; edit the generated file and run `pnpm db:migrate`.
- The runner serializes deployments with a PostgreSQL session lock, verifies applied SHA-256 checksums, and refuses missing/changed history. `legacy-checksums.json` covers the audited baseline for pre-checksum installations.
- The full migration chain (`0000_init` → `0031_native_calendar_knowledge`, 32 migrations) applies cleanly to a fresh database and replays idempotently.
- Integration tests require a migrated `DATABASE_URL`; they fail loudly without one (see [tests/database.ts](tests/database.ts)).

## Development startup

```bash
pnpm dev            # turbo dev: Next.js web app on http://localhost:3000 (host 0.0.0.0)
pnpm dev:worker     # background worker (tsx watch), needs DATABASE_URL exported
pnpm dev:services   # embedded PostgreSQL (optional; defaults port 55432, database nextdoo)
```

Next.js reads `apps/web/.env.local`; the worker and tests require exported values. Turbo passes declared application configuration to package tasks. See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for service details, migration safety, and provider configuration boundaries.

## Testing and verification

The project's verification gates are real and enforced in CI. Use the project's actual scripts:

```bash
pnpm lint              # ESLint, zero warnings
pnpm typecheck         # all seven packages (turbo)
pnpm test:unit         # pure core + tooling; no database required
pnpm test              # full unit + integration suite (requires migrated DATABASE_URL)
pnpm test:coverage     # full suite + V8 coverage (HTML/JSON/LCOV in coverage/)
pnpm build             # production web build
pnpm audit --audit-level high
pnpm security:scan     # deterministic secret/static repository scan
pnpm test:e2e          # Playwright: production build + real DB + real Chromium on :3100
pnpm verify            # lint → typecheck → coverage/tests → build → E2E (full pipeline)
```

Coverage thresholds: core packages must reach **85% statements/branches/functions/lines**. Integration tests run against real PostgreSQL; E2E runs a production build with the real server, unique accounts, one worker, and **zero retries**. CI additionally runs real ClamAV/EICAR malware verification and a PostgreSQL backup/restore smoke test.

Detailed instructions, current verification results, and known test limitations are in [docs/QUALITY_AND_TESTING.md](docs/QUALITY_AND_TESTING.md).

## Documentation

| Document | Purpose |
|---|---|
| [docs/PRD.md](docs/PRD.md) | Authoritative product requirements and technical blueprint (v1.3) |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Toolchain, local services, quality gates, migrations, environment |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Docker, Fly.io, Vercel, Railway deployment guides |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Current status, completed milestones, priorities, known limitations |
| [docs/MAINTENANCE.md](docs/MAINTENANCE.md) | Maintenance process, issue handling, supported versions, release policy |
| [docs/QUALITY_AND_TESTING.md](docs/QUALITY_AND_TESTING.md) | Testing infrastructure, commands, current verification evidence |
| [docs/SHOWCASE.md](docs/SHOWCASE.md) | Local demonstration procedure and visual evidence |
| [docs/PHASE1_COMPLETION_PLAN.md](docs/PHASE1_COMPLETION_PLAN.md) | Phase 1 completion ledger and remaining work |
| [docs/PERSONAL_CORE_AUDIT.md](docs/PERSONAL_CORE_AUDIT.md) | Personal-first reconciliation audit (baseline + PC follow-ups) |
| Milestone reports (`docs/*MILESTONE.md`) | Bounded delivery records for each implemented increment (PC1–PC7, M1–M8) |

## Security reporting

NEXTDOO takes security seriously. Please **do not** open public issues for security vulnerabilities.

Report privately to the maintainer at **Sudhanshu Kumar** via the repository's GitHub **Security Advisories** tab (https://github.com/Sudhanshu-git-hub/Nextdoo/security/advisories) or the contact details in [SECURITY.md](SECURITY.md). Include a description, reproduction steps, and the affected version/commit. See [docs/MAINTENANCE.md](docs/MAINTENANCE.md) for the full security policy, and the [ASVS-oriented control matrix](docs/M8_i8_SECURITY_CONTROL_MATRIX.md) for implemented security evidence.

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md) for prerequisites, branch naming, commit conventions, code quality requirements, and the pull-request process. Please read it fully before opening a pull request.

## Roadmap and changelog

- Current priorities, milestone statuses, and acceptance criteria: [docs/ROADMAP.md](docs/ROADMAP.md)
- Release and maintenance policy: [docs/MAINTENANCE.md](docs/MAINTENANCE.md)
- Changelog (Keep a Changelog format): [CHANGELOG.md](CHANGELOG.md)

## License

NEXTDOO is licensed under the [MIT License](LICENSE) (Copyright © 2026 Sudhanshu Kumar).

This license covers the repository source code and documentation. Runtime data, user content, and deployment configurations remain the property of their respective owners. Third-party dependencies retain their own licenses — see each package's manifest and the license files in `node_modules`.

## Maintainers

- **Sudhanshu Kumar** — primary maintainer, architecture, code review, release management. See [MAINTAINERS.md](MAINTAINERS.md) for detailed responsibilities.

## Project maturity and current limitations

NEXTDOO is a substantial, actively maintained personal-workspace implementation with real test coverage, security gates, and CI — **but it is not a release-complete product and no public deployment exists.** Deployment infrastructure (Docker, Fly.io, Vercel, Railway) is complete and verified; a hosted demo requires maintainer credentials and provider acceptance. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

**What is solid today**

- Personal core (accounts, tasks, goals, trackers, knowledge, calendar native/ICS, insights, settings) with database-backed integration tests and browser E2E.
- Durable worker pipelines (reminders, tracking, mail, retention), transactional outbox, idempotent writes.
- Bounded offline capture and sync with explicit conflict resolution.
- CI with security scan, dependency audit, migrations, lint, typecheck, coverage, build, real ClamAV malware gating, backup/restore smoke, and full first-attempt browser acceptance.

**Known limitations and open release gates**

- No public demo deployment; no release has been published.
- Google Calendar is withheld from the first release (`GOOGLE_CALENDAR_ENABLED=false`); live provider acceptance is outstanding.
- Real billing, production S3 storage, SMTP delivery, and browser push require deployment configuration and provider acceptance.
- Offline mode covers quick capture and Today cache only; offline task editing is not supported.
- Production security qualification (managed secrets, TLS/DB TLS, backups/PITR, load testing, independent assessment) is not established.
- Windows/Android/iOS/macOS clients, AI features, and collaboration are planned or deferred.

See [docs/ROADMAP.md](docs/ROADMAP.md) for the full picture, and [docs/MAINTENANCE.md](docs/MAINTENANCE.md) for supported versions and release policy.
