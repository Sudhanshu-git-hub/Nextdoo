# M8 — Roadmap & Scope Audit (requirements matrix)

Date: 2026-09-14 · Branch: `arena/01a085b7-nextdoo` · Baseline: `450fa38`
(CI-verified; vitest 797/797 across 73 files; E2E 147 passed locally with the
documented ClamAV-only exception; coverage gate green).

Method: full re-read of `docs/PRD.md` (v1.1, all 22 sections), the completion
ledger (`docs/IMPLEMENTATION_LOG.md`), every M1–M7 milestone document, the
current implementation (route tree, worker job registry, schema, client
libraries), all documented deferrals and external blockers. No product code
was modified. Every row cites the PRD section that creates the requirement —
nothing is invented; where a PRD item could not be found in the code it is
classified accordingly, not assumed.

**Status legend**

1. **CLOSED + CI-verified** — implemented, tested, full pipeline green.
2. **IMPLEMENTED, lacking external/live verification** — code + tests complete; real-provider validation not possible/performed here.
3. **PARTIALLY IMPLEMENTED** — material PRD sub-requirements missing (named below).
4. **NOT IMPLEMENTED** — PRD requirement with no implementation and no recorded deferral decision.
5. **EXPLICITLY DEFERRED / PHASE 2** — PRD Phase 2/3 text, or a recorded deferral decision (cited).
6. **EXTERNALLY BLOCKED** — work that cannot proceed in this environment (credentials/egress/infra); blocker cited.

## 1. Requirements matrix

### 1.1 Authentication & accounts (PRD §6.1, §11.2)

| # | PRD | Requirement | Status | Where | Delivered by | Evidence | Gap |
|---|---|---|---|---|---|---|---|
| A1 | §6.1 | Email/password register + email verification | 1 | `/auth/register`, `/auth/verify-email` | M1 | unit + E2E auth specs | — |
| A2 | §6.1 | Password reset, tokens ≤30 min, single-use | 1 | `/auth/password-reset/*` | M1, M6-i5 | unit + E2E | — |
| A3 | §6.1 | Session listing/revocation, individual + global, ≤60 s | 1 | `/me/sessions`, `logout-all` | M6-i5 `6286e66` | integration + E2E | — |
| A4 | §6.1 | Optional TOTP MFA + one-time recovery codes | 1 | `/auth/mfa/*` | M1, M6-i5 | unit + E2E | — |
| A5 | §6.1 | Account deletion: confirmation, re-auth, retention, purge | 1 | `/account/deletion`, `accounts.purge` job | M6-i7 `c04df57`, M6-i8 `6c36100` | E2E + retention tests | — |
| A6 | §6.1 | Login rate limits per IP + account, exponential backoff | 1 | `login-throttle`, `authentication_attempts` | M6-i5/i6 | integration | — |
| A7 | §6.1 | Argon2id hashing, hashed tokens, generic errors | 1 | `server/crypto.ts`, `contracts/errors.ts` | M1 | unit | — |
| A8 | §11.2 | Passkeys (WebAuthn), social login | 5 | — | — | — | PRD Phase 2 |

### 1.2 Workspaces (PRD §6.2)

| # | PRD | Requirement | Status | Where | Delivered by | Evidence | Gap |
|---|---|---|---|---|---|---|---|
| B1 | §6.2 | One personal workspace; name, tz, week start, workday hours, versioned | 1 | `/workspaces/[id]`, workspace settings UI | M1 + WORKSPACE_SETTINGS milestone | integration + E2E | GET/POST `/v1/workspaces` (list/create) absent from route tree; single-workspace MVP makes create a Phase-2 concept, list a minor gap |
| B2 | §6.2 | Multiple workspaces (Phase 2) | 5 | schema supports `workspace_id` everywhere | — | — | PRD Phase 2 |

### 1.3 Tasks (PRD §6.3)

| # | PRD | Requirement | Status | Where | Delivered by | Evidence | Gap |
|---|---|---|---|---|---|---|---|
| C1 | §6.3 | CRUD + optimistic concurrency (409 `RESOURCE_VERSION_CONFLICT`) | 1 | `/tasks*`, `services/tasks.ts` | M1–M2 | unit + integration + E2E | — |
| C2 | §6.3 | State machine ACTIVE/COMPLETED/ARCHIVED/DELETED + restore paths | 1 | `tasks` routes (complete/reopen/archive/restore) | TASK_LIFECYCLE milestone | E2E lifecycle specs | — |
| C3 | §6.3 | Subtasks + dependencies, cycles rejected 422 | 1 | `/tasks/[id]/subtasks`, `/tasks/[id]/relations` | TASK_RELATIONSHIPS | integration + E2E | — |
| C4 | §6.3 | Soft delete + tombstone + 30-day retention | 1 | retention jobs, sync tombstones | M6-i6 `4e0592f`, M5 | integration | — |
| C5 | §6.3 | Location field, rich description | 1 | TASK_LOCATION, RICH_DESCRIPTION milestones | M2 | E2E | — |
| C6 | §6.3 | Custom fields / custom states | 5 | — | — | — | PRD marks Phase 2 |

### 1.4 Projects, sections, tags (PRD §6.4)

| # | PRD | Requirement | Status | Where | Delivered by | Evidence | Gap |
|---|---|---|---|---|---|---|---|
| D1 | §6.4 | Projects create/archive/restore; sections create/reorder (fractional position); task moves | 1 | `/projects*`, `/sections*` | PROJECT_LIFECYCLE, PROJECT_BOARD | E2E + integration | — |
| D2 | §6.4 | Project-level execution analytics | 1 | `/projects/[id]/analytics`, `services/project-analytics.ts` | PROJECT_ANALYTICS + M4 | integration + E2E | — |
| D3 | §6.4 | Templates / portfolio hierarchies | — | — | — | — | Explicitly out of MVP ("MVP does not support") |

### 1.5 Recurring tasks (PRD §6.5)

| # | PRD | Requirement | Status | Where | Delivered by | Evidence | Gap |
|---|---|---|---|---|---|---|---|
| E1 | §6.5 | Daily/weekly/monthly/weekdays/interval, end date/count, tz, skip/complete/reschedule occurrence | 1 | `core/recurrence.ts`, `db/recurrence.ts`, `recurrence.generate` job | TASK_RECURRENCE | unit (incl. DST) + integration + E2E | — |
| E2 | §6.5 | Occurrence records; key `rule_id + local_occurrence_date`; no rewrite of history; idempotent generation; 60-day/50-occurrence cap; advisory locks | 1 | `task_occurrences`, generation state (migration 0011) | TASK_RECURRENCE | unit + integration (retry-duplication) | — |

### 1.6 Reminders & notifications (PRD §6.6, §12.4, §15)

| # | PRD | Requirement | Status | Where | Delivered by | Evidence | Gap |
|---|---|---|---|---|---|---|---|
| F1 | §6.6 | Reminder lifecycle SCHEDULED→…→SENT/FAILED/CANCELED/EXPIRED; snooze; cancel-on-completion ≤30 s; no double delivery; 24 h expiry | 1 | `reminders` routes, `reminders.dispatch`/`requeue_stuck` jobs | NOTIFICATION_DELIVERY + reminder workflow | integration + E2E | — |
| F2 | §6.6 | Delivery channels: in-app, email | 1 | in-app `notifications` center; durable mail queue (`mail.deliver`) | M5-era + M6 | E2E (in-app), integration (mail queue) | **Email needs SMTP in production — without it, production fails explicitly (`PROVIDER_UNAVAILABLE`)** → live delivery = status 2 |
| F3 | §6.6 | Browser push notifications (Web Push) | 4 | none (no service worker, no `/push` routes, `device_registrations` table exists in schema but unused) | — | — | MVP channel missing — see §4 recommendation |
| F4 | §6.6 | Desktop notifications | 5 | — | — | — | Requires desktop app (deferred, §Z1) |
| F5 | §15 | Domain event catalog + transactional outbox | 1 | `events` outbox, `outbox.relay` job, `contracts/events.ts` | M3/M4 durability | integration | — |

### 1.7 Focus timer & time tracking (PRD §6.7)

| # | PRD | Requirement | Status | Where | Delivered by | Evidence | Gap |
|---|---|---|---|---|---|---|---|
| G1 | §6.7 | Start/pause/resume/stop, task association, one active per device, overlap flag (never delete) | 1 | `/timers*`, `services/timers.ts` | M3 | unit + integration + E2E | — |
| G2 | §6.7 | Manual duration logging + audited corrections | 1 | `time.logged_manually` events, `manualAdjustmentSeconds` | M3 | integration | — |
| G3 | §6.7 | Optional break intervals | 4 | not found in implementation | — | — | Minor optional item; never built |
| G4 | §6.7 | Cross-device timer sync | 1 | sync protocol (timers as synced entities) | M5 | E2E multi-device | — |

### 1.8 Attachments (PRD §6.8)

| # | PRD | Requirement | Status | Where | Delivered by | Evidence | Gap |
|---|---|---|---|---|---|---|---|
| H1 | §6.8 | Upload auth → direct PUT → complete → async scan → gated download; signed short-lived URLs; no permanent client credentials | 1 | `/attachments*`, `attachment.scan` job | M6-i2 `49b1c6b` | E2E (incl. real ClamAV in CI) | — |
| H2 | §6.8 | Per-plan size/storage limits | 1 | entitlement gating on upload | M6-i1/i2 | integration | — |
| H3 | §6.8 | S3-compatible object storage | 2 | local-disk store behind the same interface | M6-i2 | CI | Production S3 bucket = deployment config; not code |

### 1.9 Views & capture (PRD §6.9, §6.10, §8.2, §8.7)

| # | PRD | Requirement | Status | Where | Delivered by | Evidence | Gap |
|---|---|---|---|---|---|---|---|
| I1 | §6.9 | List view: sort/filter (status, tag, project, date), full-text search, bulk complete/archive/reschedule | 1 | `/tasks` query (FTS), `/tasks/bulk` | TASK_FILTERING, TASK_BULK | E2E | — |
| I2 | §6.9 | Virtualization >200 rows | 1 | `TaskList` virtualizer | TASK_VIRTUALIZATION | E2E | — |
| I3 | §6.9 | Board view: sections as columns, DnD + keyboard alternative, optimistic + rollback | 1 | ProjectBoard | PROJECT_BOARD + optimistic-movement closure | E2E + a11y | — |
| I4 | §6.9 | Calendar view day/week/month; external events read-only; overload indication | 1 | CalendarView + M7 read-only import | CALENDAR_MILESTONE, M7 | E2E | — |
| I5 | §6.9 | Today warm render <1.5 s; capture instrumentation | 1 | M2 instrumentation + perf baseline | M2 | measured (perf baseline) | — |
| I6 | §6.10 | Deterministic NL parser, per-field confidence, confirmation on low confidence, original text preserved | 1 | `core/nl-parse.ts`, `/natural-language/parse`, QuickCapture | M2-era | unit + E2E | — |
| I7 | §6.10/§17.1 | LLM fallback parse (opt-in, budgeted, schema-validated) | 5 | — | — | — | Deferred by standing directive (AI); PRD positions it as opt-in fallback, deterministic path is the default |
| I8 | §8.7 | Keyboard shortcuts (N, E, Space, T, F, /, G-sequences, ?) | 1 | web shortcuts + `?` help | M6-i8 a11y | E2E keyboard paths | Desktop global shortcut = with desktop |

### 1.10 Execution tracking & analytics (PRD §7)

| # | PRD | Requirement | Status | Where | Delivered by | Evidence | Gap |
|---|---|---|---|---|---|---|---|
| J1 | §7.2 | Append-only tracking events (12 types) + idempotency | 1 | `tracking_events`, tracking writers | M3/M4 durability | unit + integration | — |
| J2 | §7.3/§7.4 | Outcome model; score model 40/25/20/15; normalization over available components; `Unmeasured` never fabricated | 1 | `core/scoring.ts`, `tracking.evaluate` | M3 + TRACKING_DURABILITY | unit (TR-01..07 class) + integration | — |
| J3 | §7.4/§7.6 | Explanation payload, source events, recalculation (90-day bounded backfill), prior versions preserved | 1 | `tracking.backfill`, results supersede-never-mutate | M4 (SCORE_CORRECTIONS) | integration | — |
| J4 | §7.7 | Score corrections (due-date correction, externally blocked, untracked completion, exclude, recalc) with actor/reason audit | 1 | `/tracking/tasks/[id]/corrections`, `/tracking/recalculate` | M4 | integration + E2E | — |
| J5 | §7.8 | Daily + weekly analytics; plain-language explanations; no punitive language | 1 | `/tracking/summary`, AnalyticsView | M4 (REPORTING) | integration + E2E | — |
| J6 | §7.9 | Wellbeing controls: disable scores; (streaks/celebrations/sounds/comparatives) | 3 | per-user `scoresEnabled` preference honored server-side (TR-07 behavior tested); overload warnings shown | M4 | integration (`project-analytics` scoresEnabled test) | No unified per-control settings panel; streaks/celebrations/sounds were never built (comparatives absent per PRD default); overload warning has no independent toggle |
| J7 | §7.10 | CSV/JSON export of events, results, rollups; async; 24 h signed URL | 1 | `/exports*`, `export.generate`, `exports.expire` | DATA_EXPORT + M6-i1 | E2E + expiry tests | — |
| J8 | §5.5/§8.3 | Advisory "improve" suggestions (larger estimates, lighter overloaded days, subtask splits…) — advisory only | 4 | not found (no suggestions engine; `/v1/ai/suggestions` route absent) | — | — | Core-loop "Improve" step partially served by explanations only; heuristic (non-AI) suggestions never built |
| J9 | §7.5 | Declarative rule language | 5 | — | — | — | PRD Phase 2 |

### 1.11 Offline & synchronization (PRD §10)

| # | PRD | Requirement | Status | Where | Delivered by | Evidence | Gap |
|---|---|---|---|---|---|---|---|
| K1 | §10.1/§10.4 | Mutation queue, optimistic updates, push/pull, cursors, tombstones | 1 | `/sync/push`, `/sync/pull`, `lib/offline-queue.ts` (IndexedDB), `use-sync-reconcile.ts` | M5-i1 `6ae9cf9` | SY-01..SY-10 integration + E2E | — |
| K2 | §10.5/§10.6 | Conflict detection + resolution matrix (scalar LWW w/o loss, title/description conflict UI, delete-wins + restore, recurrence server-wins, timer overlap kept) | 1 | `/sync/conflicts*`, conflict snapshots | M5-i2 `304419` | SY-03..SY-09 E2E/integration | — |
| K3 | §10.7/§10.8 | Idempotency (24 h replay), retry/backoff, quarantine after 5 hard failures, partial batch acks | 1 | `idempotency` table + middleware, queue retry | M5 | SY-02/SY-09 | — |
| K4 | §10.9 | Sync SLO (99% <5 s ack, integrity, zero silent loss) | 1 | SLO harness measured | M5-i3 `5eeda4b` | measured (SLO qualification) | Production SLO monitoring = ops (§21.4 gate) |
| K5 | §10.2 | Desktop SQLite store | 5 | — | — | — | With desktop app (deferred) |
| K6 | §4.1/§21.2 | "Full offline mode" parity (desktop offline editing) | 5 | — | — | — | Deferred by standing directive; web offline capture/edit IS delivered (K1/K2) |

### 1.12 Security & privacy (PRD §11)

| # | PRD | Requirement | Status | Where | Delivered by | Evidence | Gap |
|---|---|---|---|---|---|---|---|
| L1 | §11.3 | Object-level authorization on every read/write; personal owner role | 1 | authedRoute + service checks; isolation tests | M1 + M5 isolation specs | E2E security-boundary + isolation integration | — |
| L2 | §11.4 | OAuth tokens envelope-encrypted; secrets not in prod env; hashed tokens/keys | 1 | `db/secrets.ts` (KEK), M7 calendar token storage | M6-i3/M7 | integration | KEK rotation ops = deployment |
| L3 | §11.5 | Security headers (CSP nonce, HSTS, nosniff, referrer, permissions, CORS), zod at boundaries, sanitized rich text | 1 | `next.config.mjs`, contracts schemas, server-side sanitizer | M1 + M6 | E2E (headers) + build | — |
| L4 | §11.1 | Webhook signature verification + dedupe (billing, calendar channel token) | 1 | billing signature checks; calendar channel token = connection id | M6-i3, M7 | integration | Calendar channel token is the connection id (UUID) — documented accepted limitation; dedicated token column deferred to first unblocked live increment (M7 doc §6/§7.3) |
| L5 | §11.8 | ASVS L2 mapped verification, SAST/dependency/secret scanning in CI, container scanning, pen test, incident response | 3 | extensive security test suites (auth hardening, request-security, isolation, attachment scan gating) | M6 | CI suites | No formal ASVS checklist mapping doc; no SAST/secret-scan CI steps; no pen test (GA gate §21.7) |
| L6 | §11.9 | Privacy operations: export, deletion, retention (technical) | 1 | exports, account deletion, retention/purge | M6 | E2E | — |
| L7 | §11.9 | DPA, subprocessor list, DSAR workflow, breach-notification process, legal hold | 4 (ops/legal, out of repo) | — | — | — | Legal/ops artifacts; DSAR technical path (export) exists |

### 1.13 Reliability & operations (PRD §12)

| # | PRD | Requirement | Status | Where | Delivered by | Evidence | Gap |
|---|---|---|---|---|---|---|---|
| M1 | §12.4 | All seven jobs (recurrence, reminder, calendar, tracking, attachment, export, retention) with idempotency/retry/backoff/DLQ-equivalent | 1 | worker job registry (17 jobs incl. all seven) | M3–M7 | integration per job | — |
| M2 | §12.1 | SLO definitions + instrumentation | 3 | metrics endpoints, request IDs, health checks, capture-latency telemetry | M2/M6 | unit + E2E | No production SLO monitoring/dashboards; no 30-day SLO evidence (§21.4 public-beta gate) |
| M3 | §12.2/§12.3 | Backups, monthly restore tests, RTO/RPO | 6 | — | — | — | Requires production managed PG; §19.2 #14 ("restore tested") not yet satisfied |
| M4 | §12.5 | Feature flags/kill switches, canary, rollback procedure, deployment audit | 3 | backward-compatible SQL migrations w/ checksums + expand-migrate discipline | all milestones | migration integrity tests | No feature-flag system; canary/kill-switch unverified (§19.4 release gate) |
| M5 | §12.6 | Incident management, status page, on-call | 4 (ops) | — | — | — | Process/docs, not repo code; GA gate |
| M6 | §19.4 | k6 load tests, Lighthouse CI | 4 | M2 perf baseline (vitest-based) exists | M2 | measured | k6/Lighthouse not set up |

### 1.14 API surface (PRD §14.3) — route cross-check

All core endpoints exist with these deviations (each verified against the
route tree at `450fa38`):

| # | PRD endpoint | Status | Note |
|---|---|---|---|
| N1 | `POST /v1/billing/portal` | 5 | Deferred by recorded decision (M6-i3 doc: "deferred to a later milestone; no Razorpay portal equivalent invented") |
| N2 | `PATCH /v1/reminders/:id` (update) | 4 | create/cancel/snooze exist; post-creation time edit missing (minor) |
| N3 | `POST /v1/ai/suggestions` | 5 | AI deferred by standing directive |
| N4 | `GET /v1/tasks/:id/history` | 1 (path deviation) | provided by `/tracking/tasks/:id` (event history) + task-history (trash) view |
| N5 | `GET/POST /v1/workspaces` | 4 (minor) | only `/workspaces/[id]`; MVP is single-workspace (POST = Phase 2 concept) |
| N6 | `POST /v1/timers/:id/correct` | 1 (path deviation) | manual correction via timers service (`time.logged_manually` + audited adjustment) |
| N7 | `DELETE /v1/reminders/:id` | 1 (path deviation) | `POST /reminders/[id]/cancel` |
| N8 | Rate limits §14.8 | 1 | per-route limits in middleware (`rateLimitPerMinute`), 429 + Retry-After |
| N9 | Error schema §14.2, pagination §14.7, idempotency §14.4 | 1 | contracts + E2E |

### 1.15 Calendar (PRD §16)

| # | PRD | Requirement | Status | Where | Delivered by | Evidence | Gap |
|---|---|---|---|---|---|---|---|
| O1 | §16.1 | OAuth, calendar selection, import, export, bidirectional updates, change detection (push + 10-min poll fallback), manual sync, disconnect + revocation | 1 | `packages/calendar`, `calendar-sync.ts`, connections routes, webhook, `calendar.sync` job | M7-i1 `d58bf1e`/`2cdd528` | 5 §16.6 ACs + conflict + disconnect + tenant isolation, all CI-verified | Live verification = O2 |
| O2 | §16.1/§16.6 | Real Google provider verification | 6 | — | M7-i3 `450fa38` (CLOSED-BLOCKED) | preflight measured | no `GOOGLE_CLIENT_*`; egress to 3 Google hosts blocked; no long-lived public webhook host (M7 doc §5/§7.3) |
| O3 | §16.2 | Per-occurrence identity + deleted-event mirror cleanup (M7-i2 G1/G2) | 1 | `instance-key.ts`, import §3b | M7-i2 `511941f` | 16 new regression tests (797 total) | — |
| O4 | §16.7 | Outlook / CalDAV / Apple | 5 | — | — | — | PRD Phase 2 |

### 1.16 AI & voice (PRD §17)

| # | PRD | Requirement | Status | Where | Delivered by | Evidence | Gap |
|---|---|---|---|---|---|---|---|
| P1 | §17.1/§6.10 | Deterministic NL parsing (default path) | 1 | `core/nl-parse.ts` | M2-era | unit + E2E | — |
| P2 | §17.1 | LLM fallback parse + categorization/duplicate suggestions + basic execution summaries | 4 | no `/ai` routes, no provider abstraction | — | — | Deferred by standing directive (AI); §17.3 safety rules not implemented (nothing sends data externally today — a property, not a control) |
| P3 | §17.5 | Voice capture | 5 | — | — | — | PRD Phase 2 |

### 1.17 Monetization (PRD §18)

| # | PRD | Requirement | Status | Where | Delivered by | Evidence | Gap |
|---|---|---|---|---|---|---|---|
| Q1 | §18.1 | Entitlement model: server-configured limits, entitlement endpoint, client never grants | 1 | `effective-plan.ts`, `/account/entitlements`, per-mutation server checks | M6-i1 `f2fff2c` | integration + E2E | — |
| Q2 | §18.2/§18.3 | Provider-agnostic billing core (Stripe + Razorpay): state machine incl. PAST_DUE/GRACE, signature-verified idempotent webhooks, nightly reconciliation, downgrades read-only, no data deletion | 1 | `packages/billing`, billing jobs | M6-i3 `89b5624` | unit (state machine) + integration | Live test-mode verification = Q3 |
| Q3 | §18.3 | Live provider verification (test mode) | 6 | — | M6-i4 `d771424` (CLOSED-BLOCKED) | preflight measured | no provider keys; egress to Stripe/Razorpay APIs blocked |
| Q4 | §14.3 | Billing portal (self-serve management) | 5 | — | — | — | Recorded deferral (M6-i3); user cancellation/payment-method changes not self-serve in-app today |
| Q5 | §2.11 | Pricing validation experiments | 4 (business) | — | — | — | Out of engineering scope |

### 1.18 Testing & quality gates (PRD §19)

| # | PRD | Requirement | Status | Where | Evidence | Gap |
|---|---|---|---|---|---|---|
| R1 | §19.1 | Unit/component/integration/E2E/contract/a11y suites in CI | 1 | turbo + vitest + Playwright + axe in CI | 797/797 + E2E 147, CI green at `450fa38` | — |
| R2 | §19.2 | Required acceptance tests #1–#13 | 1 | mapped across M5/M6/M7 E2E + integration | all cited per-area above | — |
| R3 | §19.2 #14 | "Database restore has been tested successfully" | 4 | — | — | GA gate; see M3 row (restore capability) |
| R4 | §19.3 | Sync scenario matrix SY-01..SY-10 | 1 | M5-i2/i3 | matrix green in CI | — |
| R5 | §19.1 | k6 load tests, Lighthouse CI | 4 | — | — | see M6 row |

### 1.19 Analytics & instrumentation (PRD §20)

| # | PRD | Requirement | Status | Where | Evidence | Gap |
|---|---|---|---|---|---|---|
| S1 | §20.1/§21.3 | Product telemetry (capture latency; content-free, validated) | 1 | `/telemetry/capture`, domain event catalog | unit + E2E | Activation-funnel event pipeline + warehouse = ops (post-launch data work) |
| S2 | §20.3 | Metric definitions | 1 (definitions) / 4 (production measurement) | tracking rollups compute the core metrics | — | Cohort/retention measurement needs production data |

### 1.20 Desktop (PRD §4.1, §9.1, §9.3, PD-07)

| # | PRD | Requirement | Status | Where | Evidence | Gap |
|---|---|---|---|---|---|---|
| Z1 | §4.1/§9.1 | Windows desktop app (Tauri): SQLite store, global shortcut, native notifications, offline operation, OS credential storage, auto-update | 5 | no `apps/desktop` | — | **PRD Phase-1 item deferred by standing user directive** ("desktop deferred; never fake offline"). This is the single largest PRD-vs-directive divergence in the matrix: the PRD lists desktop in Phase 1 / Milestone 5; the directive defers it. Reinstating requires an explicit decision. |

## 2. Externally blocked work (separate inventory)

| # | Work | Blocker (measured) | What unblocks | Reference |
|---|---|---|---|---|
| X1 | Live Google Calendar verification (16-point pass) + M7 hardening candidates (channel-token column, rate-limit backoff) | no `GOOGLE_CLIENT_ID/SECRET`; egress to `accounts.google.com`, `oauth2.googleapis.com`, `www.googleapis.com` blocked (SSL_ERROR_SYSCALL, probed 2026-09-14); no long-lived public host for `/api/v1/calendar/webhook` | OAuth client + redirect allow-list + env vars + egress + public host | M7-i3 `450fa38`, M7 doc §7.3 |
| X2 | Live billing verification (Stripe + Razorpay test mode) | no provider keys; egress to Stripe/Razorpay APIs blocked | test-mode keys + egress | M6-i4 `d771424`, M6 completion report |
| X3 | Production email delivery verification | no SMTP configured; production mode fails explicitly by design | SMTP provider + credentials | mailer contract (M6) |
| X4 | Production reliability gates: 30-day SLO evidence, backup/restore tests, pen test, k6 staging load, status page, incident runbooks | require production infrastructure and calendar time, not repo code | production deployment + ops setup | PRD §12, §19.4, §21.4 |

## 3. Consolidated milestone index

| Milestone | Scope | Commit | Status |
|---|---|---|---|
| M1 | Foundation, auth, task core | M1 ledger entries (Phase 1) | CLOSED |
| M2 | Task management UX: filtering, bulk, virtualization, location, rich description, calendar view, exports, NL capture, instrumentation | M2-era milestone docs | CLOSED |
| M3 | Planning/execution: focus timer, recurrence, reminders, capacity planning (incl. tz defect fix) | M3 docs; M5 closeout note | CLOSED |
| M4 | Tracking & analytics: durability, scoring, corrections, reporting, project analytics | M4 docs | CLOSED |
| M5 | Cross-platform reliability: sync protocol v1, offline capture (IndexedDB), conflict UI, SY-01..SY-10, SLO qualification | i1 `6ae9cf9`, i2 `304419`, i3 `5eeda4b` | CLOSED |
| M6 | Commercial readiness: entitlements, attachments+ClamAV, billing core (live blocked), account deletion, sessions, retention, closeout+a11y | i1 `f2fff2c` … i8 `6c36100` (i4 `d771424` CLOSED-BLOCKED) | CLOSED |
| M7 | Google Calendar two-way: i1 `d58bf1e`/`2cdd528`, i2 `511941f` (G1/G2), i3 `450fa38` (CLOSED-BLOCKED preflight) | — | i1/i2 CLOSED; i3 CLOSED-BLOCKED |

Current baseline: `450fa38` — vitest 797/797, E2E 147 (ClamAV local exception by design), coverage gate green, typecheck/lint/build clean, CI green on push + PR.

## 4. Recommendations

### 4.1 Highest-value remaining MVP requirement

**Browser push notifications (Web Push) — PRD §6.6 delivery channel.**

Reasoning:
- It is the only clearly-MVP **product requirement** that is unimplemented and not deferred: §6.6 names "browser notification" as an MVP reminder channel; the entire reminder engine (lifecycle, dispatch, snooze, expiry, in-app + email) already exists — only the browser channel and its subscription plumbing are missing.
- It directly serves the core loop (step 4 "execute it using reminders") — reminders that only arrive while the app is open materially weaken the differentiator for deadline-driven users (§2.4 ICP).
- It is bounded and fully CI-verifiable: service worker + VAPID subscription endpoint + `push` delivery through the existing `mail.deliver`-class durable channel, with a deterministic push-service stub for E2E (no live-provider blocker, unlike X1–X3).
- The schema hook already exists (`device_registrations`), so no cross-cutting change is forced.
- The other candidates were considered and ranked below it: §5.5 advisory suggestions (J8) — higher product value but materially vaguer scope (heuristic engine with no PRD acceptance criteria; the AI-bound variant is deferred); billing portal (Q4) — already a recorded deferral decision, so it is category 5, not a gap; reminder-update endpoint (N2) and workspaces-list (N5) — minor, foldable into any nearby increment; wellbeing settings panel (J6) — real but small; §19.4 release-gate ops (X4) — high value for GA but operational, not a product requirement, and partly outside the repo.

### 4.2 Proposed M8-i1 — "Browser push notification channel" (not started this turn)

**Exact requirement (PRD anchors):** §6.6 ("Channels: browser notification … (MVP where enabled)"; delivery status exposed to the user), §6.6 ACs (no double delivery per `(reminder_id, channel)`; cancellation on completion; 24 h expiry), §9.3 (notification service channel abstraction), §11.1 (webhook/push integrity), §13.2 (`device_registrations`), §12.4 (job idempotency/retry/DLQ behavior), §14.8 (rate limits).

**Scope (bounded):**
1. Subscription lifecycle: subscribe/unsubscribe endpoints (VAPID; public key delivered via a stable endpoint), `device_registrations` population with per-user scoping, dedupe on `(user, endpoint)`.
2. Web Push delivery as a new channel in the reminder/notification dispatch path: durable, idempotent per `(reminder_id, 'push')`, respects existing CANCELED/EXPIRED gating, retries with backoff, marks `FAILED` with delivery status visible in the notifications center (PRD: "must expose delivery status").
3. Service worker + subscription bootstrap in the web app, gated on browser support and an explicit user opt-in (notification permission); no background activity.
4. Failure semantics: push subscription gone (404/410) → registration removed, reminder not lost (other channels still fire); provider failure → `FAILED` status + retry per §12.4, never silent.
5. Security: VAPID claims minimal; subscription tokens never logged; endpoint auth on register/unregister; rate limits per §14.8.

**Acceptance criteria (deterministic, CI-verifiable):**
1. E2E: user opts in, subscribes, a reminder due in-window is delivered through the stub push service; the notification center shows the delivered push with status `SENT`.
2. Completing the task cancels pending reminders and no further push is emitted (existing ≤30 s AC extended to the push channel).
3. The same reminder is never pushed twice for the same `(reminder_id, channel)` (replay of dispatch is a no-op) — idempotency test.
4. A reminder >24 h overdue transitions to `EXPIRED` and produces no push.
5. Unsubscribing (or a 410 from the push endpoint) removes the registration; the reminder still delivers via remaining channels and the push registration is gone.
6. Tenant isolation: a subscription registered for user A is never used for user B's reminders (integration test with two users).
7. Browser-without-support path: the app degrades silently (no service worker registration attempted beyond feature detection); in-app + email channels unaffected (regression).
8. No existing test weakened or deleted; full suite green (797+ n), E2E green, coverage gate, typecheck, lint, build, CI green on push + PR.

**Explicitly out of scope:** desktop notifications (with Z1), Web Push for non-reminder notifications, push-message deep-link redesign, mobile, any AI, any Phase-2 item.

### 4.3 Alternative (if GA-readiness is prioritized over product)

M8-i1 = "Release-gate ops increment": CI-based database backup/restore test (satisfies §19.2 #14 with embedded PG), SLO measurement harness extension + dashboards-as-code, k6 baseline load test, status page + incident runbook docs. Higher release value, lower product value; most of it is X4 (external/ops) and would remain partially blocked on production infra.

### 4.4 Phase-2 boundary confirmation

No Phase-2 item (collaboration, comments/mentions, custom states/fields, rule language, smart scheduling, automations, voice, Outlook/CalDAV, public API, mobile, passkeys, SSO/SCIM, marketplace) was implemented, promoted, or partially started by any milestone; the matrix keeps all such items at status 5 with PRD citations. The only PRD-Phase-1 items not delivered are Z1 (desktop — deferred by directive) and F3 (browser push — the M8-i1 recommendation), plus the minor N2/N5 route gaps and J3/J8 advisory-suggestion gap.
