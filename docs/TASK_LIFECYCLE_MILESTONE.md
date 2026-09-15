# Phase 1 core tasks — archive, deletion and recovery UI

Date: 2026-09-08. Continues `c0a9c92` on `arena/01a080d5-nextdoo`.
Implements the next bounded task-management slice of PRD §6.3, §13.5 and
Milestone 2. This is not completion of all core task management or Phase 1.

## Delivered user workflows

- The task editor now has **Archive task**, **Move to Trash**, or **Restore task**
  controls appropriate to the latest loaded task state. Each action requires an
  explicit confirmation and an acknowledged server response before closing.
- Dirty task metadata, unsaved subtask input and in-flight relationship edits block
  lifecycle actions. A stale version produces a conflict, not a silent delete or
  restore. Users can explicitly reload the task and review it before trying again.
- **Task history**, linked from Inbox and an open project, provides workspace-wide
  **Completed**, **Archived** and **Trash** views at `/task-history`.
- Completed tasks can be reopened using existing controls; archived tasks can be
  opened, edited, restored or moved to Trash. Archived rows no longer offer an
  invalid completion checkbox.
- Trash shows read-only task titles, deletion timestamps and restore deadlines.
  Restore is keyboard-operable. Deleted tasks cannot be opened in the task editor
  or modified through normal detail/PATCH paths.
- All three collections use existing 50-row continuation, cancellation and retry
  behavior. A failed later page retains the already loaded rows.
- Lost delete/restore acknowledgements can be retried with the same request identity
  while the component and payload are unchanged. This is not a durable offline
  queue or draft/request persistence across navigation or reload.

## Lifecycle and retention semantics

Existing domain semantics are preserved:

- Archive removes a task from active views while retaining its data and history.
- Move to Trash is **soft deletion**, not permanent deletion. It writes a tombstone
  and cancels pending reminders atomically.
- Restore from Archived or Trash returns the task to **ACTIVE**, clears lifecycle
  timestamps, and enforces the active-task plan limit under the workspace lock.
  It does not restore the previous completed state; original tracking history remains.
- Project/section/parent assignments, tags, prerequisites, estimates and due dates
  are not moved or removed by restoration. Existing project assignments can remain
  in archived projects, as permitted by the pre-existing restore service.
- Related tasks do not complete, archive, move or delete as a side effect.
- Canceled reminders are not reactivated by restoration. Archive's existing reminder
  behavior is unchanged: dispatch cancels reminders for non-active tasks when they
  are processed; this slice does not introduce immediate archive-time cancellation.
- No automatic timer-stop behavior or permanent-delete UI is added.

Trash includes only records with `deletedAt > now - 30 days`. The boundary is
exclusive: at exactly 30 days, restoration is rejected and the item is absent from
new recovery queries. Expiry is checked on each query and on restore, so a task
that expires while displayed can no longer be restored. Expired tasks are not
presented as recoverable merely because retained history still exists.

This milestone does not implement a per-task purge job, change immutable tracking
retention, or qualify the broader retention/security policy. The non-cascading
parent protection from migration 0010 remains in force.

## Compatible API changes

| API | Behavior |
|---|---|
| `POST /api/v1/tasks/:id/archive` | Existing required `{ version }`; now also commits archive outbox/audit records |
| `DELETE /api/v1/tasks/:id` | Optional `{ version }`; supplied versions are validated and checked |
| `POST /api/v1/tasks/:id/restore` | Optional `{ version }`; supplied versions are validated and checked |
| `GET /api/v1/tasks?workspaceId=...&status=DELETED` | Explicit recovery query; returns only tenant-owned tasks inside the restore window |
| Existing task list/detail responses | Additive nullable `deletedAt` and `restoreUntil` fields |

Every new UI lifecycle request supplies a version and an `Idempotency-Key`.
**Legacy bodyless/empty-object delete and restore calls remain accepted**, without
an expected client-version check. This compatibility exception is intentional;
this report does not claim all legacy clients have optimistic lifecycle locking.

The shared idempotency parser now treats an empty body stream like no body. A real
HTTP test caught that the old `request.body !== null` check could attempt JSON
parsing on a zero-length stream. Nonempty malformed JSON still fails. Required-body
endpoints still validate their schemas and reject missing input.

Version checks and writes are workspace-serialized; delete/restore writes also use
source version and workspace in their SQL predicates. Invalid supplied versions
return 400, stale versions 409 and foreign resources 404. Access to another user's
workspace collection is denied with 403. Authentication, request IDs, no-store
headers and existing rate limiting remain in place.

Only explicit `status=DELETED` queries expose recoverable deleted content. Ordinary
queries—including `includeArchived=true` without the deleted status—still exclude
it. Normal task detail GET/PATCH continues to return 404 for deleted tasks. All
pagination envelopes and existing API paths remain unchanged.

Archive now emits `task.archived` and a content-free audit entry in the same
transaction as the task, tracking and sync changes. Restore adds a transactional
content-free audit entry alongside its existing outbox/sync/calculation behavior.
Audit failure rolls everything back. Durable outbox records do not imply a general
event consumer has been implemented.

No new migration, dependency, scoring model, recurring-task workflow or provider
integration was introduced.

## Verification

| Gate | Final result |
|---|---|
| Frozen-lockfile install | PASS |
| Lint | PASS, zero warnings |
| Five-package typecheck | PASS |
| Unit/integration/tooling | **329 passed**, 37 files, no skipped tests |
| Production build | PASS |
| Browser/API scenarios | **39 passed**, no retries |
| Core coverage | 96.66% statements / 85.88% branches / 100% functions / 99.75% lines; all four 85% gates pass |
| Whole-repo measured coverage | 84.99% statements / 79.61% branches / 88.60% functions / 89.70% lines; not an all-repo 85% claim |
| Recovery accessibility | Zero WCAG-tagged axe violations in the tested Trash view; keyboard restoration exercised |
| Dependency audit | **0 findings**, 364 dependencies |
| `git diff --check` | PASS |

Seven new real-PostgreSQL tests cover event/audit parity, stale versions, scoped and
expired Trash queries, preserved relationships/reminder cancellation, concurrent
quota/version enforcement, rollback, and exact cutoff plus 52-row pagination.
Five new browser/API scenarios cover archive/delete/restore, completed-task reopening,
confirmation/dirty/conflict behavior, versioned and legacy contracts, tenant isolation,
lost acknowledgements, and multi-page failure/retry.

Regression sequence: the first six service tests produced five missing-behavior
failures and one existing preservation pass. Initial browser tests failed on three
missing UI flows and the empty-stream compatibility defect. The first full browser
run then identified a serious contrast violation on the new recovery link (4.36:1
instead of 4.5:1); the new history links now use contrasting text styling. No test
or accessibility assertion was weakened. All final gates pass.

Environment: isolated PostgreSQL 18.4 UTF-8 and real Chromium 149. Evidence outside
Git: `/home/user/nextdoo-task-lifecycle/`, including `service-red.log`,
`service-green.log`, `browser-red.log`, `verify-first.log`, `verify-expanded.log`,
`final-install.log`, `final-verify.log`, `final-audit.json`. Expected negative-test
and unavailable production-SMTP logs do not establish provider delivery. Remote CI
and production deployment were not run.

Deploy the compatible API additions before the UI: older servers ignore version
bodies on delete/restore and do not provide the new Trash behavior. A mixed-version
rollout is not qualified. Existing migration 0010 remains required for the preceding
subtask slice; migrations 0000–0010 were not edited.

## Next Phase 1 work

Next: advanced task filtering/sorting, then safe bulk operations. These remain
separate from the 50-row pagination already delivered. Rich descriptions/location,
large-list virtualization, recurrence, complete workspace/planning settings and
broader analytics requirements remain open.

This slice does not deliver full offline operation, Calendar/billing integrations,
attachments, Windows desktop or Phase 2 collaboration. Production security,
retention, provider, load, observability and restore qualification remain open.
Scoped automated accessibility evidence is not full WCAG certification.


## Subsequent filtering/sorting continuation

The filtering/sorting work above is now delivered in
[TASK_FILTERING_MILESTONE.md](TASK_FILTERING_MILESTONE.md). The results in this
lifecycle report remain historical; the continuation records the latest validation
and limits. Safe bulk operations remain a separate next increment.
