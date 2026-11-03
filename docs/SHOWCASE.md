# NEXTDOO Showcase — Verified Local Demonstration

**Status: verified local demonstration. No public deployment exists.**

NEXTDOO has no public demo URL at this time. This document describes the
verified local demonstration procedure, the screenshots captured from the real
running application, and what is required to publish a public demonstration.

## Verified local demonstration

The screenshots in `docs/assets/` were captured on **2026-11-02** from a
production build (`next start`) running against a real, migrated PostgreSQL
database, driven by Playwright with a real Chromium browser. No mocked
responses or static assets were used.

**Environment used for the capture**

| Component | Version |
|---|---|
| Node.js | v22.22.3 |
| pnpm | 9.15.4 |
| PostgreSQL | 18.4 (embedded, `pnpm dev:services`) |
| Next.js | 15.5.25 (production build) |
| Browser | Chromium 153 (Playwright 1.63.0) |

**Procedure (reproducible)**

```bash
# 1. Install and start an isolated database
corepack enable
pnpm install --frozen-lockfile
PGPORT=55432 PGDATABASE=nextdoo_test PGDATA_DIR="$PWD/.data/test-postgres" pnpm dev:services

# 2. Configure and migrate
export DATABASE_URL=postgres://postgres:postgres@localhost:55432/nextdoo_test
export AUTH_SECRET=test-only-secret-at-least-32-characters
export APP_URL=http://localhost:3100
pnpm db:migrate

# 3. Build and run the production server
pnpm build
pnpm --filter @nextdoo/web exec next start -H 0.0.0.0 -p 3100 &

# 4. Capture screenshots (registers a fresh demo account automatically)
node scripts/screenshot-demo.mjs
```

The capture script (`scripts/screenshot-demo.mjs`) registers a uniquely named
demo account (e.g. `demo-<uuid>@test.local`), creates one real task through
quick capture, and screenshots the main workspace pages. No existing user
data is used and no personal information appears in the output.

## Captured screenshots

| File | Page | What it shows |
|---|---|---|
| `01-login.png` | `/login` | Landing screen, sign-in form |
| `02-today.png` | `/today` | Today view with the captured task |
| `03-task-editor.png` | Task editor | Task title, fields, and controls |
| `04-tasks-browser.png` | `/tasks` | Browse tasks with filters and sorts |
| `05-projects.png` | `/projects` | Project list |
| `06-goals.png` | `/goals` | Goal Center list |
| `07-trackers.png` | `/trackers` | Personal trackers list |
| `08-knowledge.png` | `/knowledge` | Knowledge databases and notes |
| `09-calendar.png` | `/calendar` | Calendar Center day/week/month views |
| `10-insights.png` | `/insights` | Cross-module Insights overview |
| `11-settings.png` | `/settings` | Settings, account, and personalization |

The screenshots represent a fresh account; several pages (goals, trackers,
knowledge) show their empty states. This is honest: the demo data shown is a
single task created by the capture script.

## What is available in the demonstrated app

- **Accounts:** register, sign in, and the account lifecycle (verification,
  password reset, MFA enrollment, session management, deletion).
- **Tasks:** capture with natural-language parsing, editing, projects,
  sections/board, tags, priorities, due dates, subtasks, dependencies,
  recurrence, archive/trash recovery, bulk operations, and filters/sorts.
- **Goals:** create goals/sub-goals/milestones, link tasks, see derived progress.
- **Trackers:** create configurable trackers, log observations, view scores.
- **Knowledge:** typed databases, records, notes, and relations.
- **Calendar:** native events, ICS imports, and Google mirrors (gated off by
  default).
- **Insights:** cross-module overview and period reports.
- **Settings:** personalization, wellbeing controls, sessions, exports, billing
  state display.

## What is NOT available

- **Google Calendar sync** — `GOOGLE_CALENDAR_ENABLED` defaults to `false`; the
  provider track is withheld from the first release pending live acceptance.
- **Live billing, SMTP delivery, browser push, S3 storage** — require provider
  configuration and acceptance.
- **Native clients** — web only; Windows/Android/iOS clients are planned.
- **A public URL** — the application runs locally only.

## Requirements for publishing a public demonstration

1. **Deployment target** — a hosting provider with TLS, a managed PostgreSQL,
   and a running Next.js production server.
2. **Configuration** — `DATABASE_URL`, `AUTH_SECRET` (from a secrets manager,
   not committed), `APP_URL`, and optionally provider settings.
3. **Provider gating decisions** — which integrations (Google, billing,
   SMTP, push, S3) are enabled for the demo, and their acceptance evidence.
4. **Security review** — trusted ingress, rate limits, request budgets, and a
   demo-data policy (the demo should not expose real accounts or private data).
5. **Staff/operating readiness** — a way to monitor the demo and respond to
   issues; no production SLOs are claimed today.
6. **Maintainer approval** — the maintainer decides when a public demo is
   appropriate; this document and the README will be updated with the verified
   URL, sign-in requirements, and available features once it exists.

**No demo URL is claimed in this document or the README until it exists and is
verified.**
