# Task list virtualization above 200 rows — acceptance report

Date: 2026-09-09 (Asia/Calcutta). Scope: the next M2/M3 Task & Planning UX
increment from execution-order item 4 of
[PHASE1_COMPLETION_PLAN.md](PHASE1_COMPLETION_PLAN.md) — PRD §6.9 "list
virtualization above 200 rows". **This is not full M2/M3:** the rich
description editor, complete calendar pagination and day/month views remain
open (explicitly not started per the agreed increment boundary).

## Delivered behavior

- The task browser's result list (and every other `TaskList` consumer) renders
  **every row exactly as before when 200 or fewer tasks are loaded** — the
  threshold is "above 200", matching the PRD wording. Inbox, Today, History,
  Focus, Recurrence, Projects and the project board are therefore byte-for-byte
  unchanged in rendering.
- When **more than 200 tasks are loaded**, the list switches to windowed
  rendering: only the rows intersecting the viewport plus 12 rows of overscan
  on each side are real DOM rows; every other row is a height-only
  `<li>` placeholder. The document keeps the exact scroll height, the list
  order, and the cursor pagination contract untouched — virtualization
  operates on the already-loaded set only (no API change, no new endpoint, no
  schema/migration change).
- Row heights are measured with a single shared `ResizeObserver` (per-row
  measured height + the collapsed 7px inter-row gutter); unmeasured rows use
  the 80px estimate. A focused row is pinned in the window, so keyboard focus
  is never culled out from under the user; placeholders are `aria-hidden` and
  contain no focusable or linked content, so the tab order is the real rows in
  display order.
- Task actions keep working at any depth: complete/reopen (with the existing
  acknowledged-completion and conflict semantics), opening the editor and
  saving, drag start, and bulk selection (selection state lives in
  `TaskBulkList`, so it survives rows unmounting as placeholders; the existing
  `MAX_BULK_TASKS` = 100 gating and "Select loaded tasks" hint still apply).
- Loading (skeletons), error (banner + retry) and empty states are unchanged;
  tenant isolation and all API contracts are preserved and re-verified.

## Changes

- `apps/web/src/lib/task-window.ts` (new) — pure, dependency-free window math:
  `computeTaskWindow({ total, heights, viewportTop, viewportHeight,
  focusedIndex, overscan })` with prefix sums + binary search, focus
  extension, and the `VIRTUALIZATION_THRESHOLD = 200` /
  `VIRTUALIZATION_OVERSCAN = 12` / `ESTIMATED_ROW_HEIGHT = 80` constants.
- `apps/web/src/lib/task-window.test.ts` (new) — 7 unit tests: threshold
  boundary (200 vs 250), top/middle/bottom scroll positions, variable
  measured heights with estimate fallback, focus extension (including out-of-
  range indices), viewport-miss bounds, custom overscan.
- `apps/web/src/components/TaskList.tsx` — the row markup is extracted into an
  internal `TaskRow` (rendered output identical to before, verified by the
  full E2E suite) and a new `VirtualizedTaskList` renders the windowed path:
  rAF-coalesced page-scroll/resize tracking via the list's bounding rect,
  stable per-index ref callbacks (ref churn would re-fire the ResizeObserver
  into a re-render loop — guarded against), a change-guarded observer
  callback, and a focus pin via `onFocusCapture`. Test hooks:
  `data-virtualized` on the list and `data-virtual-placeholder` /
  `data-task-index` on placeholders.
- `apps/web/src/app/globals.css` — one rule: `.task-list-placeholder { list-style: none; }`.
- `apps/web/e2e/task-virtualization.spec.ts` (new) — 6 browser E2E tests
  against the production build, seeding 250 tasks per user via direct drizzle
  inserts (bypassing the 120/min task-POST rate limit) with strictly ordered
  `created_at` values: full 5×50 pagination with `has_more` ending false;
  window bounds (250 `li`, <100 real rows, ≥150 placeholders) with exact
  consecutive ordering at top and bottom; deep-row complete (server-side
  verified) and deep-row edit through the dialog; bulk >100 gating with
  selection persisting across scroll and an all-or-nothing complete;
  small-list (3 rows) and empty-workspace rendering unchanged; focus pinning
  with a bounded window plus axe (WCAG 2.0/2.1/2.2 A+AA) on the results
  section; tenant isolation (anonymous 401, foreign complete 404).

No other app code was touched; no API, contract, schema or migration changes.

## Verification (all executed in this environment)

- New window-math unit suite: **7/7 pass** (vitest).
- New browser E2E suite `e2e/task-virtualization.spec.ts`: **6/6 pass**.
- Full gates re-run green after the change: lint (5 packages), typecheck
  (5 packages), `test:coverage` (49 test files / 444 tests, 86.16% statements
  overall, thresholds held), production build, migration integrity (replay of
  0016 is a no-op; no new migration), and the complete E2E suite
  (**89 passed** = 83 baseline + 6 new, including board, task-bulk,
  task-query, recurrence and tracking specs that share the task list and
  pagination surfaces).
