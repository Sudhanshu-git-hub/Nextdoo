# Personal-first reconciliation audit

Date: 2026-09-21. Audited baseline: `9a4ea5f7ef83f1076537d5c6b2afb03f0596b475`.

## Repository and evidence

- Remote: `https://github.com/Sudhanshu-git-hub/Nextdoo.git`.
- Fresh checkout: local `main`, HEAD and `origin/main` match the baseline; clean working tree before changes.
- Main CI independently checked: [push run 35576956468](https://github.com/Sudhanshu-git-hub/Nextdoo/actions/runs/35576956468), completed successfully for that exact SHA. This is baseline CI evidence, not validation of subsequent changes or live providers.
- No `AGENTS.md` found in the checkout. The workspace's `To Update Prd Prompt.md` is supporting product material; the current attached instruction additionally authorizes continued implementation after alignment.
- Read the authoritative PRD and inspected the route/component inventory, schema and migration runner, domain services, worker registry, offline queue/sync boundaries, authentication/request security, tests, Playwright/Vitest configuration and CI. Evidence below describes inspected implementation; test presence alone is not proof that every requirement passes.

## Structure

`apps/web` contains Next.js UI, `/api/v1` handlers and server services. `apps/worker` runs scheduled jobs. Shared packages are `core`, `contracts`, `db`, `calendar`, and `billing`. PostgreSQL/Drizzle is the system of record; 25 SQL migrations (`0000`–`0024`) are checksum-verified and transactionally applied. Tests comprise pure unit tests, real PostgreSQL integration tests, Chromium E2E, migration integrity and logical backup/restore smoke. There is no desktop or native mobile client, standalone API app, generic plugin runtime or general-purpose automation engine.

## Requirements versus code

Legend: COMPLETE means an implemented bounded workflow with baseline CI evidence; PARTIAL means missing parts of the broader requirement; NOT IMPLEMENTED means no corresponding domain/API/UI found; EXTERNAL means deployment/provider evidence is required; FUTURE means deliberately sequenced later; NOT APPLICABLE means outside current web scope.

| Area | Status | Implementation evidence and remaining boundary |
|---|---|---|
| Task lifecycle, projects/sections, tags, bulk commands, recurrence, subtasks/dependencies | COMPLETE for existing bounded workflows | `services/tasks.ts`, `task-bulk.ts`, `task-relations.ts`, `projects.ts`, `recurrence.ts`; matching integration and E2E specs. Version checks, tenant-scoped references and transactional event/sync writes exist. Expanded Task Center is PARTIAL: Home/Tomorrow/Upcoming/backlog navigation, personal collections and several dimensions/views remain. |
| Goals, subgoals, milestones and linked progress | NOT IMPLEMENTED | No goal/milestone tables, contracts, services, routes or screens. Task parents represent subtasks, not goal hierarchy. |
| Habit/health/learning/custom metric Tracker | NOT IMPLEMENTED | `tracking-engine.ts` and `TrackingPanel.tsx` implement task execution results, not tracker definitions/logs/targets/streaks. Preserve this engine. |
| Knowledge & Data | NOT IMPLEMENTED as a module | Task descriptions, `reviewNotes`, and attachments exist; no note/collection/structured-record domain or general relations. |
| Calendar and capacity planning | PARTIAL | `CalendarView.tsx`, `services/capacity.ts`, `calendar-connections.ts`, `db/calendar-sync.ts`, `calendar/google.ts`; task/external-event layers and hardened synchronization exist. Goal/metric/record date layers depend on absent modules. Live Google acceptance is EXTERNAL. |
| Insights | PARTIAL | `services/tracking.ts`, `tracking-corrections.ts`, `project-analytics.ts`, `AnalyticsView.tsx` implement task/project daily/weekly reporting, durable results and corrections. Cross-module reporting and wider periods remain. |
| Account lifecycle and sessions | COMPLETE for existing bounded workflows | `auth.ts`, `account-security.ts`, `services/accounts.ts`, `account-sessions.ts`, `mfa.ts`, worker account purge; matching auth/session/deletion/isolation tests. SMTP delivery and production controls require EXTERNAL evidence. |
| Settings/personalization | PARTIAL | Workspace settings, sessions/MFA, exports/deletion, calendar and wellbeing preferences exist. Full appearance/productivity defaults/onboarding/help/import/backup UX remains. A disable-streaks preference does not imply a streak feature. |
| Web offline/sync/conflicts | COMPLETE for supported task commands; PARTIAL for product-wide sync | `lib/offline-queue.ts`, `services/sync.ts`, `ConflictsView.tsx`, sync scenario/SLO tests. Server push explicitly rejects non-task entities and online-only relationship/recurrence commands. Do not promise arbitrary module offline editing. |
| Notifications/reminders | COMPLETE for bounded web workflows; EXTERNAL delivery | Reminder jobs, mail leases and `push-delivery.ts`/`push-subscriptions.ts` plus browser service worker and notification UI exist. Real SMTP/Web Push depend on deployment; native notifications are FUTURE. |
| Attachments | COMPLETE for bounded local-store workflow; EXTERNAL production storage | `services/attachments.ts`, `attachment-work.ts`, `attachment-scanner.ts`: signed short-lived access, quotas, ClamAV gating, deletion. Real-engine EICAR coverage in CI. S3 is not established by the environment template. |
| Billing/export/retention | Implemented bounded workflows; PARTIAL/EXTERNAL commercial acceptance | Billing provider adapters, verified webhook state machine, entitlements, async exports and retention jobs exist. Live payment reconciliation, provider accounts and operational acceptance remain separate. |
| Cross-module engine | PARTIAL | Shared workspace identity/contracts, tenant-safe references, tags, transactional outbox, append-only execution events, attachments and task sync exist. Universal relations, global search, command palette and configurable automations remain. |
| Smart layer | PARTIAL deterministic foundation; FUTURE advanced features | `core/nl-parse.ts`, `services/suggestion-rules.ts`, `suggestions.ts`: local parsing and read-only advice. No evidence of general LLM/voice assistant or smart autonomous scheduling. |
| Security/operations | PARTIAL and EXTERNAL | Origin checks, secure cookies, hashed tokens, MFA, isolation, validation and migration/restore tests exist. ASVS mapping and explicit SAST/secret CI baseline are absent. General throttles remain process-local; Argon2 has a scrypt fallback. Production monitoring/PITR/DR/pen test and live integration evidence are not supplied by CI. |
| Windows → Android → iOS/macOS | FUTURE | No native client directories. Existing web sync is a foundation, not native client completion. Watch app is NOT APPLICABLE to initial wearable-data strategy. |
| Collaboration and plugins | FUTURE | Membership/plan scaffolding does not implement collaborative product workflows or an extension platform. |

## Milestone position and inconsistencies

The code includes M5–M7 and M8-i1/i2/i3/i4/i6/i7 increments. M8-i5 is a live-provider preflight, not live acceptance. M8-i7 restore smoke is in CI. `M8_i8_RELEASE_GATE_HARDENING_REVIEW.md` is a proposal only; there is no security scan command or CI gate. Historical milestone labels are retained rather than repurposed to imply the new personal core is finished.

PRD v1.1 narrows the product to execution measurement, lists small teams as the secondary customer, puts Windows at launch, excludes knowledge from the MVP without defining its subsequent personal-core stage, and moves straight to team/enterprise phases. Its proposed repository tree, Redis/BullMQ stack, API examples and delivery timeline do not describe all current implementation choices. README and early DEVELOPMENT sections contain superseded completion claims. The PRD must distinguish product requirements, inspected implementation, later scope and external acceptance.

## Recommended dependency order

1. Reconcile PRD positioning, seven modules, architecture reality, platform sequence and scope labels; update entry-point documentation without rewriting historical milestone evidence.
2. Personal core increment PC1: Goal Center hierarchy, stable goal/milestone identifiers, task links and derived progress; use current PostgreSQL/contract/service boundaries. Include tenant isolation, cycle prevention, concurrency, deletion/export implications and actual UI/API tests.
3. PC2: manual trackers and idempotent task-completion logs; reuse event identities without changing existing task scores. Then knowledge notes/collections and bounded typed relations (PC3).
4. PC4: finish daily Task Center navigation and organization, shared search, calendar layers, cross-module summaries and preferences against the new modules. Keep optional visualizations deferred.
5. M8-i8 remains a valid release-hardening increment after alignment/personal-core prerequisites; implement mapped evidence and fixture-tested deterministic security/secret checks. Preserve all existing gates. Continue accessibility/performance/release work while recording external blockers.
6. Personal intelligence, then Windows, Android, iOS/macOS; collaboration and plugin platform later. Wearable data through supported ecosystems, with consent and supported API scope, precedes any optional watch app.

## Architectural risks and decisions

- Preserve task semantics, append-only scoring history, migration checksums and accepted replay identities. Add migrations; never edit applied SQL.
- Use immutable IDs for links and stable human-facing identifiers for goals/milestones. Tags alone cannot enforce hierarchy or tenant integrity.
- New entities need explicit lifecycle, export/purge and sync decisions; existing task-only sync must reject unsupported entities honestly until extended with tests.
- Extend current module boundaries and event writers; do not build a speculative universal entity framework or replace working PostgreSQL job leases with Redis solely to match old prose.
- Aggregate only real source data; missing goal/tracker/knowledge observations are not zero performance. Avoid double-counting task completion replay or multiplying parent progress by duplicated links.
- CI has real database/ClamAV/browser/restore coverage, but no test suite establishes production security certification, provider delivery or 30-day SLOs.

## Validation record

Baseline remote CI: successful as linked above. Local dependency setup and post-change validation are pending at this initial audit checkpoint. No runtime/schema/API/UI change has been made by this audit. Follow-up phase reports must record exact commits, tests, CI and clean-tree state.

## Follow-up: PC1 implementation

The table above is the preserved pre-implementation baseline at `9a4ea5f`. PRD alignment was committed as `94e1a91`, with [successful CI](https://github.com/Sudhanshu-git-hub/Nextdoo/actions/runs/35604222285). Goal Center has subsequently been added in migration `0025` and the web application; see [its milestone](GOAL_CENTER_MILESTONE.md) for current delivered boundaries and validation. The baseline's NOT IMPLEMENTED Goal Center row is historical, not a statement about that subsequent increment. Tracker and Knowledge & Data remain planned.
