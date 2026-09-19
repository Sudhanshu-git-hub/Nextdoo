# Task location field — acceptance report

Date: 2026-09-09 (Asia/Calcutta). Scope: the first M2/M3 Task & Planning UX
increment selected from execution-order item 4 of
[PHASE1_COMPLETION_PLAN.md](PHASE1_COMPLETION_PLAN.md) — the task `location`
field (PRD §6.3 lists `location` among the required task fields). **This is not
full M2/M3:** the rich description editor, list virtualization above 200 rows,
calendar pagination and day/month views remain open.

## Delivered behavior

- `location` is a free-text field (max 500 characters, whitespace-trimmed,
  nullable) on every task, mirroring the title length bound. Existing rows keep
  `NULL`; nothing else about task semantics changed.
- **Create:** `POST /api/v1/tasks` accepts `location`; it is persisted and
  returned in the serialized task and in the `sync_changes` payload.
- **Update:** `PATCH /api/v1/tasks/:id` accepts `location` (including clearing
  it with `null`) through the existing optimistic-locked `updateTask` flow;
  each change bumps `version`, records a `sync_changes` entry and is published
  as a `task.updated` field change.
- **Read:** `GET /api/v1/tasks` and `GET /api/v1/tasks/:id` return
  `location` (via the shared `serialiseTaskRecord`), so every existing surface
  (lists, editor, board, tracking export) sees it without further changes.
- **Sync:** `location` is in the client-writable task field boundary
  (`WRITABLE_TASK_FIELDS`); offline `create`/`update` mutations carry it,
  unknown fields are still dropped, and `GET /api/v1/sync/pull` change payloads
  include it. Recurrence-generated occurrences inherit the template's
  `location`, matching how description/project/priority already propagate.
- **UI:** the task editor gains a **Location** input (max 500) next to Notes;
  the draft/diff logic only sends the field when it changed, and the
  conflict banner shows the server's location alongside the other fields.
- **Validation and tenant isolation:** over-bound values are rejected by the
  shared contract (HTTP 400 `VALIDATION_FAILED`) before any write; foreign
  accounts get 404 on read/update and `rejected` sync mutations, so one
  workspace cannot read or write another workspace's location.

## Changes

- `packages/db/migrations/0016_task_location.sql` —
  `ALTER TABLE tasks ADD COLUMN location varchar(500)` (existing rows NULL).
- `packages/db/src/schema.ts`, `task-record.ts` — column and canonical
  serialization (feeds every API response and sync payload).
- `packages/contracts/src/schemas.ts` — `location` on `createTaskSchema` and
  `updateTaskSchema` (`z.string().trim().max(500).nullish()`).
- `apps/web/src/server/services/tasks.ts` — create insert and update patch.
- `apps/web/src/server/services/sync.ts` — writable-field boundary.
- `packages/db/src/recurrence.ts` — occurrence inheritance.
- `apps/web/src/lib/api.ts` — client `Task` type.
- `apps/web/src/components/TaskEditor.tsx` — editor input, draft diff,
  conflict display.

No unrelated task functionality was rewritten; bulk, timers, tracking and
recurrence flows are untouched except the one-line occurrence inheritance.

## Verification (all executed in this environment)

- Migration 0016 applied via `pnpm db:migrate`; replay is a no-op
  ("Already up to date"); column verified as `character varying(500)`.
- New regression suite
  `apps/web/src/server/services/task-location.integration.test.ts` (6 tests,
  real PostgreSQL): create persistence + sync payload; set/change/clear with
  version bumps and per-change sync payloads; over-bound rejection at the
  shared contract with the 500-character boundary accepted end to end; tenant
  isolation (foreign update 404, foreign sync rejection); sync create/update
  through the writable-field boundary (unknown fields dropped); recurrence
  occurrences inherit the template location. **6/6 pass.**
- New browser E2E `apps/web/e2e/task-location.spec.ts` (4 tests against the
  real production build): create/read plus editor round trip (display, edit,
  save, reopen, clear) with over-bound HTTP validation; sync push/pull round
  trip carrying location; foreign-account read/update/sync refusal; axe-clean
  editor with the new field. **4/4 pass.**
- Full gates re-run green after the change: lint, typecheck, `test:coverage`
  (48 test files, 86.16% statements overall), production build, and the
  complete E2E suite (**83 passed**, including the 4 new tests).
- Test-infrastructure defect found during verification and fixed (recorded per
  the ledger): the M6 export integration suite asserted global pass counts
  against a persistent scratch database and broke on re-runs with leftover
  `PENDING` rows; it now clears its feature-owned `exports` rows and export
  notifications in `beforeAll`, keeping every assertion intact.
