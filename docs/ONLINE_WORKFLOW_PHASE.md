# Online workflow phase — 2026-09-08

User approved continuation and explicitly selected preservation of the existing
Next modular monolith, `/api/v1` paths and camelCase request conventions. Existing
pagination response names remain compatible too. No API rewrite or alias migration.

First bounded delivery: atomic capture of tags and existing projects; task detail
editing with version-conflict draft preservation; navigable project task lists;
server-side Inbox filtering and explicit continuation controls on task lists.
Plain-text notes remain safely rendered as text, not a new rich-text engine.
Recurrence, boards/sections/subtasks, workspace settings, full offline mode, external
providers, AI, billing and desktop are not implied by this slice.

Requirements: PRD §§5.1–5.2, 6.3–6.4, 6.9–6.10, 8, 10.7, 11.3, 14 and 19.
Changes must preserve scoped authorization, atomic idempotency, quota enforcement,
event/sync parity and all existing regressions. New behavior gets failing tests
first; commits follow full verification. Report residual gaps explicitly.

Workspace recovery: restored files were byte-for-byte identical to pushed commit
40fc8b5 after staging. A fast-forward merge restored local history; no file changes
were discarded and no history was rewritten.

## Delivered first milestone

- Structured capture presents parsed tags/projects for confirmation. Tags are
  normalized/deduplicated and committed with the task, links and sync changes.
  `+project` resolves exactly one active project in the current workspace; missing,
  ambiguous, archived or foreign references cannot produce partial writes.
- GET/POST `/api/v1/tags` added with owner authorization and mutation idempotency.
  Existing API paths/fields remain; task create accepts optional `tagNames` and
  `projectName`, task PATCH optional `tagNames`, and task detail adds `tagIds`.
  On PATCH, tagIds plus tagNames define the replacement set; callers adding names
  should include the IDs they intend to retain (the editor does this).
- Task titles open a keyboard-accessible native dialog. Title, plain-text notes,
  project, priority, date/time, estimate and tags can be edited. Only deliberately
  changed fields are patched. A 409 keeps the draft, displays server values and
  requires an explicit rebase/reload choice. Escape/Cancel confirms dirty drafts.
- Unacknowledged saves retain in-memory request identity for the same payload;
  a real commit-followed-by-network-failure test proves capture retry deduplicates.
  This is not persistence of drafts across reload or full offline mutation support.
- Inbox filtering happens in SQL before pagination. Today, Inbox, project task
  lists and Focus expose 50-item continuation pages, deduplicate appended IDs,
  preserve loaded rows on page failure and offer retry. Late/aborted requests are
  ignored and cache fallback remains workspace-scoped. Project cards now open
  actual task lists. Today totals explicitly refer to loaded tasks.
- Tag-only updates advertise `tagIds` in outbox field metadata as well as sync
  payloads. Tags created during failed/stale mutations roll back.

## Verification

Fresh disposable UTF-8 PostgreSQL 18.4 was initialized, all existing migrations
0000–0009 applied, and the final full verification passed:

| Gate | Result |
|---|---|
| Frozen install | PASS |
| Lint / typecheck / production build | PASS |
| Vitest | **285 tests, 30 files**, no skipped tests |
| Playwright | **16 scenarios** (14 browser + 2 HTTP), no retries |
| Core coverage | All four 85% gates pass (99.75% lines, 85.88% branches) |
| Dependency audit | **0 findings**, 364 dependencies |
| Editor axe WCAG-tagged checks | **0 violations** in the tested dialog |
| Keyboard editor check | Open with Enter; focus input; Escape preserves rejected discard; confirmed Cancel restores trigger focus |
| `git diff --check` | PASS |

Seven new DB tests cover organization persistence, failed name resolution,
filter-before-pagination, detail isolation, combined tag cap/stale rollback,
foreign tag rejection and tag event parity. Four initial service tests and the
later event-metadata regression were RED before their implementations. Browser
missing-feature tests failed before UI implementation; the Focus continuation
assertion also failed before its fix. Five new browser scenarios cover confirmed
organization/replay, conflict draft preservation, Inbox/Focus pagination with a
failed-page retry, lost-acknowledgement retry and keyboard/axe behavior.

The two earlier tag/project refusal tests were evolved for the newly approved
feature, not dropped: they still prove raw input survives and no task is written
before confirmation, then assert real tag persistence or explicit unknown-project
failure. Existing cache-isolation, recurrence refusal, timer and security tests
remain green. Test setup uses a separate documentation-range proxy IP for new
registration fixtures so the expanded suite does not exhaust another scenario's
10/minute bucket; production limits were not changed.

The standard Playwright CDN download and HTTP apt mirrors were unavailable.
Actual Chromium 149 and its native libraries were extracted from an external
registry package, with no application dependency or browser-security workaround.
The initial browser-library launch failure was not counted as regression evidence;
after provisioning libraries, the tests failed for actual missing UI behavior.
Evidence: `/home/user/nextdoo-online/` (service-red/green, browser-red,
focus-pages-red, tag-events-red, editor-accessibility, final-verify, final-audit).
Remote CI and full production qualification were not run.

## Boundaries and remaining work

This is the first bounded online-workflow delivery, **not completion of PRD
Milestone 2 or production approval**. Boards/sections/subtasks/dependencies,
project lifecycle/settings, rich text, bulk actions and broader filters remain.
The parser's existing single-token +project grammar is unchanged; project names
with spaces can be selected in the editor. Recurrence still refuses saving while
preserving input. Full offline persistence/recovery and larger integrations remain
outside this phase.

Task cursor expiry and full collection contract coverage, list virtualization
above 200 loaded rows, large tag/project collection paging, calendar-list paging,
workspace-local reporting/date semantics and full-app accessibility/performance
remain explicit follow-ups. The editor-only axe result is not WCAG certification.
Legacy audit security/retention/provider/restore/SLO blockers still apply.

Deploy the colocated web/API together only after every API instance supports the
new optional organization fields. Older servers strip unknown fields; mixed-version
feature enablement is not qualified. No production rollout was attempted. No
migrations or historical records were rewritten in this milestone.
