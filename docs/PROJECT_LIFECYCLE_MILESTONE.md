# Project lifecycle milestone — 2026-09-08

Baseline: `b41f3e8`. Continuation of the approved online-workflow phase, preserving
the Next modular monolith, `/api/v1` paths and existing wire conventions.

## Delivered

- Project settings: edit name, plain-text description and optional color.
- Archive and restore, with separate Active/Archived project lists.
- Archived project task lists remain accessible. Archiving changes only the project:
  it does **not** delete, complete, archive or move tasks, cancel reminders, or alter
  historical tracking data. The confirmation and settings explain this explicitly.
- New task assignments to an archived project are rejected. Existing assignments
  can still be edited, completed, or moved out; this avoids making existing task
  notes uneditable after archiving their project.
- Restoring consumes an active-project slot and enforces the existing plan limit
  inside the same workspace transaction. Concurrent restores cannot exceed the cap.
- Owner-scoped reads/writes, required optimistic versions and HTTP idempotency.
  Conflicting metadata edits retain the draft and show the server values; reapplying
  a draft updates only deliberately changed fields, not unrelated concurrent edits.
- Project creation/update/archive/restore now publish canonical sync state, durable
  outbox events and content-free audit metadata in the same transaction.

## Additive API contract

| Method | Path | Input / effect |
|---|---|---|
| GET | `/api/v1/projects/:id` | Own non-deleted project, including archived state |
| PATCH | `/api/v1/projects/:id` | Required `version`; changed `name`, `description`, `color` |
| POST | `/api/v1/projects/:id/archive` | Required `version`; sets ARCHIVED and archivedAt |
| POST | `/api/v1/projects/:id/restore` | Required `version`; checks cap, sets ACTIVE and clears archivedAt |

Mutation requests require `Idempotency-Key`. Responses carry `X-Request-Id` and
errors use the existing problem format. Foreign identifiers return 404; unauthenticated
access returns 401; malformed bodies/IDs return 400; stale versions return 409.
Repeated identical HTTP requests replay their result. An already-matching lifecycle
state at its current version is a no-op, not another event/version increment.

The existing list endpoint still returns all non-deleted projects for compatibility;
Active/Archived selection is a UI filter, not silent removal from the API. All paths
are additive; no database migration or existing historical SQL was changed.

New event types: `project.created`, `project.updated`, `project.archived`,
`project.restored`. They remain in the durable outbox until a real consumer exists;
this milestone does not claim general event delivery/consumption is implemented.
Audit metadata contains changed field names/version, not project names or notes.

## Verification

| Gate | Final result |
|---|---|
| Frozen install | PASS |
| Lint | PASS, zero warnings |
| Typecheck | PASS across all five packages |
| Unit/integration/tooling | **290 passed**, 31 files, no skipped tests |
| Production build | PASS |
| E2E/API | **19 passed**, no test retries |
| Core coverage | All four 85% thresholds pass; 99.75% lines / 85.88% branches |
| Project dialog accessibility | No axe WCAG-tagged violations in the tested dialog |
| Keyboard/draft behavior | Enter opens/focuses name; rejected Escape discard keeps draft; saved metadata restores trigger focus |
| Dependency audit | **0 findings**, 364 dependencies |
| `git diff --check` | PASS |

Five new DB tests cover concurrent edits and event parity, tenant boundaries,
non-destructive archive/existing task editing, concurrent restore limits, and audit
failure rollback. They were added before the services. After adding lifecycle
operations, the existing-task edit regression failed on the archived-project guard
and then passed after a narrowly scoped correction. An initial reminder fixture
omitted its required user ID; that setup was corrected before treating this failure
as archive/edit evidence.

Three additional E2E/API scenarios cover metadata/archive/restore with preserved
tasks, conflict/keyboard/axe behavior, and HTTP validation/idempotency/tenant access.
The two new browser workflows failed for missing controls before UI implementation.
The contract scenario passed once the API was added. Existing tests were retained;
no assertions were removed or weakened.

Environment: real PostgreSQL 18.4 UTF-8 and Chromium 149, same isolated local setup
as the previous online milestone. Logs: `/home/user/nextdoo-projects/`, including
`service-red.log`, `archive-existing-red.log`, `service-green.log`, `browser-red.log`,
`final-verify.log` and `final-audit.json`. Expected negative-test and missing-production-
SMTP warnings do not establish real email delivery. Remote CI/production were not run.

## Still open / next bounded step

Project sections/reordering and board/task-movement UX are the next logical slice.
Subtasks/dependencies, project analytics, richer task lifecycle UX and workspace
settings remain incomplete. This milestone does not add recurrence, full offline
reconciliation, AI, billing, Calendar, attachments or desktop.

The earlier cursor-expiry/virtualization/large-collection gaps and production
security, retention, provider, observability, load and restore blockers remain.
Scoped dialog axe checks are not full WCAG certification. No complete PRD milestone
or production release is claimed.
