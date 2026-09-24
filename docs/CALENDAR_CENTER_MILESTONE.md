# PC5 — Calendar Center

## Audit before changes

Clean `main`, local and origin both `2b2cd91e68f643dcaf9cd2bb8961ac36f1d6e4ea`, verified 2026-09-23. No applicable AGENTS.md found.

Reuse the existing day/week/month task Calendar, reschedule API, workspace time helpers, PC4 date projections, authenticated/versioned/idempotent commands, Google settings and M7/M8 provider engine. Google currently operates on `calendars/primary`, with one token/sync checkpoint per connection; secondary-calendar discovery/synchronization is not implemented. Mirrored events retain calendar IDs. Do not misrepresent secondary-calendar or live Google acceptance.

Add one Calendar Source configuration model, native one-off events, bounded ICS snapshot imports, source colors/visibility/settings, Year and Agenda views, and Today consistency. Native events do not become Tasks. Source visibility never deletes domain data or changes existing capacity calculations. Google task exports/edits remain on the existing sync path; unlinked mirrored events remain read-only.

ICS uses the maintained [ICAL.js parser](https://kewisch.github.io/ical.js/api/index.html). File upload is a snapshot, with explicit bounded recurrence expansion and repeat-import identity. No remote URL fetch or live subscriptions are claimed: the existing app has no hardened arbitrary-URL fetch boundary. Users can download an ICS URL and upload the file. Native reminders/recurrence remain task-owned capabilities, rather than a second scheduler.

Implementation boundaries and acceptance evidence are recorded below.

## Implemented behavior

- Migration 0030 adds owned source preferences and native/import event storage, with composite workspace/source integrity. Internal/provider preferences overlay logical identities; internal dates and provider mirror rows remain in their original stores.
- Calendar Center adds native calendars, event details/CRUD, source moves, drag rescheduling, end editing/drag resizing, archive/restore, names/colors, persisted visibility, Year overview and 30-day Agenda. Day/week/month task editing, completion, rescheduling and workspace-zone navigation are reused.
- Google settings reuse existing authorization, disconnect/reconnect and conflict UI. Primary and any already-mirrored calendar IDs receive independent source controls. No new provider engine or invented connection status.
- ICS uploads are read-only snapshots. Same file/window/zone imports are deduplicated; re-import into an existing snapshot updates matching occurrence UIDs and removes missing occurrences atomically. Invalid uploads leave the old snapshot intact. Sources can be hidden, archived/restored and downloaded privately.
- ICS parsing enforces 1 MB, 2000 input events/expanded occurrences, a three-year window and 10,000 iterator steps. Supports daily, weekly weekday and plain monthly/yearly rules, EXDATE/RDATE and individual moved exceptions. Complex rules/range exceptions/unsupported dates are rejected with an explanation. Embedded VTIMEZONE and IANA/floating time handling avoid global parser state. All-day ends are exclusive. Custom VTIMEZONE instants are preserved; display zone falls back to the chosen import zone when the original zone is not an IANA identifier.
- Commands use existing authentication, workspace ownership, transaction locks, optimistic versions, idempotency, audit/outbox and sync-change records. Request bodies are bounded before idempotency parsing. Account export/purge include owned sources and events. Source configurations are limited to 100 and stored calendar events to 10,000 per workspace.
- Today queries the same visible native/import/active Google events. Task/goal summaries keep their own domain semantics. Native/import events do not change capacity calculations.

## Partial / provider-dependent / future

Google remains primary-only sync; additional IDs already in mirrors can be independently shown/hidden but are not newly discovered or synchronized. Google event dialogs are read-only; linked Tasks retain existing write-back. Live Google acceptance requires deployment credentials/consent/webhooks, and fixture acceptance is explicitly separate.

Native events are one-off; recurrence/reminders remain Task-owned. ICS URL retrieval, refresh subscriptions, public feeds, Outlook/Apple providers, secondary Google calendar discovery and hourly-grid resizing remain future scope. Users can download an ICS URL themselves and upload its file. Year is a navigable overview and Agenda covers 30 days. PC6 is not started.

## Validation

Focused parser/service tests and browser scenarios cover import identity, recurrence/time zones, ownership, version conflicts, source settings, native lifecycle, read-only provider/import boundaries, all five views, Today and mobile layout. Existing connected-workflow browser coverage continues to verify navigation to original Goal/Milestone/Tracker/Knowledge objects. Final test totals and CI evidence are recorded in the delivery report.

### Verified local acceptance (2026-09-24)

- Full suite: **1005 tests, 87 files**, all passed; **93.94% line coverage**. Calendar package: 96.64% lines / 87.08% branches; ICS parser: 100% lines. Existing coverage thresholds are unchanged.
- Browser acceptance: **33 Chromium scenarios passed without retries**, comprising 14 new Calendar Center scenarios plus existing Calendar, Google settings and connected-workflow suites. Includes successful and failed visibility saves, all-day events, native lifecycle/drag/resize, workspace/event clocks, cross-zone drag, source colors/archive/restore, snapshot dedup/re-import settings, malformed imports, Today, all five views and mobile layout. Google checks use explicit fixtures, not live-provider acceptance.
- Type checking, lint, production build, migration replay (twice), and dependency audit passed. No known dependency vulnerabilities were reported.
- Mobile screenshot manually inspected at 390px; source controls collapse to keep events reachable without horizontal overflow.
- CI runs the unchanged complete workflow, including PostgreSQL restore smoke, real ClamAV/EICAR checks and the full browser suite. Exact commit, remote SHA and CI outcome are recorded in the delivery report after publishing.
