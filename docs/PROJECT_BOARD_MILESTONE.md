# Project sections and board milestone

Date: 2026-09-08. Incremental continuation of project lifecycle commit `9b4fd9a`;
branch `arena/01a080d5-nextdoo`. Implements a bounded part of PRD §6.4, not the
whole MVP or a production-release qualification. Existing architecture, API
conventions, migrations and prior functionality are preserved.

## Delivered behavior

- **List / Board toggle** inside a project; List remains the default.
- Create and rename sections, with server validation and retained drafts on errors.
- Move sections earlier/later using keyboard-operable controls. Reordering changes
  one section row/version, not neighbouring rows. Normal writes also create sync,
  outbox and audit records in the same transaction.
- Drag loaded task cards between sections, or use the labelled destination select
  and explicit Move button without dragging. Success is announced; keyboard focus
  moves to a persistent status message. Rename restores trigger focus and section
  reorder focuses the moved heading.
- Existing task completion/editing stays available. Opening the task editor lets
  users move to another active project or Inbox; the existing server behavior
  clears the old section when the project changes without an explicit section.
- Stale task movement returns 409 and refreshes without applying the stale move.
  Section conflicts refresh canonical names/order while retaining the rename draft;
  users must review and save again. No automatic stale mutation replay/rebase.
- Section mutations are disabled in archived boards and rejected server-side.
  Existing tasks remain visible/editable as established by the lifecycle milestone.
  The existing task API's unchanged-project edit semantics are not tightened here.
- Unsectioned and unavailable-section tasks remain visible in an Unsectioned column.
  The board uses the existing 50-task pagination, with explicit **loaded** counts,
  continuation and retry. Counts are not column totals for the entire project.

## Compatible API additions

| Method | Path | Contract |
|---|---|---|
| GET | `/api/v1/sections?projectId=<uuid>` | Authenticated, scoped project lookup; `{ data: [...] }` in `(position,id)` order |
| POST | `/api/v1/sections` | `{ projectId, name, position? }`; default append |
| PATCH | `/api/v1/sections/:id` | `{ version, name?, beforeId?, position? }`; at least one change |

Names trim to 1–200 characters. `beforeId` means immediately before an existing
undeleted section in the same project; `null` appends. Self/foreign/deleted anchors
are rejected. `position` and `beforeId` cannot be supplied together. The optional
numeric position input is bounded to ±10^12 and normalized to ten decimal places;
the browser uses server-calculated anchors, not floating-point midpoints.

Mutation endpoints require `Idempotency-Key` and retain existing problem-details,
request IDs, authentication, workspace authorization, rate limiting and optimistic
versions. Invalid input returns 400, unauthenticated access 401, inaccessible
resources 404 and stale versions 409. Workspace transaction locking serializes
reference checks, project archive and ordering writes. Section responses retain
the database decimal position as a string.

Exact scaled-BigInt arithmetic calculates positions for PostgreSQL `numeric(30,10)`.
Prepend/append leave a 1024-unit gap; insertion uses the exact representable midpoint.
When neighbours are tied or no representable midpoint remains, the operation fails
with 409 and changes no versions/events; choose another position. Range exhaustion
fails with 400. There is **no implicit multi-row rebalance**. Explicit positions can
share a key, with ID as the deterministic tie-breaker; inserting into that tied gap
is rejected rather than silently rounding or scrambling order.

`section.created` and `section.updated` have canonical sync payloads, a transactional
outbox event and content-free audit metadata (IDs, field names and version, not
section names). Default sections on newly created projects now receive these same
records atomically, after the parent project record. A section audit failure rolls
back its write and the parent creation where applicable. No historical backfill
or general outbox consumer is claimed. Task moves reuse existing `task.updated`
outbox/sync behavior; this slice does not add a separate task-move audit event.

An uncertain-response retry uses the same section/task mutation identity while
the board remains mounted and the request is unchanged. This is not a durable
offline queue or a retry guarantee across navigation/reload.

## Verification

| Gate | Result |
|---|---|
| Frozen-lockfile install | PASS |
| Lint | PASS, zero warnings |
| Five-package typecheck | PASS |
| Unit/integration/tooling | **301 passed**, 33 files, no skipped tests |
| Production build | PASS |
| Playwright E2E/API | **25 passed**, no retries |
| Core coverage | 96.66% statements / 85.88% branches / 100% functions / 99.75% lines; all four 85% gates pass |
| Whole-repo measured coverage | 80.68% statements / 75.20% branches / 82.78% functions / 85.54% lines; not an all-repo 85% claim |
| Board accessibility | Zero WCAG-tagged axe violations in the tested board; keyboard rename/reorder/movement verified |
| Dependency audit | **0 findings**, 364 dependencies |
| `git diff --check` | PASS |

Nine new real-PostgreSQL service tests cover event parity, single-row ordering,
concurrent edits, cross-tenant/cross-project references, archived/deleted resources,
audit rollback including parent creation, task moves, and density exhaustion.
Two unit tests exercise decimal midpoint/edge cases, including beyond JavaScript's
safe-integer range. Six new browser/API scenarios cover keyboard and pointer moves,
conflicts, HTTP contracts and tenant isolation, multi-page failure/retry, lost-create
acknowledgement, cross-project movement and archived-board controls.

Regression sequence: the initial six service tests produced five missing-behavior
failures and one existing-task-movement pass, then passed after implementation.
The first two browser scenarios failed on the missing Board control before UI work;
the API scenario already passed. Later tests expanded this evidence without removing
or weakening existing tests. One expanded rollback assertion initially forgot the
fixture's account-registration audit row; it was corrected to count registration,
project and default section, not treated as an implementation regression.

Environment: isolated real PostgreSQL 18.4 UTF-8 and Chromium 149. Evidence lives
outside Git at `/home/user/nextdoo-board/`: `sections-red.log`, `browser-red.log`,
`sections-final.log`, `final-install.log`, `final-verify.log`, `final-audit.json`.
Expected negative-test logs and missing-production-SMTP warnings do not establish
email delivery. Remote CI and production deployment were not run.

## Deliberate limits / next bounded work

No section deletion, section pagination, card-ordering UI, project analytics,
subtasks/dependencies, recurrence, workspace-settings completion, full offline
reconciliation, AI, billing, Calendar, attachments or desktop delivery is claimed.
Project analytics and richer task-management remain future bounded slices.

The board is a view of loaded active tasks, not a complete Kanban dataset. Movement
refreshes from the first page; loading more is required again. Horizontal scrolling
is not virtualization, and these tests do not qualify large section collections.
The previous cursor-expiry and large-list gaps remain.

Deploy these APIs before the board UI; older servers do not implement the routes.
No mixed-version rollout qualification is claimed. Fractional persisted positions
alone do not make the complete drag-and-drop workflow offline-safe. Existing
production security, retention, provider, observability, load and disaster-recovery
blockers remain; scoped axe checks are not full WCAG certification.


## Subsequent continuation

Aggregate project reporting is now described in
[Project execution analytics milestone](PROJECT_ANALYTICS_MILESTONE.md). This board
report retains its original validation counts and milestone-specific evidence.
