# Day/week/month calendar with full period pagination — acceptance report

Date: 2026-09-09 (Asia/Calcutta). Scope: the next M2/M3 Task & Planning UX
increment from execution-order item 4 of
[PHASE1_COMPLETION_PLAN.md](PHASE1_COMPLETION_PLAN.md) — PRD §6.9 calendar
experience: **day, week and month views with full calendar
pagination/navigation**, correct task/date/timezone handling, existing task
actions from the calendar, tenant isolation and API compatibility. **This is
not full M2/M3:** the rich description editor and provider-aware capacity
planning remain open (explicitly not started per the agreed increment
boundary).

## Delivered behavior

- **Three views on one anchor** (`CalendarView.tsx`): the previous week-grid
  is preserved and joined by a day view (single local day, chips in
  time-of-day order) and a month view (42-cell, week-aligned grid including
  adjacent-month cells; leading/trailing cells show their real day number).
  All placement, boundaries and labels are computed in the **workspace time
  zone** (verified E2E against Asia/Kolkata, fixed UTC+5:30) with the
  workspace `weekStart` setting; the default-week E2E contract from
  `e2e/workspaces.spec.ts` (workday label, Sunday-first default) still passes
  unchanged.
- **Date boundaries:** a task at 23:59 IST belongs to that local day and a
  task at 00:00 IST to the next — verified across day navigation and in the
  week/month grids. Month navigation rebuilds the anchor from year/month/1,
  so January 31 + 1 month lands on February, not March.
- **Task actions from every view:** complete/reopen with the existing
  acknowledged-completion semantics and `cal-done` styling; edit through the
  shared `TaskEditor` dialog (in the day view the title opens the editor
  directly, since there is no other day in view); move by selecting a task
  and choosing a target day — per-day "Move here" buttons in the week view,
  clicking the target cell's day header in the month view, and drag-and-drop
  of a chip onto another day in the week view. **Moving preserves
  time-of-day** (server-side verified: Friday 23:59 IST → Saturday 23:59 IST
  with the same instant shape), via the existing
  `POST /api/v1/tasks/:id/reschedule` contract.
- **Full period pagination:** the visible period is loaded by following
  `next_cursor` on `GET /api/v1/tasks` until `has_more` is false, with
  in-flight request dedupe, abort on navigation (a superseded response can
  never render over a newer period), a `Loading more tasks…` status and a
  "Retry" path that re-runs the full loop. Weeks and months with **120 tasks**
  load completely in both views (E2E also asserts at least one `cursor=`
  request was made).
- **States:** per-day skeletons while loading, an empty note
  ("No scheduled tasks in this period."), and an error banner with Retry that
  recovers after a failed load (E2E drives slow/failed/recovered phases with
  a route interceptor).
- **Workday guideline:** each day shows an "over workday" mark when the sum of
  `estimateMinutes` of its loaded tasks exceeds the configured workday
  minutes — a local guideline over loaded data only. This is still **not**
  provider-aware capacity planning (no external calendar, no capacity
  computation beyond loaded estimates).
- **Tenant isolation and accessibility:** anonymous task reads 401, foreign
  workspace reads 403, foreign reschedule 404 (E2E). Axe
  (`wcag2a/21aa/22aa` + `wcag2aa`) is clean on `main` for the week and month
  views.

## Changes

- `packages/core/src/calendar.ts` — new `workspaceMonthGrid(now, zone,
  weekStart, monthOffset)`: 42 cells ending 41 days after the grid start,
  start = the week-start day containing the (offset) month's first, adjacent
  months included; `start` is hoisted from the computed first cell (index
  access on `Date[]` is `Date | undefined` under `noUncheckedIndexedAccess`).
  No changes to `workspaceWeek` or the existing window helpers.
- `packages/core/src/calendar.test.ts` — 3 new unit tests (6/6 total):
  42-cell count and week alignment, leading cell = previous month's last day
  with trailing overflow, `monthOffset` in both directions across a year
  boundary, Monday vs Sunday `weekStart`.
- `apps/web/src/components/views/CalendarView.tsx` — rewritten around an
  `anchor` + `periodKey` (current-period comparison disables "This week" /
  "This month" / "Today"), the cursor-pagination loop, the three renderers
  (day list, week grid, month grid), selection + move UI, and the shared
  editor integration. The previous week-grid DOM/behavior contract is
  retained (same list/grid roles, same workday subtitle line).
- `apps/web/src/app/globals.css` — `.cal-chip` layout, `.cal-title` /
  `.cal-compact` / `.cal-time` chip text, `.cal-edit`, `.cal-done .cal-title`
  strikethrough, `.cal-over-mark` (workday guideline), `.cal-month .card`
  min-height and `.cal-row-error`.
- `apps/web/e2e/calendar.spec.ts` (new) — 7 browser E2E tests against the
  production build, each on a fresh tenant with `timeZone: Asia/Kolkata` and
  `weekStart: 1` set through the workspace settings API:
  1. week view: local-day placement (Mon/Fri cells), move to Saturday with
     server-verified time-of-day preservation, edit via `#edit-title`,
     complete with the acknowledged-completion semantics, next-week
     navigation plus disabled "This week" in the current period;
  2. day view: single day, time ordering (bounding-box order), time labels,
     title opens the editor, complete, day navigation and Today reset;
  3. month view: 42 listitems, leading cell day number, select + click-cell
     move with server-verified preservation, month navigation, empty distant
     month note;
  4. pagination: 120 direct-DB tasks in the current week render fully in the
     week view and again in the month grid of the week's Monday (previous
     month clicked when the week starts before the 1st), with a `cursor=`
     request observed;
  5. timezone edges: 23:59 vs next-day 00:00 IST across "Next day";
  6. states: slow load → 7 skeletons → data, failed load → banner + Retry →
     recovery with the empty note;
  7. tenant isolation (401/403/404) plus axe on week and month views.

No API, contract, schema or migration changes; the existing `/calendar`
routes and `workspaces.spec.ts` E2E contract are untouched and passing.

## Verification (all executed in this environment)

- Core calendar unit suite: **6/6 pass** (vitest).
- New browser E2E suite `e2e/calendar.spec.ts`: **7/7 pass** (repeated run
  also 7/7).
- Full gates re-run green after the change: lint (`eslint . --max-warnings=0`),
  typecheck (5 packages + direct `tsc --noEmit` in `apps/web`),
  `test:coverage` (49 test files / 447 tests, thresholds held;
  `packages/core/src/calendar.ts` at 100% statements/branches/functions),
  production build, migration integrity (replay is a no-op; no new
  migration), and the complete E2E suite (**96 passed** = 89 baseline + 7
  new, including the `workspaces.spec.ts` default-week calendar contract).
- **Remote CI (exact state, unverified-green):** the push of this work
  (`25faa7f`) and the follow-up PR run failed at the runner step
  `pnpm --filter @nextdoo/web exec playwright install --with-deps chromium` —
  a GitHub-hosted environment step, not a code step (the same step passed in
  the three runs one to five hours earlier; this commit changes no lockfile
  or Playwright configuration). A no-op re-run commit (`67d206f`) was pushed
  to re-trigger; the immediately preceding run (virtualization, `aa38908`)
  failed at `pnpm test:coverage` with logs unreachable from this sandbox
  (results-blob CDN blocked; API/annotations available). CI status for
  `67d206f` could not be polled because the sandbox GitHub token expired
  after the push. All code-level gates above are green locally on the exact
  pushed tree.
