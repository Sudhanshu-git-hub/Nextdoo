# Durable tracking and freshness — acceptance report

Date: 2026-09-09 (Asia/Calcutta). Scope: the durable evaluation/freshness increment
selected after in-app notifications. **This is not full M4 or Phase 1 completion.**
The PRD, score weights, current-task cohorts and UTC reporting windows are unchanged.

## Delivered workflow

1. Task changes and append-only tracking events invalidate a workspace-scoped
   `tracking_jobs` revision **inside the domain transaction**. Database triggers
   cover web commands, timers, bulk operations and the standalone recurrence
   generator; a queue/invalidation failure rolls back the domain transaction.
2. `outbox.relay` delivers supported task/timer envelopes to the PostgreSQL job
   queue and commits a per-consumer receipt. Delivery is replay-safe. Other
   consumers are **not** acknowledged through `outbox.published_at`.
3. `tracking.reconcile` repairs unqueued invalidations and schedules time-boundary,
   recurrence-cohort and engine-version evaluation in bounded batches. A recurrence
   revision invalidates every affected member without a synchronous full-series
   rewrite. Candidate selection rotates through workspace/day buckets.
4. `tracking.evaluate` persists an attempt and a two-minute claim lease, then uses
   the shared DB engine under workspace, owner, task and job locks. A claim token
   and input revision fence a delayed worker after replacement or a newer mutation.
5. The engine reads the **complete** scoped event stream in 200-event pages and
   combines it with the authoritative task/occurrence projection. Existing event
   payloads are not sufficient for a pure event-sourced rebuild, so this does not
   pretend otherwise. Unknown tracking-event schema versions fail visibly.
6. A new immutable result, its input snapshot, freshness checkpoint, queue
   acknowledgement and `tracking.result_created`/`tracking.result_recalculated`
   outbox event commit together. Identical active inputs reuse the original result;
   changed inputs supersede it without rewriting its contents. Occurrence keys,
   source-event hash/count/watermark, task version and prior-result ID are retained.
7. Daily/weekly and project aggregates remain **read-time, repeatable-read
   snapshots**, not materialized caches. They therefore use the new active result
   on the next read, including after due-date/project movement. Freshness counts
   cover the same task cohort as the existing score and time aggregates.

The existing immediate-result behavior remains a **best-effort fast path**. Its
savepoint isolates calculation failure: valid task work, source events and durable
invalidation can still commit. A failed fast path is not a consumed worker attempt.
Domain validation, enqueue and audit failures still retain their atomic semantics,
including all-or-nothing bulk task actions.

### Ordering and idempotency

- New events have a database ingestion ordinal, bounded to JavaScript's safe integer
  range. Application mutation producers serialize through workspace locks. Client
  timestamps do not determine accepted processing order.
- Task-event identities now include the accepted task version; timer start/pause
  identities use their session/transition identity. Distinct commands at the same
  timestamp no longer disappear. Reopening and completing again with the same
  completion instant is distinct from replaying the original completion.
- Legacy ordinals were assigned by migration. They **do not reconstruct historical
  commit order**, and events previously lost through timestamp-key collisions are
  not invented or repaired retroactively.
- Calculation version **2** identifies scoped stream hashing/input provenance;
  mathematical weights and normalization remain unchanged. Old calculation
  versions and snapshots remain queryable.
- Consumer receipts and result lookup make out-of-order envelope delivery and
  concurrent/restarted workers harmless. A stale worker cannot publish an older
  input snapshot over newer work.

## Freshness and recovery contract

A result is `FRESH` only when its recorded task/event revision, recurrence-cohort
revision and calculation version match current inputs, its next time boundary has
not passed, and there is no recorded error or expired claim. Other states are
`PENDING`, `RETRYING` and `FAILED`; `processing` distinguishes a live claim from a
scheduled retry. A live sixth attempt is not prematurely reported as exhausted.

- Freshness uses the database clock. SQL claim/retry eligibility retains PostgreSQL
  precision rather than comparing a truncated JavaScript timestamp to a DB claim.
- Existing numerical fields remain stored values for compatibility. **Consumers
  must read freshness**; stale values are not relabeled as current calculations.
  The UI explicitly labels previous results and incomplete/stale aggregate scores.
- Missing or pending computation is not fabricated as zero or as `Unmeasured`.
  `Unmeasured` remains a legitimate computed outcome/component.
- Six durable attempts means **the initial attempt plus five retries**. Caught
  failures back off 1, 2, 4, 8 and 15 minutes. An interrupted process has already
  consumed its attempt; after lease expiry, recovery applies that attempt's backoff
  from the expiry time. Late recovery does not add an unnecessary new waiting period.
- A successful evaluation clears failure/claim state. New input generations or an
  explicit owner request reset the retry budget; an unchanged exhausted generation
  is not automatically rearmed by reconciliation.
- Expired leases are visible as stale even before the recovery worker runs. Durable
  failure codes and support references survive process restarts. Worker logs emit
  retry/exhaustion records using opaque IDs, not task content or raw SQL errors.
- Soft-deleted tasks and deleted/suspended/deletion-requested owners are not
  evaluated. Restored/newly changed work can be evaluated again. Account purge
  cascades the new queue/receipt metadata with the existing domain retention flow.

### User experience and API

Use a task's **Tracking** link or **Analytics → Tracking status and evidence**.
The status list is paginated and can show all tasks, non-current tracking, or
exhausted retries. Task status and workspace/project summaries refresh every five
seconds while visible. Evidence is a separately refreshed snapshot with resumable
source-event and calculation-history pagination.

The owner can request re-evaluation with a reason. CAS guards the tracking revision;
request replay uses the existing durable idempotency mechanism. A lost acknowledgement
keeps the reason and command identity. Explicit post-command refresh replaces an
older pending poll instead of allowing that response to block/overwrite recovery.
Failures retain previously loaded evidence and expose retry/request-ID affordances.

| Endpoint | Contract |
|---|---|
| `GET /api/v1/tracking/summary` | Existing cohort/metrics plus freshness counts; disabled numeric score omitted |
| `GET /api/v1/projects/:id/analytics` | Existing read-only report plus matching-cohort freshness |
| `GET /api/v1/tracking/status` | `filter=all\|attention\|failed`, scoped cursor, 25 tasks/page |
| `GET /api/v1/tracking/tasks/:id` | Result, freshness, source events (50/page), immutable history (25/page); separate scoped cursors |
| `POST /api/v1/tracking/tasks/:id/recalculate` | Required tracking `revision`, nonblank `reason` (max 500), idempotency key and trusted origin |

Task detail returns 404 for foreign/deleted tasks. Cursor scopes bind workspace,
resource and filter. With `disableScores`, summaries omit the numeric score and
result/explanation/history payloads are empty without a permission error. This
preserves the existing visibility preference; it does **not** stop event collection
or define a new retention policy.

## Bounds, deployment and operations

Apply **0013 and 0014** before deploying the new web/worker code. Both are forward-only,
checksum-verified migrations. Deploy compatible web and worker versions together;
large-table migration duration and rolling production deployment are not qualified
by local tests.

Run the standalone worker against the same database as the web application.
`outbox.relay`, `tracking.reconcile` and `tracking.evaluate` each run at boot and on
a 10-second polling interval. Their phases may overlap; correctness does not rely
on their timing/order.

- Relay: at most 100 envelopes/pass; reconciliation/evaluation/lease recovery:
  at most 25 records/pass. Workspace rotation reduces single-workspace starvation.
- Reconciliation's default engine-upgrade/bootstrap eligibility is activity in the
  last 90 days or a due date since that cutoff (including upcoming work). It rotates
  through UTC workspace/day buckets. Existing pending domain events, newly changed
  inputs, recurrence invalidations and due-boundary work are not discarded merely
  because the task is old. Explicit single-task requests can include older work.
- Candidate SQL and worker statements have an 8-second statement timeout; worker
  lock waits have a 500-ms limit. Event hashing checks an 8-second stream budget.
  Relay/reconciliation/evaluation stop starting additional records after their
  20-second inter-record budget. These are **not whole-job wall-clock deadlines**.
- Fast-path statements and stream paging use 500-ms bounds, restoring the caller's
  prior statement timeout. This is not a 500-ms HTTP latency guarantee.
- The polling intervals, lease duration and batch sizes are implementation bounds,
  **not a promised tracking freshness SLA**. No numerical tracking-specific SLA was
  supplied by the PRD. Service/load SLOs require operational measurement.
- Other outbox subscribers, including downstream notifications for tracking-result
  events, remain pending. They are not falsely marked published. Existing
  `NO_CONSUMER_REGISTERED` backlog markers are not global delivery acknowledgements;
  consult the tracking consumer receipt separately.
- Structured exhaustion logs are implemented; routed on-call alerts, telemetry
  dashboards and staging/load observation remain operational prerequisites.

## Acceptance evidence

Final local `pnpm verify`: **422 tests in 46 files; 75 browser/API scenarios**,
lint, typecheck, coverage and production build passed. Core coverage:
97.51% statements / 88.13% branches / 98.50% functions / 100% lines. Frozen install,
migration replay and dependency audit passed (**zero findings at all severities**).
Remote CI must be checked on the pushed commit; its Actions URL is reported with
milestone closure rather than inferred from these local results.

New acceptance coverage:

- `tracking-workflow.integration.test.ts`: 16 real-DB cases covering tenant-poisoned
  source references, concurrent/replayed/out-of-order delivery, complete streams
  beyond 200 events, due-boundary freshness, recurrence fan-out, rollback of durable
  invalidation and result publication, retry exhaustion/manual recovery, inactive
  owners/deletion, scoped evidence/disabled scores, tied-timestamp event identities,
  live/expired sixth attempts, claim fencing, bounded engine upgrades and unsupported
  event schema handling.
- `tracking-scheduler.integration.test.ts`: boots the **actual standalone worker**
  against an independently migrated database, kills it during a blocked calculation,
  verifies the committed attempt/receipt and rolled-back result/checkpoint, models
  lease expiry, and boots a fresh worker to recover exactly one result. Runs in CI
  as part of the full suite; isolated database creation requires test DB privileges.
- `e2e/tracking.spec.ts`: six browser/API scenarios for pending-to-fresh updates,
  exhausted retries and keyboard recovery, authorization/origin/replay, lost command
  acknowledgement, failed evidence continuation, stale poll protection and targeted
  WCAG accessibility checks.
- Existing scoring integrity, history, UTC/cohort, TR-06, task/bulk/recurrence,
  notification, export/purge and all previous browser tests remain in the full suite.

Regression-first evidence is retained outside Git under `/home/user/nextdoo-tracking`:
`red.log` (foreign-workspace skip), `timestamp-red.log` (only 4 of 7 tied-time events
survived), `poll-red.log` (old poll left committed recovery displayed as fresh).
`verify-first.log` recorded two browser presentation regressions; the existing score
label and unambiguous report status were restored **without weakening assertions**.
`verify-second.log` is the final complete passing run. The crash test additionally
proves real process recovery, not only an in-process function invocation.

## Still open — not silently redefined

- Full M4 review/corrections: date-range recalculation workflow and its range-level
  progress, due-date correction reasons, external-blocked/untracked/excluded-task
  semantics, annotations and the complete review/trend experience. Single-task
  recovery is not presented as the PRD's entire corrections/range-backfill feature.
- Workspace-local daily/weekly reporting and changes to the existing reporting
  cohort; independent wellbeing/tracking controls and visibility/retention policy.
- The unresolved TR-03 0.80-versus-0.65 example/preconditions. No weights were changed
  to force an ambiguous example green; the full TR matrix is not declared closed.
- Pure historical event-sourced reconstruction, repairing previously omitted events,
  materialized rollup caches, real alert routing and sustained scheduler/load SLOs
  are not claimed by this compatibility implementation.
- Previously documented provider/storage/scanner/staging and wider Phase 1 gaps
  remain. No AI, billing, desktop or full offline feature was started.
