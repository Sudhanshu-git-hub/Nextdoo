# PC1 — Goal Center

Goal Center connects personal outcomes to existing task work. A user can create a goal, break it into sub-goals and milestones, link real tasks, and see progress change when those tasks complete or reopen. Stable `G1` / `G1.M1` references survive edits and archival.

## Delivered boundary

- Authenticated `/goals` list and detail pages, paginated goal/parent selection, metadata forms, archive/restore and completion/reopening.
- Optional parent hierarchy, cycle prevention and a 20-level bound. Dates are optional, validated together and displayed in the browser's time zone.
- Existing-task search/link/unlink and access to the existing task editor. Task lifecycle and execution scores remain owned by the task module.
- Derived progress deduplicates task UUIDs across the active subtree. Empty milestones contribute manual completion units; empty goals are unmeasured. Archived descendants/milestones and deleted tasks are excluded. Explicit goal completion does not fabricate measured completion.
- Workspace-scoped database relationships, optimistic versions, transactional audit/outbox/sync writes and HTTP idempotency. Lost-response retries reuse the request identity; conflicting drafts require explicit review before resubmission.
- Account export includes goals, milestones and both link tables. Account purge removes the owned graph; task deletion hides its content in goal detail and permits unlinking.

## Files and architecture

Migration `0025_goal_center.sql` adds `goals`, `milestones`, `goal_tasks`, `milestone_tasks` and their constraints/indexes. It is additive and must run before deploying the new application. Applied migration checksums must never be changed. Rolling back application code can leave these tables intact; dropping them would destroy user data.

`packages/contracts` owns validation/events; `packages/db/src/schema.ts` mirrors the migration. `apps/web/src/server/services/goals.ts` owns mutations and repeatable-read progress projections. Goal/milestone API route handlers reuse authenticated request handling. `GoalsView.tsx` supplies the interface, and `data-rights.ts` extends the existing account export.

The worker crash integration test also now converts the `tsx` loader path to a file URL so Node's ESM loader supports Windows drive paths. Its crash/recovery assertions and deadlines are unchanged.

## Validation

Validation uses real local PostgreSQL and Chromium against a production Next.js build. Dedicated integration tests exercise identifiers, hierarchy/cycles/depth, tenant constraints, progress, version conflicts, audit rollback, lifecycle, pagination and account export/purge. Browser scenarios exercise the connected workflow, HTTP validation/isolation/replay, conflict recovery, accessibility, narrow-screen overflow and lost-response retry.

Final local validation on 2026-09-21: production build, lint and all seven package type checks passed; migration rerun reported already up to date; **913 tests in 80 files** passed with coverage thresholds met (`pnpm test:coverage --maxWorkers=1`); **5 Goal Center Chromium scenarios** passed without retries. Goal service coverage was 99.23% lines and 83.76% branches. The narrow-screen screenshot was visually inspected.

Initial full-suite runs exposed the Windows loader incompatibility and resource-sensitive existing retention/worker tests. The path conversion fixes the incompatibility; sequential local execution avoids resource contention without changing deadlines, skipping tests or weakening assertions. Canonical Linux CI retains its existing parallelism and all existing restore, scanner, dependency and full-browser gates. Its outcome is independent of these local results and must be checked for the pushed commit.

## Remaining scope

PC1 is online-only. Existing task offline push still rejects unsupported entities; goal sync deltas are not an offline goal editor. Automatic reference tags, task-side goal selectors, goal deletion/recovery, additional visualizations and pagination inside very large goal details are follow-up scope. PC2 general trackers, PC3 Knowledge & Data and PC4 cross-module daily workflows remain unimplemented by this increment.

No native client, wearable integration, AI assistant, collaboration or plugin system is claimed. Production rollout, live provider acceptance and operational/security release gates remain separate from local and CI checks.
