# PC2 — Configurable Tracker

Tracker is a persistent user-created table: typed observations and linked task completion evidence are evaluated by user-defined conditions, producing configurable statuses and integer 0–5-star scores. It reuses existing tasks, authentication, workspace transactions, version conflicts, request idempotency, audit/outbox/sync and account data rights.

## Delivered behavior

- `/trackers` and `/trackers/[id]`: create, rename/configure, pause/resume, archive/restore, paginated lists and records, optional owned goal link and existing task search/link/editor.
- Stable Date, Linked Task, Input / Observation, Status, Stars and Notes semantics with editable labels and visibility. Date remains visible. Input fields can be added/removed and support number, text, checkbox, select, duration (minutes), date and date/time.
- Ordered all/any conditions with typed comparisons, editable status names, 0–5-star mappings and optional fallback. First matching rule wins. Every input referenced by a rule must be present before scoring; incomplete records remain unmeasured.
- Manual dated records and notes, corrections, soft deletion and explicit restoration. Source fields cannot be forged by manual commands. Historical definition snapshots keep settings changes from silently reinterpreting existing days.
- Durable worker ingestion every ten seconds, bounded batches, workspace locking, owner/lifecycle rechecks and unique source receipts. Task completion payloads add known actual duration; previous task events and task execution scoring remain unchanged. Multiple completions for one task/day use its latest evidence without multiplying daily stars. Durable task identity survives task purging.
- Per-tracker totals, calendar-day averages, tracked-day relative averages, tracked/non-tracking counts, tracking completion rate, unmeasured counts, status distribution, actual-day trend, weekly/monthly totals, best/worst scored days and linked task/day contribution count.
- Eleven independent editable templates: Exercise, Water Intake, Reading, Study, Sleep, Meditation, Weight, Learning, Finance, Mood and Custom Score. Browse, preview, download JSON and create a personal copy. Template changes cannot modify a saved tracker.
- Independent monthly channel/day/time settings and durable report snapshots. Existing encrypted SMTP queue handles email when configured; WhatsApp and Telegram settings explicitly record unavailable-provider status and never pretend to send.

## Day, history and delivery contracts

One actual persisted record represents one tracker-local day. Missing days never receive fabricated rows. A manual observation with incomplete scoring data still counts as a tracked day. Total stars sum measured daily scores; average divides by inclusive calendar days from start through end; relative divides by actual tracked days. An explicit report range intersects the start date. Zero denominators return no value. Frequency is descriptive and never changes these denominators.

New task completions qualify only after linking and the last activation. Paused/archive periods are not backfilled. Unknown task duration stays unknown. Unlinking or deleting a task preserves accepted evidence and historical scores; deleted task content is redacted. Deleting a tracker record suppresses automatic resurrection while source receipts continue to be retained. Explicit restoration evaluates retained evidence and manual values against the original definition. Account purge removes the complete owned Tracker graph.

The monthly scheduler checks each tracker's local day/time every minute and summarizes the previous calendar month only. Supported days are 1–28; overdue current-month scheduling is allowed, historical monthly catch-up is not. A tracker/month has one report identity. Blocked reports can be reconsidered when a supported channel becomes available. SMTP queue status is reflected as queued/sent/failed/expired; scheduling itself never claims successful delivery. Disabling delivery or pausing/archiving cancels pending email and erases its queued content. An already processing SMTP send may finish. Existing SMTP delivery is at-least-once, so ambiguous provider acknowledgements can cause retries.

## Architecture and deployment

Additive migrations `0026_personal_trackers.sql` and `0027_tracker_source_identity.sql` create five workspace-scoped tables: `personal_trackers`, `personal_tracker_links`, `personal_tracker_entries`, `personal_tracker_sources` and `personal_tracker_reports`. Constraints enforce owned relationships, one record per tracker/day, one receipt per tracker/event, one report per tracker/month and numeric star bounds. Run migrations before deploying web and worker. Applied migration bytes must never change. Application rollback can leave the tables intact; dropping them would destroy user history.

Contracts live in `packages/contracts/src/trackers.ts`; the pure evaluator, reports and templates are in `packages/core/src/personal-tracker.ts`. Browser code imports its dedicated pure subpath. Database ingestion/report scheduling are in `packages/db/src/personal-tracker-{engine,reports}.ts`; existing worker jobs invoke them. `apps/web/src/server/services/personal-trackers.ts` owns authenticated domain operations and reports. HTTP routes under `/api/v1/trackers` and `/api/v1/tracker-entries` reuse existing authenticated handlers. `TrackersView.tsx` and `TrackerDefinitionEditor.tsx` provide the table and separate configuration panels. Account export includes all five tables.

## Validation

Validation uses real PostgreSQL and Chromium against a production build. Dedicated tests cover typed rules/operators, threshold boundaries, the exact 30/10/6 denominator example, zero/missing days, templates, owned relationships, concurrent versions, duplicate source events, definition snapshots, notes, deletion/restore, task purging, rollback/retry, pagination, exports/account purge, monthly deduplication, queue encryption/cancellation and provider blocking. Browser checks cover template download/copy, manual scoring and reports, linked task auto-refresh, HTTP isolation/replay/validation, conflicting settings, accessibility, mobile layout and lost-response recovery.

Local validation on 2026-09-22: the production build, lint, all seven package type checks and migration integrity rerun passed. All 23 dedicated Tracker unit/integration tests and seven Tracker Chromium scenarios passed; the mobile screenshot was visually inspected. Existing CI retains its full coverage, dependency audit, migration rerun, PostgreSQL restore smoke, real ClamAV and full-browser gates. Its result must be verified for the pushed commit independently of these local checks.

The full regression run also exposed an existing account-deletion test whose fixed repeat-request timestamp reached the real authorization grace deadline on September 22. The test now sets its original request twenty days before its execution and still asserts the exact unchanged request timestamp and thirty-day deadline. The separate fixed-clock boundary tests and production deletion policy are unchanged. All thirteen account-deletion tests passed after this correction.

## Remaining limitations

This increment is online-only; sync deltas do not imply an offline Tracker editor. There is one scored record per day rather than arbitrary separately scored observations. The six semantic table columns are configurable; additional typed fields appear inside the observation column. Historical definitions are preserved rather than bulk rescored. Frequency is descriptive. Reports provide task/day contributions rather than a new task execution scoring system. Individual trackers are archived, not permanently deleted through a new endpoint; account deletion remains the complete purge path.

WhatsApp/Telegram adapters, credentials, recipient linking and live provider acceptance remain deployment-dependent future work. No live email or external-message delivery is claimed by local queue tests. Calendar overlays, universal relations/search, offline editing, richer streak/heatmap visualizations and cross-module Insights are follow-up scope. No unrelated module is included in this increment.
