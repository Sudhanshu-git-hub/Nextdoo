# Phase 1 core tasks — filtering and sorting

Date: 2026-09-09 (Asia/Calcutta). Continues `f622e1a` on
`arena/01a080d5-nextdoo`. Implements the bounded filtering/sorting portion of
PRD §6.9's list view. **This is not all core task management or Phase 1 completion.**
Bulk operations remain a separate next increment.

## Delivered workflow

- **Browse tasks** at `/tasks`, linked from Inbox and an open project, searches the
  whole current workspace. Its initial view is Active tasks, newest first.
- Explicit **Apply filters** combines whole-word title/description search, status,
  project/unfiled, tag, priority, due-date presence and inclusive due-day bounds.
  Status choices are Active, Completed, Archived, or Active and completed.
  Trash remains in Task history; normal filtered lists do not expose deleted data.
- Six sorts, each ascending or descending: created date, due date, priority,
  estimate, project name and stored custom position. Custom position is a read of
  the existing value, not a new drag-reorder or per-view order mutation.
- **Reset filters** returns to workspace-wide Active/newest-first results. Draft
  changes are labeled unapplied until submitted. Invalid ranges leave applied
  results intact. Selecting No due date clears/disables the date range.
- Date inputs use **this browser's timezone**, not implicitly the account timezone.
  The end of a day retains PostgreSQL's final microsecond. UTC and Asia/Kolkata
  browser scenarios verify boundaries; this is not exhaustive timezone/DST testing.
- Existing task editing, completion and lifecycle controls remain available.
  Filters use the existing 50-row hook: failed continuation retains loaded rows;
  retries continue the same query; filter changes abort/discard old requests and
  remove old rows/cursors/editors. A concrete keyed results boundary prevents stale
  list fragments surviving filter changes.
- Native explicitly labeled inputs/selects, keyboard submission, live loaded-count
  and unapplied-change messages, empty states and retry controls are provided.

Inbox, Today, project list/board and Task history retain their fixed collection
semantics. Today's cached fallback is unchanged. The new browser is **online-only**:
no unfiltered cache is presented as filtered results. Choices come from tenant-scoped
projects/tags on page load; reload the page to refresh choices created elsewhere.
Filters are local component state, not saved views or shareable URL state. Navigating
away/reloading resets them. Search is PostgreSQL simple full-text word matching,
not substring/fuzzy search.

## Compatible query contract

Still `GET /api/v1/tasks`, camelCase query fields and existing task serialization:
`{ data, pagination: { next_cursor, has_more } }`. No field from internal sort
selection is leaked into task responses. The default API query remains Active plus
Completed, ordered by createdAt DESC then ID DESC. UI explicitly requests Active.

| Optional field | Values / behavior |
|---|---|
| `sortBy` | `createdAt`, `dueAt`, `priority`, `estimateMinutes`, `project`, `position` |
| `sortOrder` | `asc`, `desc`; if omitted, createdAt/priority use DESC, others ASC |
| `priority` | `NONE`, `LOW`, `MEDIUM`, `HIGH` |
| `hasDueDate` | Boolean or query-string `true`/`false`; other strings rejected |

Existing status, projectId, unfiled, tagId, q, dueAfter/dueBefore, parentTaskId,
dependencyOfTaskId and includeArchived filters remain additive AND predicates before
pagination. Unfiled plus a project is rejected as before. Reversed date bounds and
No due date plus either bound now return validation errors. Date comparisons retain
sub-millisecond precision, including offset-aware reversed-range validation.

Sort semantics:

- Missing due dates, estimates and project names are **last in either direction**.
  Estimate zero and priority NONE are real values, not missing values.
- Priority uses HIGH=3, MEDIUM=2, LOW=1, NONE=0, not enum/lexical ordering.
- Project uses `lower(name) COLLATE "C"` with a workspace-scoped, nondeleted-project
  left join. This is deterministic case-insensitive ordering, not locale-aware
  dictionary ordering. Archived project names are included; unavailable projects
  sort with missing values.
- Timestamp keys preserve PostgreSQL microseconds. Position keys preserve all
  `numeric(30,10)` digits without converting through JavaScript Number.
- Equal sort values use task UUID in the same direction. Fixed SQL expressions,
  parameterized comparisons and tenant predicates remain authoritative.

## Cursor compatibility and limitations

New opaque base64url cursors have version, query fingerprint, sort, direction,
exact textual/null key and UUID. The SHA-256 fingerprint binds workspace and query
filter values/order; page size and cursor are excluded, so changing limit is allowed.
A mismatched or malformed new cursor returns HTTP 400 with refresh guidance.
The maximum accepted cursor grows from 500 to 2048 characters for Unicode project
names. Maximum 200-character Unicode names are exercised through continuation.

Previously issued `{ c, i }` cursors are still accepted **only for createdAt DESC**.
They predate filter binding and remain a documented compatibility exception.
Cursors are **unsigned pagination tokens, not authorization or integrity proofs**.
A caller can construct a token, but cannot bypass workspace/retention predicates.
Foreign workspace requests remain forbidden; foreign project/tag IDs cannot broaden
results. Authentication, no-store headers and request IDs are preserved.

Pagination is live, **not a snapshot**. A newer created-date insert does not shift an
existing descending continuation; changes to due dates, priorities, project names,
positions, filters or lifecycle status during paging can move rows across a cursor.
Refresh to reconcile changes. Client deduplication is not a snapshot guarantee.

Deploy the API before enabling the UI. Older servers silently ignore unknown sort
fields and cannot consume new cursor shapes; mixed-version routing is not qualified.
Clients must treat cursors as opaque and restart the query after a relevant rollout
or filter change. No migration, dependency, retention policy or provider integration
was added; migrations 0000–0010 remain unchanged.

## Verification

| Gate | Final result |
|---|---|
| Frozen-lockfile install | PASS |
| Lint / five-package typecheck | PASS, zero lint warnings |
| Unit/integration/tooling | **349 passed**, 38 files, no skips |
| Production build | PASS |
| Browser/API | **44 passed**, no retries |
| Core coverage | 96.66% statements / 85.88% branches / 100% functions / 99.75% lines; all four 85% gates pass |
| Whole-repo measured coverage | 85.51% statements / 80.94% branches / 88.67% functions / 89.98% lines; not all-repo 85% coverage |
| Accessibility | Zero WCAG-tagged axe violations in the tested Browse tasks subtree; keyboard Apply exercised |
| Dependency audit | **0 findings**, 364 dependencies |
| `git diff --check` | PASS |

Twenty new real-PostgreSQL tests cover all 12 sort/direction combinations, nulls,
ties, zero, microseconds, oversized exact decimals, combined filters, due-bound
precision, cursor binding/malformed keys/legacy compatibility, foreign filters,
deleted exclusion, Unicode names, concurrent inserts and sort defaults.
Five new browser/API scenarios cover combined filtering/reset/empty states, scoped
axe and keyboard submission, 52-row sorting with failed continuation/retry and late
response isolation, initial failure/retry and invalid ranges, API/tenant contracts,
and browser-local due days.

Regression evidence, including resolved failures:

1. Initial 16 service tests: 13 failed / 3 passed for missing query behavior.
2. Initial four browser tests on the pre-UI build failed as expected.
3. Additional precision test exposed millisecond truncation in existing date-bound
   filtering: exact microsecond matches returned no rows. Parameterized database
   timestamp bounds and precise range validation fixed it.
4. First full run: 348 service tests passed; 40 browser cases passed, three new cases
   failed on select-label lookup and an error locator also matching Next's route
   announcer. Explicit separate labels and a correctly scoped error assertion fixed
   those without removing checks.
5. The next browser run exposed old result fragments retained alongside new rows
   after filtering (four instead of one; 100 instead of 50). The keyed concrete
   results subtree fixed this functional stale-results defect. The same assertions
   then passed; final expanded verification passed all gates above.

Evidence outside Git: `/home/user/nextdoo-task-filters/`, including `service-red.log`,
`precision-red.log`, `browser-red.log`, `verify-first.log`, `browser-second.log`,
`browser-third.log`, `final-install.log`, `final-verify.log`, `final-audit.json`.
Environment: isolated PostgreSQL 18.4 UTF-8 and real Chromium 149. Negative-test
errors and unavailable production-SMTP messages are expected, not evidence of
provider delivery. Remote CI and production deployment were not run.

## Remaining Phase 1 work

Next: safe bulk complete/archive/reschedule, separately verified for selection,
confirmation, versions, retry and concurrency. This slice does not add bulk writes,
large-list virtualization, saved views, recurrence, rich descriptions/location,
complete planning/settings, full offline operation, external Calendar/billing,
attachments, desktop or Phase 2 collaboration. Production-scale sort query plans,
load/observability/restore/provider qualification remain open. Scoped axe is not
full WCAG certification; a clean dependency audit is not security certification.
