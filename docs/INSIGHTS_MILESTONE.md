# PC6 — Insights, Summary and Reports

## Audit and implementation boundaries

Verified clean `main` and matching origin at `23029b81f881c1cf43bca8019c3a1fc92d058802` before edits. No applicable AGENTS.md. Reviewed PRD §§7.8–7.10, existing task/project analytics, Goal Center progress, Tracker reports/delivery, Calendar Center, account exports and wellbeing preferences.

Keep `/analytics` and project execution reports intact. Add `/insights` and `/insights/reports` over one authenticated read-side service. Reuse Goal Center's bulk progress function, Tracker's stored-score report function, Calendar Center's source projection and task analytics exclusion semantics. No new score engine, historical progress snapshots, provider integration or report-delivery scheduler.

Period activity and current-state snapshots must be labeled separately. Due-date completion rates retain task Analytics semantics; completion activity uses retained completion timestamps. Goal percent is current measured progress, not a reconstruction of past progress. Calendar event minutes are scheduled time, not work performed. Focus time uses stored accumulated/adjusted seconds attributed to session start day. Tracker DATE values retain each tracker’s time zone.

Closed periods can compare with an immediately preceding equal number of local calendar dates; unfinished periods do not claim comparable completed results. Respect `disableScores`, `disableStreaks`, and `disableComparativeMetrics` on the server and in exports. Comparisons remain off by default under the existing preference contract.

JSON/CSV exports are bounded authenticated report downloads. Existing durable exports remain the raw task-execution export pipeline. Print-friendly reports use browser printing; server-generated PDF artifacts and external report delivery are future work. No analytics persistence/cache means source deletion and account purge remain authoritative.

## Implemented

- `/insights`: cross-module overview; `/insights/reports`: the same selected-period snapshot with expanded detail and print controls. Navigation retains legacy Analytics.
- Tasks: created/completed activity, due cohort, completed/active/overdue due tasks, current overdue total, completion rate, priority/status/project groups, zero-filled daily trend and saved focus minutes. The existing latest-correction exclusion predicate is shared with Analytics.
- Goals: active/overdue/current measured progress, completed goals and milestones, remaining/overdue milestones, distinct linked-task completion and actual goal completion-date trend. `progressFor` is the unchanged Goal Center calculation.
- Tracker: saved total/average/relative stars, eligible and recorded tracker-days, unscored entries, status distribution, per-tracker comparison, daily/weekly/monthly trends and range-bound recording streaks. Reuses `personalTrackerReport`; no scoring on reads. Each tracker clips its reporting window to its own current date.
- Calendar: visible native/ICS/Google events, all-day counts, clipped scheduled minutes and daily workload. Reuses `calendarCenterProjection`, including provider DATE semantics. Task deadlines honor the internal task source visibility. Event titles, connection identifiers and provider payloads do not appear in aggregates.
- Knowledge: current non-archived database inventory, nondeleted note/record creations, and recent creations. Deleted records and archived parents suppress their related notes.
- Bounded recent activity (20 actual completions/creations) and upcoming active task/goal/milestone deadlines (20), with links to the original records.
- Six period selectors, custom 1–366-local-date validation, DST-aware boundaries, and closed-period comparisons against an adjacent equal number of dates. Tracker deltas are unavailable when eligible days differ. Current goal percent is never presented as a historical delta.
- Accessible labeled progress/bars and exact-value tables; narrow layouts keep tables scrollable. Empty denominators say “Not available.” Loading/failure states do not leave old period metrics on screen.
- Server-enforced Wellbeing score/streak/comparison preferences, with controls in Settings. JSON and CSV follow the same privacy preferences; user-supplied CSV values are quoted and formula-prefixed.

## Architecture and API

`getInsights(actor, query, now)` is the shared deterministic read service. It checks workspace ownership and uses a read-only repeatable-read transaction for a consistent snapshot. Source queries aggregate on the server; the client receives bounded metrics rather than full source history. No PC6 database tables, migrations, background jobs or cache were needed. Source deletion and account purge remain authoritative.

`GET /api/v1/insights` accepts `period`, optional `date`, custom `from`/`to`, and `compare=true|false`. The authenticated workspace comes from the session, never the query. `GET /api/v1/insights/export` accepts the same fields plus `format=csv|json` and returns a filename, MIME type and bounded download content. Both return `Cache-Control: private, no-store`; invalid input uses existing problem responses. Read/export rate limits are 30/15 per minute per user.

CSV uses a long-form metric-path/value layout, preserving nested groups and trends. JSON preserves the complete report snapshot. Downloads are freshly generated from source data and are not retained on the server. Print uses the report page and browser facilities.

Bounds: 366 dates; 50 goal cards with a “view all” link and untruncated aggregate counts; 20 project groups, recent activities and upcoming deadlines; 200 non-archived trackers and 50,000 selected tracker entries. Exceeding a Tracker bound fails explicitly rather than publishing truncated totals.

## Partial, external and future boundaries

**PARTIAL:** Knowledge analysis is intentionally lightweight. Goal trends use retained completion timestamps, not historical progress snapshots. Reports reflect current source state: reopening, deletion, exclusions and later corrections may change past-period output. Tracker task-derived inputs follow existing asynchronous ingestion; saved results are not a promise that every pending event has been consumed. Focus includes saved manual adjustments; running elapsed time is not guessed. Calendar scheduled time and task completion are separate evidence, not an invented appointment productivity rate. Streaks are within the selected range, not lifetime streaks.

**EXTERNAL:** Browser Print / Save as PDF depends on the browser. Existing Google synchronization and Tracker delivery preserve their established configuration requirements.

**FUTURE:** Server PDF artifacts, scheduled cross-module report delivery, historical goal snapshots, AI/predictive insights, teams/benchmarking, external BI and native clients. PC7 is out of scope.

## Validation

New core tests cover six period types, week starts, DST, leap years, equal-date comparisons, skipped dates, invalid/unbounded input and recording streak gaps. Database integration tests cover every module, source-of-truth reuse, empty/partial data, preferences and exports, visibility, tenant isolation and purge. Browser tests cover navigation, all period selectors, Tasks, Goals, Tracker, Calendar, reports/downloads, mobile overflow, settings, failures and authenticated endpoints.

Final local validation and pushed-commit CI evidence are recorded in the PC6 implementation report delivered with this milestone.

Local validation: 1,045 tests across 89 files passed with 94.06% overall line coverage. New Insights service: 100% lines / 91.22% branches; Insights period helpers and export formatter: 100% lines / branches. All 11 new browser cases passed without retries; 15 Analytics/Wellbeing/connected-workflow and 14 Calendar Center browser regressions also passed. Mobile report passed the WCAG 2/2.1/2.2 axe checks and horizontal-overflow assertion. Lint, all-package typecheck, production build and two idempotent migration replays passed. No existing tests or CI thresholds were weakened.
