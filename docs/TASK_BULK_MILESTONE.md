# Phase 1 tasks — atomic bulk operations

Date: 2026-09-09 (Asia/Calcutta). Continues `ece9122` on
`arena/01a080d5-nextdoo`. Implements PRD §6.9 / §14.3 bulk complete, archive and
reschedule. The user explicitly chose **all or nothing** when asked how to handle
one conflicting/ineligible task. This command policy is separate from the existing
per-mutation partial-result **sync** protocol; SY-09 is unchanged.

**Bulk is delivered; Phase 1 is not complete.** See
[PHASE1_COMPLETION_PLAN.md](PHASE1_COMPLETION_PLAN.md) for the remaining scope.

## Workflow

Browse tasks (`/tasks`) now provides:

- Per-task checkboxes, Clear selection, and **Select loaded tasks**. Only explicit
  IDs are submitted; hidden pages and all matching query results are never selected
  implicitly. Loading another page preserves existing selection without selecting
  the new rows. Selecting across pages is supported.
- A **100-task maximum** enforced in the schema and UI. Select loaded tasks is
  disabled when more than 100 rows are loaded; individual selection remains capped.
- A selected-title/version review list, count, and complete/archive/reschedule
  actions. Every new operation asks for confirmation before sending a request.
- Complete requires all selected tasks Active. Archive requires Active or Completed.
  Reschedule preserves the current status, matching existing single-task behavior
  (including Completed or Archived tasks); Trash is not editable here.
- Reschedule accepts one shared browser-local date/time or explicit **Remove due
  dates**, plus an optional reason. Empty dates do not silently clear schedules.
- Filter changes clear the selection. Editing a task clears selection before
  reloading, so selected versions are not silently upgraded after edits.
- Success clears selection and reloads canonical results. Stale versions and other
  rejected requests show an error and require explicit reload/review/reselection.

While sending or awaiting resolution of a failed acknowledgement, selection,
editing, filters and page continuation are disabled. A retry uses the **same body
and Idempotency-Key**, without asking the user to reconstruct a potentially already
committed request. Reload/review after an uncertain failure warns that it does not
undo the operation. Retry identity is retained in memory while this view is mounted,
not durably across navigation/reload or device restart. This is online bulk, not an
offline mutation queue. Other navigation can leave the view; users are instructed
to stay on the page to retry. No multi-device UI snapshot guarantee is implied.

No bulk delete, restore, tag/project movement or hidden-selection operation was added.

## API and transaction boundaries

New `POST /api/v1/tasks/bulk`, authenticated, origin-checked, idempotent, with a
10-request/user/minute command limit. Example request:

```json
{
  "workspaceId": "11111111-1111-4111-8111-111111111111",
  "operation": "reschedule",
  "tasks": [
    { "id": "22222222-2222-4222-8222-222222222222", "version": 4 }
  ],
  "dueAt": "2026-09-15T14:00:00Z",
  "reason": "Planning review"
}
```

`operation` is `complete`, `archive` or `reschedule`. `dueAt` (ISO timestamp or
explicit null) is required only for reschedule; its optional reason is limited to
500 characters. Other operations reject those fields. Payloads and row objects are
strict; empty/over-100 arrays, invalid versions, unsupported operations and duplicate
IDs are rejected. UUID uniqueness is **case-insensitive**, matching PostgreSQL UUID
identity. There is no filter-based write contract. Success returns `{ data: Task[] }`
with canonical updated versions in submitted order and existing camelCase task fields.

The request idempotency ledger, workspace lock and nested single-task services
share the same `AsyncLocalStorage` database transaction. If any selected row is
missing, foreign, stale, ineligible, or fails evaluation/audit, the whole transaction
rolls back. Task rows, tracking events/results, sync changes, reminders and outbox
entries cannot partially commit. The existing single-task services are reused,
not replaced by a separate bulk implementation of their business rules.

An aggregate content-free `tasks.bulk.<operation>` audit record includes count and
workspace, not task titles or reasons. Existing per-task events/audits remain.
Completion shares one timestamp across the batch and cancels pending reminders.
Rescheduling updates relative reminders and increments reschedule count as before;
removing due dates cancels relative reminders but not absolute reminders. Archive's
existing dispatch-time reminder policy is unchanged. Relationships, metadata and
active-timer policy are not modified. Tracking evaluates inline in the transaction;
no asynchronous tracking job or general outbox consumer is claimed.

Errors use existing RFC 7807 conventions: 400 validation, 401 unauthenticated,
403 forbidden workspace/origin, 404 unavailable task, 409 stale version or changed
payload under an existing key, 429 rate limit. Retries also consume rate-limit
budget. Same-key concurrent success replays the stored response; different-key stale
requests fail rather than reapply. Request IDs and no-store headers remain.

The shared route wrapper exempts only the exact static bulk command from UUID-path
validation. Existing resource-ID validation still runs for other task/project/section/
timer/reminder routes. Existing single-task endpoints and pagination are unchanged.

No migration, dependency or historical data rewrite. Deploy the API route before
exposing bulk controls; old servers have no bulk command. Mixed-version rollout,
production latency/load and server-wide distributed rate limiting are not qualified.
The command limit bounds work; the current limiter remains process-local.

## Validation

| Gate | Final result |
|---|---|
| Frozen install | PASS |
| Lint / five-package typecheck | PASS; zero lint warnings |
| Unit/integration/tooling | **363 passed**, 39 files, no skips |
| Production build | PASS |
| Browser/API scenarios | **50 passed**, no retries |
| Core coverage | 96.66% statements / 85.88% branches / 100% functions / 99.75% lines; all four 85% gates pass |
| Whole-repo measured coverage | 85.84% statements / 81.40% branches / 88.75% functions / 90.04% lines; not an all-repo 85% claim |
| Scoped accessibility | Zero WCAG-tagged axe violations in tested Browse tasks selection state; keyboard confirmation exercised |
| Dependency audit | **0 findings**, 364 dependencies |
| `git diff --check` | PASS |

Fourteen new real-DB tests cover all three operations and later-row rollback,
reminders/events/results/audits, tenant/deleted/illegal-state guards, overlapping
concurrent batches, injected audit failure, strict input bounds, exactly 100 tasks,
unselected preservation, null dates, and UUID case equivalence. Six browser/API
scenarios cover selection, confirmation cancel/keyboard, archive/reschedule/remove
schedule, filter reset, stale selection, lost acknowledgement, auth/origin/tenancy,
strict contracts, concurrent replay, changed-body conflict, rate limit and selection
across 52 loaded rows without implicit expansion.

Regression sequence: tests were written before production code; the initial service
run failed collection because the new service did not yet exist. Initial five
browser tests failed on the pre-feature build. Fixture assertions were corrected
for existing due-date tracking events and the real reminder `scheduledAt` field;
no behavior test was removed. A later regression specifically exposed differently
cased duplicate UUIDs, then passed after case-insensitive uniqueness validation.
The first full run passed 360 tests / 49 browser cases; the final expanded run
passed the numbers above.

Evidence outside Git: `/home/user/nextdoo-task-bulk/` including `service-red.log`,
`browser-red.log`, `uuid-red.log`, `service-expanded.log`, `verify-first.log`,
`final-install.log`, `final-verify.log`, `final-audit.json`. PostgreSQL 18.4 UTF-8 and
Chromium 149. Expected negative-test/unavailable production-SMTP logs are not
provider-delivery evidence. No remote CI, Windows/WebView2, production deployment,
full WCAG, ASVS certification, restore drill or SLO acceptance is claimed.
