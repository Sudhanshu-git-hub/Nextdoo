# M4 score corrections and date-range recalculation — report

Commit: `81610cc` on `arena/01a085b7-nextdoo` (branched from M3 `0642bb5`).
Scope: one bounded milestone — typed score corrections with audit preservation
and supersede-never-mutate history, correction-aware Unmeasured scoring, a
bounded observable date-range recalculation with a 10/hour/user limit, the
matching analytics/tracking-panel UI, two new metric events, and full
regression/E2E/tenant-isolation coverage. No changes to score math, weights,
normalization, append-only event semantics, historical results or TR-03.

## PRD requirements addressed

- **§7.7 score corrections:** typed correction kinds — `DUE_DATE_CORRECTED`,
  `EXTERNALLY_BLOCKED`, `UNTRACKED_COMPLETION`, `EXCLUDED_FROM_ANALYTICS` — each
  recorded with actor and a mandatory reason; every row is immutable; undo
  inserts a new `CLEAR` row (never an update); re-applying the same state is an
  explicit no-op; the latest row per `(task, kind)` is effective; results are
  marked `recalculated` on a real re-evaluation.
- **§7.6 recalculation strategy:** on correction (or a user request) enqueue a
  bounded backfill — default last 90 days, max 366, `to` ≤ today, UTC day keys —
  chunked by workspace and day (one day per worker run, durable cursor),
  rate-limited, with observable progress. Historical results are superseded,
  never rewritten; superseded history stays queryable.
- **§7.3 Unmeasured-not-fabricate:** `EXTERNALLY_BLOCKED` folds the timing
  component to Unmeasured and re-normalises the remaining weights;
  `UNTRACKED_COMPLETION` scores the completion as absent (0) with timing
  Unmeasured; `EXCLUDED_FROM_ANALYTICS` removes the task from day/week summary
  cohorts only — the stored result and per-task drill-down remain available, and
  the summary reports `excludedCount` instead of silently dropping the task.
- **§7.11 TR-05:** a due-date correction after completion produces a new result
  (`recalculated: true`, e.g. ON_TIME → LATE) while the original result is
  superseded (never mutated) and every event stays intact. TR-04 replay is
  preserved: re-applying a correction and re-running the same range bump no
  revisions and add no duplicate results.
- **§14.8 limits:** recalculation requests are limited to 10/hour/user (429
  problem response; the failed request consumes no idempotency key).
- **§21.3 metrics:** new `tracking.correction` / `tracking.correction_failed`
  events (kind + action, no content); unmeasured results counted on both
  evaluation paths (web fast path per-task, worker aggregated).

## Design decisions

- **State model:** `tracking_corrections` (existing M2 table, shared with the
  `RECALCULATE_TASK` recovery kind, which is filtered out of correction
  semantics) is append-only. Effective state = latest `(created_at, id)` row per
  `(task, kind)` — UUIDv7 ids make the tie-break deterministic.
- **Due-date corrections** go through the normal `updateTask` path (versioning,
  `TASK_RESCHEDULED` event, reminders stay correct) with the in-transaction
  fast-path evaluation suppressed (`fastTracking: false`): the durable
  invalidation (PG trigger on `tasks` + outbox) still re-evaluates, and only the
  worker path writes the new result — which is what marks it `recalculated`.
  Toggle kinds bump the tracking job directly (no `tasks` write, so the trigger
  does not fire).
- **Correction-aware scoring input:** the engine folds the latest row per kind
  into the scoring input. `EXTERNALLY_BLOCKED` is core-scoring (`timingComponent`
  returns Unmeasured with a reason; the `k:'EXTERNALLY_BLOCKED'` fingerprint key
  only appears when set, so correction-free inputs are byte-identical and
  idempotency holds). `UNTRACKED_COMPLETION` sets `completed: false,
  completedAt: null`. Score math, weights (completion .40 / timing .25 /
  estimate .25 / recurrence .10) and outcome bands are untouched.
- **Backfill:** `tracking_backfills` (migration 0017) — one row per requested
  range, `cursor_date` advanced one day per worker run inside an advisory-locked
  transaction with an 8 s statement timeout (5 ranges max per run). The set-based
  job revision bump only targets tasks due/completed on the processed day.
  Validation: `from ≤ to`, ≤ 366 days, `to` ≤ today, ≤ 3 pending per workspace.
  A 90-day range completes in 90 single-day runs (≈18 runs per week at the
  default schedule).
- **API:**
  - `POST /v1/tracking/tasks/:id/corrections` — idempotent (Idempotency-Key
    required, 60/min), typed body, 404 across tenants, audit row per applied
    correction.
  - `POST /v1/tracking/recalculate` — idempotent, 120/min plus the PRD 10/hour
    limit on a **distinct** rate-limit bucket, 429 when exhausted.
  - `GET /v1/tracking/recalculate` — latest progress (`processedDays`,
    `remainingDays`, `status`) or 204 when none.
  - `GET /v1/tracking/tasks/:id` now includes the task's correction rows.
- **Idempotency hardening (verified defect):** `idempotentMutation` stored
  `JSON.stringify(result)` — a handler that returns a `Response` (e.g. a hand
  built 429) serializes to `{}` and the client receives a **200 with an empty
  body** while the ledger records the corruption. It now fails loud
  (`INTERNAL_ERROR`, transaction rollback, key unconsumed) instead. The
  recalculate route therefore throws `AppError('RATE_LIMITED')` (→ 429 problem,
  key unconsumed) instead of returning a `NextResponse`.
- **UI:**
  - Tracking panel `CorrectionControls`: kind/action/reason form (due-date
    variant), idempotent retry on a lost acknowledgement, recorded-corrections
    list with per-row Revert; corrections are kept in the panel's 5 s
    poll/refresh merge (previously dropped, so the list never updated).
  - Analytics `RecalculateRange` card: bounded from/to (default 89 days →
    today), reason, progress line polling every 5 s (skipped when the tab is
    hidden), 204-safe. The `excludedCount` note renders even when **every** task
    in the window is excluded (`plannedCount 0`).
- **Summary exclusion:** SQL latest-row subquery in `readSummary` removes
  `EXCLUDED_FROM_ANALYTICS` tasks from the planned cohort only; `excludedCount`
  (numeric, postgres-js count coerced) is reported; drill-down unchanged.

## Verification evidence

Local gates at `81610cc` (all re-run after the final code state):

- **Unit/integration: 536 tests in 55 files passed** (baseline 524/54): +9 new
  correction scenarios (TR-05 due-date with superseded-original + audit
  assertions, toggle no-op/undo immutability, UNTRACKED_COMPLETION set/restore,
  EXTERNALLY_BLOCKED Unmeasured with weight 0.4 / score 100,
  EXCLUDED_FROM_ANALYTICS summary exclusion, no-op due-date rejection, tenant
  isolation, 4-day bounded backfill run twice without duplicate results,
  out-of-bounds/future range rejection) and +3 core EXTERNALLY_BLOCKED scoring
  tests (scoring suite now 26).
- **E2E: 114/114 browser/API scenarios passed** (baseline 110): +4 new — panel
  due-date correction flow (recalculated LATE, superseded original, audit row,
  recorded list, Axe WCAG 2/2.1/2.2 AA on `.tracking-panel`), exclusion summary
  note + preserved drill-down, observable day-by-day backfill with the 11th
  request within the hour returning 429 `RATE_LIMITED`, and
  auth/tenant/idempotency guards (401 unauthenticated, 404 cross-tenant, 400
  without key, foreign recalculation never touches another workspace).
- **Lint 0 warnings; typecheck 5/5; coverage 88.03% statements** (≥ 87.85%
  baseline); production build OK; migration replay **×2 on a fresh database**
  (all 18 migrations apply, second run no-op).
- Remote CI runs against the pushed commit; result recorded at milestone
  closure.

Defects found and fixed while verifying this milestone (all covered by the new
tests): the fast-path `recalculated: false` race on due-date corrections; the
idempotency ledger corrupting `Response` returns into 200 `{}`; the shared
rate-limit bucket between the per-minute and 10/hour limiters; the panel
poll/refresh merge dropping `corrections`; the exclusion note hidden when
`plannedCount === 0`; a postgres-js count string leaking into `excludedCount`.

## Remaining (M4 and beyond, explicitly not started)

- Workspace-local reporting and richer trends (PRD §7.8/§8.5) — the next
  recommended M4 candidate.
- Independent tracking/wellbeing controls and retention policy; unresolved
  TR-03 example preconditions and the full TR matrix; routed alerts and
  sustained freshness/load SLO qualification.
- Reporting enhancements, provider integrations, offline work, AI and billing
  remain excluded per the session scope.
