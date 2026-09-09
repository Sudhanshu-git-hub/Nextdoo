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

The latest authorization expands to **remaining core online workflows and non-AI/
non-billing MVP gaps**, prioritizing broken/incomplete notifications/durable jobs,
tracking/analytics, export/deletion, entitlement/authorization and task management.
AI, billing integration, desktop and full offline mode remain excluded.

The current locally verified milestone is **durable tracking and freshness**:
[TRACKING_DURABILITY_MILESTONE.md](TRACKING_DURABILITY_MILESTONE.md). Final local
validation: **422 tests in 46 files and 75 browser/API scenarios**, lint, typecheck,
coverage and build passed; migrations 0013/0014 and replay passed; dependency audit
zero. Remote CI is checked on the pushed commit and reported at milestone closure.
This closes the bounded durable-evaluation/freshness slice, **not all M4 or Phase 1**.

The prior [in-app notification milestone](NOTIFICATION_DELIVERY_MILESTONE.md)
remains verified within its documented scope. Existing task/bulk, board, recurrence,
workspace, notification and data-integrity acceptance was retained in the full run.

## Milestone status: evidence rather than percentage complete

| PRD milestone | Working, tested foundation | Remaining completion work |
|---|---|---|
| M1 Foundation | Authentication/recovery/MFA/session and tenant guards; migrations; HTTP conventions; shell; local CI-equivalent gates | Production email delivery; distributed rate limiting; complete tracing/metrics and alert verification; staging/rollback qualification |
| M2 Core task management | Online capture/editor, tags/priority/due/estimate, projects/lifecycle, sections/board with optimistic movement and rollback, subtasks/dependencies, archive/Trash/recovery, query filters/sorts, atomic bulk commands; owner-managed workspace defaults; free-text task `location` end to end (contracts, services, sync writable field, recurrence inheritance, editor) per [TASK_LOCATION_MILESTONE.md](TASK_LOCATION_MILESTONE.md); windowed list rendering above 200 loaded rows (virtualization, PRD §6.9) per [TASK_VIRTUALIZATION_MILESTONE.md](TASK_VIRTUALIZATION_MILESTONE.md) | Rich description editor and complete task-field UX; collection scalability; required capture/mutation instrumentation and core performance/a11y acceptance |
| M3 Planning and execution | Workspace-local week task calendar/movement and Today, configured overnight workday guideline, focus/time workflows, durable in-app notifications, reminder status/history/read/snooze/cancel and bounded isolated dispatch retries, complete/reschedule; bounded recurrence generation, future rule edits, occurrence lifecycle and retries | Day/month calendar and full calendar pagination; complete provider-aware capacity planning; offline timers; real browser/background push and enabled reminder email delivery; desktop delivery remains excluded from current work |
| M4 Tracking and analytics | Ordered append-only events, shared versioned engine, durable outbox consumer/queue with fenced leases and five retries, due/cohort freshness, immutable input/history drilldown, owner single-task re-evaluation, numeric-score visibility and live UTC task/project summaries | Date-range recalculation and full corrections/review workflows; independent tracking/wellbeing controls and retention policy; workspace-local reporting and richer trends; unresolved TR-03/full TR matrix; routed alerts and sustained freshness/load SLO qualification |
| M5 Cross-platform reliability | Server push/pull/version/tombstone protection; scoped IndexedDB queue primitives and Today cached fallback | UI enqueue/reconcile/recovery and conflict views; full SY-01–SY-10 across devices; 5,000 mutation drain; Windows Tauri/SQLite/WebView2 client, notifications, packaging/signing/update/rollback |
| M6 Commercial readiness | Server entitlement limits; authenticated JSON export with legacy notification-reference privacy guards; reauthenticated deletion/grace/purge; audit trail; asynchronous expiring JSON/CSV exports (bounded worker generation, signed 24-hour downloads, plan quota plus durable hourly limit, purge-aware artifact deletion) per [DATA_EXPORT_MILESTONE.md](DATA_EXPORT_MILESTONE.md) | Real Google Calendar two-way OAuth/sync/revocation; provider billing/webhooks/refunds/reconciliation; attachments/upload/scan/download gating; support/status/dashboards and operational acceptance |

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
- Tracking now uses a shared DB engine and actual `outbox.relay`,
  `tracking.reconcile` and `tracking.evaluate` jobs. Persisted attempt leases,
  crash/restart and stale-token fencing are tested, not inferred from table presence.
  The web fast path is savepoint-isolated. A per-consumer receipt does not falsely
  mark unrelated outbox consumers delivered; those integrations remain open.
- Workspace/project summaries retain their current UTC/current-task cohorts and
  expose matching-cohort freshness. Task evidence is paginated; failed recovery
  preserves reasons, idempotency identity and prior history. Per-task re-evaluation
  does not substitute for the still-open date-range corrections workflow.
- The repository has `apps/web` and `apps/worker`, not an implemented Windows app.
- Calendar/billing/attachment database tables and optional environment names exist,
  but their required real workflows are not implemented. Configuration names are
  not provider acceptance evidence.
- Account export is an authenticated synchronous download, not a 24-hour hosted
  expiring object. Notification/read state is exported; malformed legacy cross-tenant
  notification content is excluded/redacted. Linked notification/reminder purge is
  tested, but these tests are not a backup restore drill.
- Reminder dispatch is now per-recipient transactional and bounded, with retry/failure
  state and a real in-app notification center. WEB / SENT is explicitly a database
  receipt, not browser push or SMTP acknowledgement. External channels stay disabled.

## Required §19.2 acceptance checklist

| # | Acceptance condition | Current disposition |
|---|---|---|
| 1 | Offline create then sync | OPEN: no complete client enqueue/reconcile flow |
| 2 | Duplicate mutation does not duplicate task | Bounded server/HTTP/sync tests pass; full cross-platform acceptance open |
| 3 | Completion appears on another device | Server delta tested; complete connected-client reconciliation open |
| 4 | Conflicting titles preserve both versions | Server/queue storage evidence; complete conflict recovery UI open |
| 5 | Worker retries do not duplicate recurrence | Tested locally: concurrent real-DB generation, due-state recheck, HTTP replay and lost-ack retry; production/load qualification remains open |
| 6 | Completion cancels reminders | Tested single-task/sync/bulk paths and reminder creation/dispatch races; pending reminders cannot survive completion. In-app delivery verified; native/provider delivery remains open |
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

1. **Verified in-app notification/reminder slice:** retain the new delivery identity,
   retry/rollback, tenant/deletion guards and user-visible history. External channels,
   automatic connected-client updates and production SLO/alert exercises remain open.
2. **Verified durable tracking/freshness slice:** retain ordered ingestion, real
   bounded workers, durable retry/claim recovery, visible freshness and paginated
   source/result evidence. Remaining M4 work includes date-range recalculation,
   workspace-local summaries, richer review and approved controls/corrections.
   **Resolve the tracking policy decisions below before changing those semantics**;
   current score math and cohorts have deliberately not been changed.
3. **Data rights, limits and authorization:** verify/reinforce existing export quotas,
   account deletion and permission boundaries. **Delivered:** asynchronous, expiring
   JSON/CSV exports with reviewed storage/expiry design and real integration evidence —
   see [DATA_EXPORT_MILESTONE.md](DATA_EXPORT_MILESTONE.md) (bounded `export.generate`
   and `exports.expire` worker jobs with claim/lease fencing, signed 24-hour download
   tokens, FREE 1/day quota plus durable 3-per-hour limit, tenant-scoped reads, artifact
   deletion on expiry and account purge; 9 integration regressions and 4 browser E2E
   verified). Retention, backup deletion and distributed limits still need
   operational resources.
4. **Remaining task/planning UX:** **Delivered:** free-text task `location`
   end to end — migration 0016, shared contracts, create/update/read services,
   sync writable field, recurrence occurrence inheritance, editor UI, 6
   integration regressions and 4 browser E2E verified; see
   [TASK_LOCATION_MILESTONE.md](TASK_LOCATION_MILESTONE.md). Windowed list
   rendering above 200 loaded rows (PRD §6.9 virtualization) — pure window
   math with unit tests, measured heights, focus pinning, unchanged
   ordering/pagination/actions/selection, ≤200 rendering byte-identical, 6
   browser E2E verified; see
   [TASK_VIRTUALIZATION_MILESTONE.md](TASK_VIRTUALIZATION_MILESTONE.md).
   Remaining: rich description editor and complete task-field UX, complete
   calendar pagination and day/month views. Preserve the delivered board,
   relationships, recurrence and workspace semantics; qualify
   accessible/performance acceptance rather than checking off a route or
   schema.
5. **Enabled external online integrations:** browser/background notifications and
   reminder email, Google Calendar and scanning-gated attachments require provider,
   deployment and privacy decisions plus real test resources. No fake delivery,
   storage/scanning result or disconnected OAuth workflow counts as acceptance.
6. **Operational qualification:** tracing/metrics/alerts, distributed rate limiting,
   staging, restore/rollback drills and elapsed-time SLO evidence remain required.

The expanded authorization permits incremental non-AI/non-billing online work. It
**does not permit AI, billing integration, desktop or full offline mode**. Those
remain PRD backlog, not next actions under this request.

Commit and push each independently buildable verified increment on the session
branch. Re-run full gates before milestone closure. Keep historical reports intact,
record each failure and fix, and stop for unresolved product choices rather than
silently choosing new semantics. No artificial completion percentage or ETA is given.

## Decisions and external prerequisites still needed

These do not block all local engineering, but they do block honest full Phase 1
acceptance and must be resolved before implementing their affected semantics:

- **Workspace workday decision resolved:** overnight ranges are supported with
  an explicit next-day label; equal times are rejected. Nominal hours are not a
  promise of elapsed capacity. See the workspace settings report.
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
