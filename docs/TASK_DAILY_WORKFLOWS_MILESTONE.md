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
  server aggregates, not the length of a preview.
- Card inclusion/order persists in the existing `personal.*` preferences with
  server validation. Menus offer keyboard-accessible ordering/removal; Manage
  cards adds cards. Home is an optional start page; existing saved starts and the
  default Today route are preserved.
- Quick Notes invokes the existing idempotent Knowledge note command. Recent
  Knowledge reads owned live notes/records. Recently Viewed is deliberately not
  offered because there is no authoritative viewing-history source.
- Focus supports stopwatch and Pomodoro modes using existing timer sessions.
  Work/break durations and mode are persisted preferences. Pomodoro indicates
  when the interval ends; the user explicitly finishes work and takes a break.
  Actual work continues until that action, so background throttling never
  silently invents a timer transition. Break deadlines persist on this device;
  breaks do not create sessions or add work duration.
- Start/pause/resume/stop and signed manual corrections enter the existing
  workspace-scoped IndexedDB mutation queue before being sent. They use the
  existing sync endpoint, replay ledger, retries and attention surface. Timer
  commands remain ordered across sessions. Canonical acknowledgement and local
  snapshot advancement are atomic; local projection derives from pending commands.
- Server timer transitions retain user/workspace locks, canonical overlap rules,
  timestamp validation and version checks. Manual adjustments reuse `logTime`,
  preserve fractional-minute remainders, reject negative totals and retain the
  reason in audit/tracking history. Replaying an acknowledged command cannot
  credit time again. No new task/time tables or migrations were introduced.

## Boundaries

- Home summaries and editing preferences require connectivity. Task previews are
  bounded and link to complete module destinations. Focus summary counts finished
  sessions started on the workspace date; adjustments affect task actual duration
  and tracking history, not the session-only Focus metric.
- Offline Focus operates in an already loaded app and keeps commands across browser
  restarts. Reopening the authenticated application still requires connectivity;
  this increment does not add offline HTML/authentication caching to the push-only
  service worker. Saved commands reconcile once the app reconnects.
- Break phase is local to this browser/workspace. Canonical work sessions reconcile
  across devices. Rejected commands remain available for explicit review/retry or
  discard; no forced overwrite of another device's session occurs.
- The supplied text stopped at the example Home grid. No reference screenshots
  were attached with it. The implementation uses the existing NextDoo design tokens.

## Verification

Focused tests cover DST and date horizons, replayed offline transitions, signed
corrections, ownership/version enforcement, card persistence, source reads,
atomic local acknowledgement and browser-storage recovery. Browser scenarios cover
daily queues, Home notes/layout/start-page persistence, mobile accessibility,
offline pause/resume/reconnection and Pomodoro breaks.

Local verification (2026-09-26): production build and zero-warning lint pass.
The targeted service/queue/date suite passes 51 tests across six files. All seven
new browser scenarios pass after final accessibility fixes; the preceding broader
browser run also passed all 26 existing core, settings and task-query scenarios.
The full local coverage run passed 1,074 of 1,075 tests; its sole failure was an
existing unordered preference-key comparison, corrected to compare sorted sets
and verified in the targeted run. Remote CI is the final full-suite gate; its run
is linked from the implementation delivery report.
