# Board optimistic-movement acceptance follow-up

Date: 2026-09-09 (Asia/Calcutta). This closes the remaining PRD §6.9 optimistic card-movement/rollback detail found while reviewing the requested task-management milestones. It extends the existing board; it does not replace its architecture or APIs.

## Behavior

- A card moves to its destination immediately while the existing versioned task PATCH is pending. The board announces that confirmation is pending and prevents conflicting card edits/moves during that operation.
- The temporary view retains the loaded baseline while the canonical refresh is running. On success, canonical task data replaces the temporary card.
- On failure, the temporary position is rolled back. The selected destination remains available for explicit retry, and keyboard focus moves to the persistent status message instead of disappearing with the relocated card.
- The existing idempotency identity is retained for unchanged uncertain-response retries. A response lost **after server commit** can therefore be retried without another task version increment.
- Existing 409 refresh/review semantics, archived-project behavior, drag and keyboard alternatives, section controls, paging and cross-project editing remain intact.

## Evidence

A browser regression was written and run before implementation. Holding the PATCH request before forwarding it demonstrated the missing optimistic movement: the destination card was absent. The same test now proves that the card moves before the database changes, a transport failure restores its original column, the destination draft remains selected, and keyboard retry uses the same key and increments the version once.

A second new browser scenario commits the move and deliberately drops its response. The UI rolls back with an uncertainty/error message; replay returns the original committed result and does not increment the version again. Existing drag/keyboard tests now explicitly wait for the server-confirmed announcement before starting the next operation or reloading, rather than confusing an optimistic preview with acknowledgement.

Final `pnpm verify`: **394 unit/integration/tooling tests in 43 files and 64 browser/API scenarios passed**, plus lint, typecheck, production build and all coverage thresholds. Core coverage is **97.51% statements, 88.13% branches, 98.50% functions, 100% lines**. Targeted board Axe and keyboard checks remain green. Dependency audit: zero findings across all severities; `git diff --check` passed. Local logs: `/home/user/nextdoo-board-acceptance/red.log`, `verify-final.log`, `audit.json` (not committed).

The independently pushed recurrence (`e1c2f24`) and workspace-settings (`f6dac35`) commits also passed GitHub Quality and integrity CI. This follow-up's remote CI is reported separately, not inferred from local tests.

## Scope closure

The requested boards/sections, subtasks, recurrence and personal-workspace settings workflows are now functional and covered by the full regression suite. Subtasks were retained from the verified relationships milestone, not rebuilt. The user-approved recurrence DST/history policies and overnight-workday policy remain in effect.

This does **not** complete the entire Phase 1 PRD. Full offline mode, desktop, AI and billing integration were not started. Rich task fields, virtualization, full calendar/provider-aware capacity, analytics/review controls and operational release evidence remain in [PHASE1_COMPLETION_PLAN.md](PHASE1_COMPLETION_PLAN.md). Board counts still describe loaded pages, not unbounded column totals or a new card-ordering feature.
