# Recurrence milestone — functional verification

Date: 2026-09-09 (Asia/Calcutta). **This bounded online recurrence milestone is complete and locally verified. Phase 1 as a whole remains incomplete.**

The latest authorization orders boards/sections → subtasks → recurrence → workspace settings. Existing boards and relationships were retained and their regression/browser suites rerun, not rebuilt. Workspace settings is next. AI, billing integration, desktop and full offline mode were not started.

## Product decisions and behavior

The user explicitly selected both policies before implementation:

- DST gaps shift forward by the actual clock transition (including half-hour changes); folds occur once at the earlier instant. An explicitly supplied first task instant is retained, including seconds/milliseconds. Subsequent occurrences retain the local clock time.
- Future rule changes preserve **every generated occurrence**, including edited future tasks and completed history. The reviewed effective start must be after the generated planned range and now; local-date keys cannot overlap across time-zone changes. A changed rule starts a new count-limited segment, as explained in the confirmation UI.

Daily, weekly, selected-weekday, monthly, interval, end-date and count rules create actual tasks with immutable planned occurrence dates/keys. The original task becomes the first occurrence. Monthly days clamp to month end. Existing generated tasks are never regenerated after rescheduling or deletion.

Templates snapshot saved metadata and tags. They do not automatically copy reminders, child tasks or prerequisites; the UI discloses this before confirmation. Editing an individual task does not silently change the saved template. Existing unavailable project/section/parent/tag references block generation rather than silently discarding assignments.

Generation has a 60-day horizon and at most 50 future occurrences; each call creates at most 50 tasks and respects the existing active-task entitlement limit. Historical catch-up can require multiple bounded batches. Pause stops generation only, not existing tasks or reminders. Resume/retry and future changes are versioned commands.

Completion, reopening, restoration and rescheduling use the existing task lifecycle. Skip archives the instance, cancels pending reminders and records a distinct `TASK_SKIPPED` event. Restoring a skipped task resets the current occurrence state without deleting the historical event. Existing recurrence-score cohort/denominator policy was not silently changed.

## Architecture and contracts

- Preserve Next.js, `/api/v1`, camelCase, tenant scoping, origin checks, durable request idempotency and version/CAS conventions.
- `POST /api/v1/tasks/:id/recurrence`: adopt a saved, active, scheduled task.
- `POST /api/v1/tasks/:id/skip`: versioned skip of an active occurrence.
- `GET /api/v1/recurrences/:id`: metadata and 100-item cursor-paginated occurrence history, including live task details or unavailable/deleted history.
- `PATCH /api/v1/recurrences/:id`: reviewed future schedule or pause/resume/retry.
- Existing task creation accepts a recurrence atomically. Missing first dates fail without leaving a one-off task or losing capture text. Recurring natural-language capture always previews the series before confirmation.
- Generic sync rejects recurrence commands rather than acknowledging ignored fields or pretending to provide offline recurrence editing. Existing online task lifecycle and generated-task sync records remain supported.

The shared `packages/db/src/recurrence.ts` generator is used by web transactions and the standalone worker, with no production import from worker into web services. Workspace → rule serialization, stable occurrence/event keys and unique indexes prevent duplicate tasks and effects. Task writes, tracking, sync, outbox, audit and checkpoints commit together. The existing serializer and entitlement reader were extracted into shared modules without changing entitlement policy.

The worker scans at most 25 due rules per 60-second scheduler tick, normally checking each rule every 15 minutes. Due state is rechecked under locks. Hard failures use version/failure-count CAS, bounded 1/2/4/8/15-minute backoff, stop after five attempts and expose retry state; worker failures emit structured warnings. Unavailable/deleting owners suppress generation and advance the next check rather than permanently occupying the front of the queue. Owner state is checked under a row-share lock.

Migration **0011** is additive and replay-safe through the existing migration runner. It adds template/checkpoint/error scheduling state and a unique non-null occurrence-task index; ORM indexes match the SQL. Snapshot-less legacy scaffold rows are intentionally not activated or backfilled into fabricated recurring tasks.

## PRD acceptance evidence

| Requirement | Exercised behavior |
|---|---|
| §6.5 supported schedules | Core calendar tests plus real-DB daily, weekly/weekday, monthly clamping and DST-midnight generation; UI attach and natural-language capture |
| Future edits preserve completed history | Real-DB lifecycle/keys tests and browser assertions comparing every existing task's version/due date after a revised schedule |
| Distinct skip event | Real-DB skip/version/scoring restoration checks; keyboard browser skip; reminder cancellation through lifecycle |
| Zone changes preserve occurrence identity | Real-DB zone-change and deleted-instance preservation; immutable local-date keys and reviewed cutover validation |
| Retries never duplicate occurrences (§21 #5) | Concurrent real-DB generators and scheduled dispatcher, unique keys, repeated resume, HTTP replay and lost-response browser retry |
| DST wall-clock policy | Spring gaps, fall folds, half-hour transitions, month-end, midnight and subminute anchors in core/real-DB tests |
| Transactional effects | Injected failure on a later generated outbox write rolls back source version, rule, earlier generated tasks, tracking, sync and audit |
| Safe online UX | Dirty future drafts survive skip; dirty task metadata blocks navigation through the series link; failed history continuation retains 100 loaded rows and retry reaches all 105 |
| Security and concurrency | Authentication, cross-tenant reads/writes, strict payloads, UUIDs, origin/idempotency and stale-version browser/API tests |
| Worker failure recovery | Real-DB backoff/five-attempt stop, explicit reset/resume and deletion/cancellation queue-progress tests |

## Validation and failures resolved

Final **`pnpm verify` passed** against real PostgreSQL and a real Chromium browser:

- Lint and all package typechecks: passed.
- **386 unit/integration/tooling tests in 41 files: passed.**
- Core coverage: **97.40% statements, 88.02% branches, 98.33% functions, 100% lines**, above all configured thresholds.
- Production build: passed.
- **57 browser/API scenarios: passed**, including seven dedicated recurrence scenarios and the strengthened capture regression. The recurrence management surface also passes the targeted Axe WCAG 2/2.1/2.2 AA check; this is not a whole-product accessibility certification.
- Frozen-lockfile installation and migration replay: passed. Full dependency audit: **0 critical/high/moderate/low/info findings**. `git diff --check`: passed.

Regression-first runs found calendar/DST failures, missing integrated controls, subminute count drift, historical-skip scoring and falsely acknowledged generic sync. Review also reproduced blocked-owner queue starvation. These were fixed without deleting coverage. Earlier full runs exposed the obsolete unsupported-recurrence expectation; it was replaced with preview plus persisted-series assertions, with a separate missing-date/no-one-off regression. Moving that capture fixture to tomorrow required navigating to Inbox, not incorrectly expecting tomorrow's task in Today. One expanded test initially used an incorrect service argument; two isolated worker-test invocations lacked the test auth environment. Final gates include all corrections and deterministic service clocks (Date only, not network timers).

Detailed local logs: `/home/user/nextdoo-recurrence/verify-closure.log`, `core-red.log`, `browser-red.log`, `edge-red.log`, `worker-queue-red-2.log`, `worker-queue-green-2.log`, `migration-replay.log`, `final-audit.json`. Logs/browser binaries are not committed. PostgreSQL and Chromium verification is local evidence, not production or Windows qualification. SMTP was not configured; registration delivery errors remain explicit and no successful provider delivery is claimed.

## Remaining work / release boundaries

Personal-workspace settings/management is next; its workday validation policy needs review before implementation. Full offline recurrence/conflict reconciliation, historical-template migration, multi-workspace collaboration and template-wide metadata editing are not claimed. Existing unhandled outbox consumers remain pending, not falsely delivered. Production alert routing, distributed-load/large-history qualification, operational replay exercises and the other Phase 1 release gates remain open in [PHASE1_COMPLETION_PLAN.md](PHASE1_COMPLETION_PLAN.md).
