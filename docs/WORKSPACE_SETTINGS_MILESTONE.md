# Personal-workspace settings milestone

Date: 2026-09-09 (Asia/Calcutta). **Functional, locally verified milestone; not full Phase 1 completion.** Follows the independently committed recurrence milestone `e1c2f24`, whose GitHub Quality and integrity run also passed.

## Scope and approved policy

PRD §6.2 specifies one personal workspace per MVP account and its name, time zone, week start, workday hours, timestamps and optimistic version. Those existing fields are now manageable through authenticated UI/API; no second-workspace, membership, ownership-transfer or standalone workspace-deletion workflow was invented. Existing account deletion remains the destructive boundary.

The user explicitly selected **overnight workdays**. An end earlier than the start means the following day, visibly labeled, e.g. `22:00–06:00 (next day)`. Midnight is `00:00`; equal start/end values are rejected rather than ambiguously treating them as zero or 24 hours. Hours are nominal wall-clock preferences, not actual elapsed capacity on DST days or a guarantee of availability.

## Implemented behavior

- Settings offers workspace name, validated IANA zone, any weekday as week start, and start/end time controls.
- Owner-only writes use the existing workspace serialization lock, version/CAS, audit, sync and outbox transaction conventions. Invalid merged settings leave the row and effects untouched.
- `GET /api/v1/workspaces/:id` and idempotent `PATCH /api/v1/workspaces/:id` preserve camelCase and existing HTTP problem details, authentication, tenant, origin and rate-limit guards. PATCH accepts only settings plus version, never owner IDs or arbitrary fields.
- The shared app context carries server-loaded settings, refreshes after acknowledged changes and shows the workspace name in navigation.
- Quick capture interprets and previews dates in the workspace zone. New tasks without an explicit zone inherit the saved workspace default. Recurrence setup proposes the task's zone, falling back to the workspace default.
- Existing task due instants, task zones, generated occurrences, historical keys and recurrence schedules are not rewritten when workspace defaults change.
- Task rows display in the workspace zone. Today uses workspace-local day boundaries; its loaded-estimate warning compares against configured nominal workday length rather than a hard-coded eight hours.
- The existing week calendar respects workspace week start and time zone, displays configured workday hours, and preserves displayed local clock time during movement. Shared browser-safe date helpers handle 23/25-hour DST days. Task editor due inputs remain explicitly labeled with the browser zone; analytics/review cohorts were not silently redefined.
- Settings retains failed/stale drafts, uses the same idempotency identity after a lost acknowledgement, requires review/reload after conflicts, preserves input when reload fails, and guards unsaved navigation. Normal edits do not require a destructive confirmation.

No migration was needed: these workspace columns already existed. The shared core calendar subpath is browser-safe and does not pull authentication/crypto internals into the client bundle. No offline settings editor, new billing integration, AI or desktop work was started.

## Acceptance and validation

Regression tests were added before implementation: missing service/helper imports failed initially; after API implementation but before the UI, the HTTP scenario passed and both UI scenarios failed. One test initially compared a raw database Date with its serialized string; it was corrected to compare the same instant without removing the preservation assertion.

Final `pnpm verify`: **394 unit/integration/tooling tests across 43 files and 62 browser/API scenarios passed**, including all previous board, relationships, recurrence, lifecycle and bulk tests. Lint, all package typechecks, production build and coverage passed. Core coverage: **97.50% statements, 88.13% branches, 98.48% functions, 100% lines**. Frozen-lockfile installation and migration replay passed; dependency audit is **zero across all severities**; `git diff --check` passed.

New real-DB tests cover overnight persistence, merged-field validation, owner/tenant denial, concurrent version conflicts, preservation of existing recurrence history, inherited versus explicit task zones, and rollback of settings/version/audit/sync when outbox writing fails. Core tests cover local-day DST duration, week boundaries, weekday preferences and overnight labels/nominal duration.

Five dedicated browser/API scenarios cover persistence, targeted Axe WCAG 2/2.1/2.2 AA checks, calendar/capture/recurrence defaults, HTTP guards/replay, lost acknowledgements, stale drafts, invalid hours, failed reload, keyboard submission, navigation cancellation and Today across a UTC date boundary. Local logs are under `/home/user/nextdoo-workspace/`, particularly `verify-expanded.log`, `browser-red.log`, `audit.json` and `migration-replay.log`; they are not committed. SMTP remains unconfigured, so successful external email delivery is not claimed.

## Remaining boundaries

The existing calendar remains a week grid with up to 100 loaded tasks, not complete paginated day/month/provider-aware capacity planning. Nominal workday preferences do not establish working weekdays, breaks, external-calendar availability or exact DST-shift elapsed capacity. Full workspace-local analytics/reviews and offline reconciliation remain separate Phase 1 work.

Final PRD review also identified the board's remaining §6.9 optimistic-update/rollback requirement: its existing movement waits for server acknowledgement. That focused acceptance fix is next; the working board is not being rebuilt. See [PHASE1_COMPLETION_PLAN.md](PHASE1_COMPLETION_PLAN.md) for the broader remaining-work ledger.
