# Phase 1 core tasks — subtasks and dependencies

Date: 2026-09-08. Continues `dd2369a` on `arena/01a080d5-nextdoo`.
Bounded delivery against PRD §6.3, §13.3 and Milestone 2. This does **not** finish
all core-task requirements or move the product out of Phase 1.

## What is now usable

Open a task and expand **Subtasks and dependencies**:

- Create an actual subtask, open/edit it with the existing editor, navigate to its
  parent and return to the previous task. Navigation uses one dialog at a time.
- Find existing workspace tasks, set/remove a parent, and add/remove prerequisites.
  Search results include status and a short identifier to disambiguate equal titles.
- Browse subtasks and prerequisites through 50-item continuation pages. Failed
  continuation retains loaded rows and provides retry. Search results are paged too.
- Keep unsaved subtask input on failure/conflict; Escape/navigation/discard requires
  confirmation. Dirty task metadata cannot race a relationship mutation. Conflicts
  require an explicit task/relationship reload and review before another attempt.
- Retry the same uncertain request with the same in-memory idempotency identity.
  This does not preserve requests or drafts across navigation/reload.

### Preserved lifecycle semantics

Subtasks are ordinary, independent tasks. At creation they start in the parent's
current project and section, without copying dates, priority, estimates or tags.
Subsequent moves, edits, completion, archive and soft deletion do not cascade.
Creating a subtask in an archived project is rejected by the existing assignment
rules. Parent and prerequisite links may otherwise span projects in one workspace.

Parent hierarchy and prerequisite graphs are separate. Both reject cycles, but a
parent is not automatically a prerequisite. Prerequisites express order; they do
not introduce automatic scheduling, completion gating, rollups or cascade behavior.
Those behaviors would need explicit product decisions rather than silently changing
existing task completion semantics.

A deleted parent is shown as unavailable and can be detached without deleting the
child. Deleted prerequisites are hidden from normal task lists while their edges
remain for recovery; an edge to a deleted task can still be removed through the
versioned API using its known ID. A dedicated deleted-link cleanup UI is not added.

## Compatible APIs

| Method | Path | Contract |
|---|---|---|
| GET | `/api/v1/tasks/:id/relations` | Current task, visible parent or null, and `parentUnavailable` |
| POST | `/api/v1/tasks/:id/subtasks` | `{ version, title }`; version belongs to the parent |
| PATCH | `/api/v1/tasks/:id/relations` | `{ version, parentTaskId?, addDependencyId?, removeDependencyId? }`; version belongs to the source task |
| GET | `/api/v1/tasks?...&parentTaskId=:id` | Direct children, using the existing task pagination envelope |
| GET | `/api/v1/tasks?...&dependencyOfTaskId=:id` | Prerequisites of this task, using the same pagination envelope |

`parentTaskId: null` detaches. Titles trim to 1–500 characters. Relationship patches
require at least one change and cannot add/remove the same prerequisite together.
Mutations require `Idempotency-Key`; request IDs, no-store protection, problem-details
errors and authenticated workspace scope are retained. The mutation routes are
limited to 120 requests per minute per user/route.

Invalid input returns 400, unauthenticated access 401, inaccessible/deleted resources
404, stale versions 409 and cycles **422 DEPENDENCY_CYCLE**. Removal addresses only
an authorized source's edge and does not reveal whether a supplied target exists.

Creating a child validates the parent's version under the workspace lock but does
not increment the parent version: different children are independent creations.
Relationship PATCH increments the source version, including accepted no-op requests
with a new identity; replaying the same identity returns the original response.

### Data integrity and audit

Workspace transactions serialize graph validation and writes. Recursive queries use
`UNION` to terminate even around previously cyclic data, and include soft-deleted
nodes so restoring a node cannot create an overlooked cycle. Concurrent opposing
edges cannot both commit; same-source edits also use optimistic versions.

Child creation reuses existing task creation, quota checks, tracking, sync, outbox
and audit behavior. Relationship updates commit the link, source version, task sync
change, `task.updated` outbox event and `task.relationships_updated` audit together.
Audit/outbox metadata contains field names, versions and relationship IDs—not task
names or descriptions. An audit failure rolls back the whole mutation.

The task delta includes `relationsChanged: true` and `relationshipChanges` for
invalidation/change information. Authoritative relationship collections are read
through the paginated endpoints; this is not a complete offline graph snapshot.
Other task deltas omitting relationship fields do not remove database links.

Existing sync create with a parent retains its previous behavior. Parent changes
remain unsupported through generic sync updates. Newly introduced dependency
commands are explicitly rejected by sync rather than ignored and falsely
acknowledged. Full offline relationship editing and reconciliation remain deferred.

## Forward migration and rollout

**Apply `0010_non_cascading_task_parent.sql` before enabling this UI.**

The inherited parent FK used `ON DELETE CASCADE`: permanently deleting a parent
could silently remove a live child. The new migration changes it to `NO ACTION`.
An individual permanent delete is blocked while children still reference the
parent. An explicit, versioned detach is required first; there is no silent
`SET NULL` update bypassing versions/sync. Whole-account purge still works because
all task rows in that workspace are removed together, verified with a hierarchy
and dependency edge.

Migrations 0000–0009 remain unchanged. Existing relationships are not rewritten.
Migration execution and replay pass, as does the repository's migration test suite.
Deployment must account for the FK alteration's table lock; staging rollout/load
and disaster-recovery qualification are not claimed. Do not reverse this protection
by editing an already-applied migration.

## Regression discovered in pagination

A 52-child database fixture exposed an existing cursor precision defect: JavaScript
Date serialization truncated PostgreSQL microseconds, so the second page could
skip remaining tasks sharing the same precise timestamp. The query now emits an
exact UTC timestamp string for the opaque cursor and compares it without converting
through JavaScript Date. The cursor retains its existing `{ c, i }` structure and
accepts older millisecond timestamp values. Invalid datetime/UUID values are
validated before the query. The permanent test uses a deterministic six-decimal
SQL timestamp and checks all 52 unique IDs across both pages.

This repair also benefits existing task lists. It is not cursor-expiry support,
virtualization, or a guarantee of immutable paging across relationship changes.

## Verification

| Gate | Final result |
|---|---|
| Frozen installation | PASS |
| Migration 0010 and replay | PASS; historical checksums retained |
| Lint | PASS, zero warnings |
| Five-package typecheck | PASS |
| Unit/integration/tooling | **322 passed**, 36 files, no skipped tests |
| Production build | PASS |
| Browser/API scenarios | **34 passed**, no retries |
| Core coverage | 96.66% statements / 85.88% branches / 100% functions / 99.75% lines; all four 85% gates pass |
| Whole-repo measured coverage | 84.48% statements / 78.85% branches / 88.25% functions / 89.09% lines; not an all-repo 85% claim |
| Changed editor accessibility | Zero WCAG-tagged axe violations in the tested expanded editor; keyboard creation/navigation controls verified |
| Dependency audit | **0 findings**, 364 dependencies |
| `git diff --check` | PASS |

Twelve new real-PostgreSQL tests cover creation/navigation, version/event parity,
cycle/concurrency/tenant boundaries, rollback, independent lifecycle, permanent-delete
protection, unsupported sync commands, deleted-node cycles, paging and account purge.
Five new E2E/API scenarios cover user workflows, HTTP contracts, lost acknowledgement,
conflict/dirty-state protection and multi-page failure/retry.

Regression sequence: initial seven service tests failed before implementation,
including the actual cascading-delete defect. The first browser run had three
missing-controls failures and one passing HTTP contract scenario. Expanded tests
then exposed sync's false acknowledgement of unsupported dependency commands and
the timestamp cursor defect; both were fixed without removing or weakening tests.

Evidence outside Git: `/home/user/nextdoo-task-relations/`, including
`service-red.log`, `browser-red.log`, `sync-command-red.log`, `service-expanded.log`,
`service-expanded-green.log`, `migration.log`, `final-migration-replay.log`,
`final-install.log`, `final-verify.log`, `final-audit.json`.
Environment: isolated PostgreSQL 18.4 UTF-8 and real Chromium 149. Expected negative-
test and missing-production-SMTP logs do not establish provider delivery. Remote CI
and production deployment were not run.

## Still Phase 1 — next core-task work

Next: complete task archive/delete/recovery UI, then advanced filtering/sorting and
bulk actions. Rich descriptions/location, large-list virtualization and remaining
workspace/planning requirements are not completed by this slice.

No recurrence workflow, full offline client, Google Calendar, billing integration,
attachments, desktop, Phase 2 collaboration or enterprise feature was added. Prior
production security, retention, provider, accessibility, load, observability and
restore gates remain open. Scoped axe checks are not full WCAG certification.
