# Task Center daily workflow completion

This bounded personal-web increment extends existing task queries, timer sessions,
sync commands, preferences and Knowledge notes. It does not start PC8, M8-i8,
AI, collaboration, platforms, plugins or advanced task views.

## Implementation

- First-class Home, Inbox, Today, Tomorrow, Upcoming, Focus, Overdue, Backlog and
  Completed destinations. Today retains its overdue section and gains a completed
  due-today state. Completed permits reopening; history/Trash remain available.
- Tomorrow is the next workspace-local calendar day. Upcoming begins tomorrow
  and supports 3/7/14 calendar days (default seven). Backlog has distinct no-date
  and overdue queues. Dates use existing inclusive API filters, including database
  microsecond end boundaries; DST does not assume a day is 24 elapsed hours.
- Daily destinations reuse task pagination, completion, editor, priorities and
  sorting. Task links open Focus with the selected task. Existing general task
  date filters now use the workspace timezone too.
- Home is an independent card overview, not another task editor. Its registry
  supports Today, Upcoming, Overdue, Priorities, Goals, Focus, Calendar, Tracker,
  Recent Knowledge, Quick Notes and Productivity summary. Active cards load
  independently with explicit loading, empty, error and retry states. Counts are
  server aggregates, not the length of a preview. Upcoming horizon and priority
  cards can be configured; restore defaults resets the layout and card options.
- Card inclusion/order persists in the existing `personal.*` preferences with
  server validation. Menus offer keyboard-accessible ordering/removal; Manage
  cards adds cards. Home is an optional start page; existing saved starts and the
  default Today route are preserved.
- Quick Notes invokes the existing idempotent Knowledge note command. Recent
  Knowledge reads owned live notes/records. Recently Viewed is deliberately not
  offered because there is no authoritative viewing-history source.
- Focus supports stopwatch and Pomodoro modes using existing timer sessions.
  Work/short-break/long-break durations, cycle length and optional auto-start are
  persisted preferences. Work closes at its timestamp-derived deadline on the
  next browser wake-up. Short/long breaks support pause/resume and skipping.
  Auto-start begins the next work session when the app is available; it does not
  invent unattended historical cycles. Cycle state and timer commands commit
  together in the existing IndexedDB stores. Breaks never add work duration.
- Selected-task Focus displays status, subtasks, actual/planned duration, details
  and completion. Its lightweight picker searches active tasks and filters Today,
  Upcoming, priority and current project. Completion atomically stops a matching
  timer before using the existing task completion contract. Task details expose
  the same time summary and a link to Focus/manual entries.
- Start/pause/resume/stop, completion and signed manual corrections enter the existing
  workspace-scoped IndexedDB mutation queue before being sent. They use the
  existing sync endpoint, replay ledger, retries and attention surface. Timer
  commands remain ordered across sessions. Canonical acknowledgement and local
  snapshot advancement are atomic; local projection derives from pending commands.
- Server timer transitions retain user/workspace locks, canonical overlap rules,
  timestamp validation and version checks. Manual adjustments reuse `logTime`,
  preserve fractional-minute remainders, reject negative totals and retain the
  reason in audit/tracking history. Dated manual entries use existing stopped
  timer sessions; corrections/removals use version checks, compensating tracking
  events and retained audit history. No unrelated entry is rewritten.
  Replaying an acknowledged command cannot
  credit time again. No new task/time tables or migrations were introduced.

## Boundaries

- Home summaries and editing preferences require connectivity. Task previews are
  bounded and link to complete module destinations. Home, Insights and existing
  reports share a session-plus-manual-event projection, including historical
  manual adjustments and live elapsed time. Duration is bucketed by workspace
  start date, with signed manual adjustments on their recorded date. Task totals
  are committed when a work session stops; the task/Focus displays add its active
  interval without writing a second total.
- Offline Focus operates in an already loaded app and keeps commands across browser
  restarts. Reopening the authenticated application still requires connectivity;
  this increment does not add offline HTML/authentication caching to the push-only
  service worker. Saved commands reconcile once the app reconnects.
- Break phase is local to this browser/workspace. Canonical work sessions reconcile
  across devices. Rejected commands remain available for explicit review/retry or
  discard; no forced overwrite of another device's session occurs.
- The continuation supplied after the first delivery is included here. Neither
  attachment contained reference screenshots; the existing design system is used.
- The timer has visible, screen-reader-accessible phase status. New sound/push
  delivery is not added: the existing notifications system schedules durable
  reminders, not browser-local Pomodoro phases.
- Dated entries use the workspace timezone. Nonexistent DST wall times are rejected;
  repeated wall times use the existing workspace conversion occurrence. Entry
  history previews the latest 50 records. Removed records and reasons are retained.

## Verification

Focused tests cover DST and date horizons, replayed offline transitions, signed
corrections, ownership/version enforcement, card persistence, source reads,
atomic local acknowledgement and browser-storage recovery. Browser scenarios cover
daily queues, Home notes/layout/start-page persistence, mobile accessibility,
offline pause/resume/reconnection and Pomodoro breaks.

First-half delivery verification (2026-09-26, commit 8983a4b): production build and zero-warning lint pass.
The targeted service/queue/date suite passes 51 tests across six files. All seven
new browser scenarios pass after final accessibility fixes; the preceding broader
browser run also passed all 26 existing core, settings and task-query scenarios.
The full local coverage run passed 1,074 of 1,075 tests; its sole failure was an
existing unordered preference-key comparison, corrected to compare sorted sets
and verified in the targeted run. The first-half remote CI passed in run
36234797068; the continuation is validated separately below.


## Continuation verification

The second-half acceptance coverage adds selected-task execution/subtasks, card
configuration/reset/order persistence, work deadlines after background wake-up,
short/long break progression, pause/resume, skip and auto-start, dated entries,
versioned corrections/removals, completed tasks, offline completion and rejected
correction retention. Full validation results are recorded in the delivery report.

Local validation for the continuation: 1,084 tests across 96 files passed in the
full coverage run (94.27% lines). The final clock-skew regression was then added
and passed with the daily services/projection tests (12 tests); 22 existing timer
integrity/sync scenarios also passed. The final manual-entry guard rejects edits
to deleted tasks while retaining support for completed tasks.

All seven daily browser scenarios and six continuation browser scenarios passed.
The broader run also passed the 26 existing core, settings and task-query browser
scenarios. Browser assertions include axe checks at mobile/tablet sizes, real
application startup, server-acknowledged automatic transitions, offline completion,
and a rejected concurrent correction retained for review. Production build, lint,
and all seven package type checks passed; the delivery CI run verifies the complete
final commit. No screenshots, logs, generated build outputs or secrets are committed.
