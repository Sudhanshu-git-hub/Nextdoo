# Phase 1 completion ledger and remaining execution plan

Date: 2026-09-09 (Asia/Calcutta). **Status: incomplete — not ready to declare the
Paid-Quality MVP finished.** The user has requested the next increment and full
Phase 1 completion. This ledger preserves that goal; it does not redefine Phase 1
as only core tasks or drop previously deferred required integrations.

## Source and decision boundaries

PRD v1.1 §4.1, §19 and §21 are the acceptance authority. The working PRD and local
`origin/main:docs/PRD.md` were compared and both have SHA-256
`0a1ebd90a31eb88f437352959209251046183c18142599f39918200401019c34`.
The PRD has not been rewritten. Retain Next.js, `/api/v1`, camelCase, current
pagination, the fixed Arena branch, immutable migrations and all recovered features.

The current increment delivers **online recurrence**, on top of previously verified
boards/sections, subtasks/relationships and atomic bulk task commands. The latest
user authorization is explicitly bounded: boards → subtasks → recurrence → personal
workspace settings; do not start AI, billing, desktop or full offline mode. Recurrence
DST and preserve-generated-history decisions were confirmed by the user. Evidence:
[TASK_RECURRENCE_MILESTONE.md](TASK_RECURRENCE_MILESTONE.md), **386 unit/integration
and tooling tests, 57 browser/API scenarios**, full local gates green. The earlier
bulk milestone's 363/50 evidence remains historical, not the current suite count.
This is bounded behavior verification, not full acceptance of every row below.

## Milestone status: evidence rather than percentage complete

| PRD milestone | Working, tested foundation | Remaining completion work |
|---|---|---|
| M1 Foundation | Authentication/recovery/MFA/session and tenant guards; migrations; HTTP conventions; shell; local CI-equivalent gates | Production email delivery; distributed rate limiting; complete tracing/metrics and alert verification; staging/rollback qualification |
| M2 Core task management | Online capture/editor, tags/priority/due/estimate, projects/lifecycle, sections/board, subtasks/dependencies, archive/Trash/recovery, query filters/sorts, atomic bulk commands | Rich descriptions/location and complete task-field UX; list virtualization above 200; collection scalability; required capture/mutation instrumentation and core performance/a11y acceptance |
| M3 Planning and execution | Week task calendar/movement, focus/time workflows, reminders with durable DB/SMTP foundations, complete/reschedule; bounded recurrence generation, future rule edits, occurrence lifecycle and retries | Day/month calendar and full calendar pagination; workspace-local planning settings/capacity; offline timers; real browser/desktop delivery and snooze/status acceptance |
| M4 Tracking and analytics | Append-only task events, inline calculation/input snapshots, Unmeasured handling, task/project summaries and project analytics | Source-event drilldown/corrections/backfill; independent score/tracking/wellbeing controls; workspace-local daily/weekly reporting; review UX and full TR matrix; durable jobs/consumer and freshness/telemetry qualification |
| M5 Cross-platform reliability | Server push/pull/version/tombstone protection; scoped IndexedDB queue primitives and Today cached fallback | UI enqueue/reconcile/recovery and conflict views; full SY-01–SY-10 across devices; 5,000 mutation drain; Windows Tauri/SQLite/WebView2 client, notifications, packaging/signing/update/rollback |
| M6 Commercial readiness | Server entitlement limits; authenticated JSON export; reauthenticated deletion/grace/purge; audit trail | Real Google Calendar two-way OAuth/sync/revocation; provider billing/webhooks/refunds/reconciliation; attachments/upload/scan/download gating; expiring CSV/JSON exports; support/status/dashboards and operational acceptance |

### Specific current implementation evidence

- Recurring creation is atomic; the shared DB generator, scheduled worker,
  lifecycle APIs, confirmation UI and paginated series management now have real-DB
  and browser evidence. Snapshot-less legacy scaffold rows remain unscheduled.
  Generic sync explicitly rejects recurrence commands; offline recurrence is not claimed.
- `QuickCapture.tsx` currently sends HTTP parse/create requests; keeping failed text
  in the input is not durable offline capture. `use-task-pages.ts` limits cached
  fallback to Today semantics. New filtering/bulk does not claim offline parity.
- `CalendarView.tsx` is a week grid and requests up to 100 tasks without continuation.
  It is not day/week/month provider-aware capacity planning.
- `services/tracking.ts` calculates inline. `apps/worker/src/jobs.ts` explicitly
  reports `NO_CONSUMER_REGISTERED` for unhandled outbox events instead of falsely
  marking them delivered. A tracking result row is not a qualified durable pipeline.
- The repository has `apps/web` and `apps/worker`, not an implemented Windows app.
- Calendar/billing/attachment database tables and optional environment names exist,
  but their required real workflows are not implemented. Configuration names are
  not provider acceptance evidence.
- Account export is an authenticated synchronous download, not a 24-hour hosted
  expiring object. Existing account purge tests are not a backup restore drill.

## Required §19.2 acceptance checklist

| # | Acceptance condition | Current disposition |
|---|---|---|
| 1 | Offline create then sync | OPEN: no complete client enqueue/reconcile flow |
| 2 | Duplicate mutation does not duplicate task | Bounded server/HTTP/sync tests pass; full cross-platform acceptance open |
| 3 | Completion appears on another device | Server delta tested; complete connected-client reconciliation open |
| 4 | Conflicting titles preserve both versions | Server/queue storage evidence; complete conflict recovery UI open |
| 5 | Worker retries do not duplicate recurrence | Tested locally: concurrent real-DB generation, due-state recheck, HTTP replay and lost-ack retry; production/load qualification remains open |
| 6 | Completion cancels reminders | Tested single-task/sync paths and now atomic bulk; real notification delivery remains separately open |
| 7 | Calendar disconnect deletes OAuth credentials | OPEN: real provider workflow absent |
| 8 | Client cannot grant billing access | Local entitlement guards tested; actual billing/webhook acceptance open |
| 9 | Deleted accounts cannot authenticate | Tested status/grace/purge paths; broader operational retention still open |
| 10 | Export objects expire and become inaccessible | OPEN: current direct download does not satisfy hosted export expiry |
| 11 | Malware blocks unsafe attachment downloads | OPEN: scanner/storage flow absent |
| 12 | Missing analytics inputs show Unmeasured | Bounded calculation/pipeline tests pass; full controls/correction matrix open |
| 13 | All critical flows keyboard accessible | Selected keyboard/axe flows pass; full manual/screen-reader/platform gate open |
| 14 | Successful database restore | NOT VERIFIED: migration tests do not satisfy this |

Do not mark partial server evidence as the full browser/device scenario. Do not
alter SY-09 partial sync semantics to match the distinct user-confirmed atomic bulk
command. All release gates in §19.4 remain required, not only this checklist.

## Execution order from here

1. **Current authorized next milestone: personal-workspace settings/management.**
   Review workday-hour validation (same-day versus overnight), then implement the
   existing workspace fields/API/UI with tenant/version/idempotency and regression
   gates. Boards/sections and subtasks are retained; recurrence is now verified.
   Rich-task completion, virtualization and broader planning remain backlog, not
   permission to expand this increment.

The following steps remain the broader Phase 1 backlog, **not authorization to
start AI, billing, desktop, full offline mode or other deferred integrations now**:

2. **Finish execution and review:** complete calendar views/pagination/capacity and
   reminder/time workflow acceptance; implement reviewed score controls, source
   event correction/backfill and local-time reports with explicit TR matrix evidence.
3. **Complete offline web:** repository-backed UI capture/edit, durable request
   recovery, pull reconciliation and conflict UI; run all ten sync scenarios,
   including skew, delete/edit, timer overlap and large-queue drain. Only then build
   the Windows adapter/client against the same proven protocol.
4. **Deliver real integrations in isolated slices:** scanning-gated object storage
   and expiring exports; Google Calendar sandbox OAuth/two-way sync/disconnect;
   verified billing/webhooks/refunds/reconciliation. Require actual sandbox/provider
   evidence, not mock-only tests or UI placeholders.
5. **Qualify operations and release:** staging deploys, full contract/security/a11y
   and performance gates, distributed rate limits, observability/alert exercises,
   encrypted backup restore and rollback drills, Windows/WebView2/update tests,
   provider delivery and retention checks. Collect the PRD's required elapsed-time
   SLO and beta evidence; it cannot be manufactured by a local test run.

Commit and push each independently buildable verified increment on the session
branch. Re-run full gates before milestone closure. Keep historical reports intact,
record each failure and fix, and stop for unresolved product choices rather than
silently choosing new semantics. No artificial completion percentage or ETA is given.

## Decisions and external prerequisites still needed

These do not block all local engineering, but they do block honest full Phase 1
acceptance and must be resolved before implementing their affected semantics:

- **Workspace workday policy:** confirm whether configured hours can cross
  midnight before implementing the next settings milestone.
- **Recurrence decisions resolved:** gaps shift by the clock transition, folds use
  the earlier instant, generated history is preserved and revised rules start after
  the generated range. See the recurrence report for bounds and acceptance evidence.
- **Tracking/review policy:** resolve carried-forward TR-03 example preconditions
  (available weight 0.80 versus 0.65), review page/email choice, visibility versus
  retention policy, independent wellbeing settings and external-calendar capacity
  context. Do not change score math just to make an ambiguous example green.
- **Provider/deployment choices and test resources:** confirm billing provider
  (the environment currently anticipates Stripe), storage/scanner/region,
  SMTP sender, Google OAuth consent/scopes/callback domain, and staging deployment.
  Configure approved sandbox accounts/secrets using environment/secret management,
  never chat or tracked files. No purchase, live charge or production mutation is
  authorized merely by asking for feature completion.
- **Windows acceptance resources:** supported Windows/WebView2 test environment,
  signing/update infrastructure and a reviewed offline-history extent. Linux
  Chromium tests cannot establish Windows desktop acceptance.
- **Operational ownership:** monitoring/status/on-call, retention/privacy review,
  backup credentials and restore targets, provider verification, beta participants
  and SLO observation. PRD §21.4/§21.7's elapsed-time release evidence remains open.

Phase 2 collaboration/voice/mobile/advanced automations are still excluded. AI model
fallback is not substituted for the deterministic parser, and no model/provider
processing or automatic destructive action is introduced by this plan.
