# M6 increment 1 — server-side entitlement enforcement and the authenticated export path

Date: 2026-09-10 (Asia/Calcutta). Bounded slice of M6 (commercial readiness) per
PRD §18.1/§18.3: **server-side enforcement of the PRD-defined limits that apply
to features that exist today**, the **entitlement endpoint**, and **regression +
browser evidence for the authenticated JSON export path**. No Stripe billing, no
Google Calendar OAuth/sync, no attachments, no Windows/desktop, no AI, no other
later integrations were started. All verified M1–M5 behavior is preserved; no
existing test was weakened or deleted; no migrations.

## Inspection findings that bounded the slice

Existing verified infrastructure (preserved, re-validated by the full suite):

- Task cap (FREE 200 active) and project cap (FREE 3) enforced on create
  (`enforceTaskLimit` / `enforceProjectLimit`, PRD §18.3).
- Calendar-connection cap (FREE 1) with suspend-on-downgrade /
  reactivate-on-upgrade, token sealing, tenant isolation
  (`calendar-connections.integration.test.ts`).
- Export plan quota: FREE 1/rolling day on the §7.10 export-generation path
  (`requestExport`), durable 3-per-hour reservation on both export paths,
  idempotent request replay, signed 24-hour downloads, tenant-scoped reads,
  retry/backoff/exhaustion, expiry and purge-aware artifact deletion
  (`export-workflow.integration.test.ts`, `e2e/exports.spec.ts`,
  [DATA_EXPORT_MILESTONE.md](DATA_EXPORT_MILESTONE.md)).
- Authenticated credential-free JSON export (`GET /api/v1/account/export`) with
  the legacy-notification-reference privacy guard (foreign task references are
  scrubbed to a canonical placeholder), sessions exported with safe fields only,
  `account.exported` audit event.
- `GET /api/v1/audit-logs` (`audit.list`, allow-listed category prefixes,
  actor-boundary scoping).
- The settings screen already displays plan/usage via an RSC snapshot of
  `getEntitlementSnapshot`.

Genuine gaps closed by this increment:

1. **No entitlement endpoint.** PRD §18.1: "Exact limits must be configured
   server-side and exposed through an entitlement endpoint." `getEntitlementSnapshot`
   existed but had no API route.
2. **`trackingHistoryDays` (FREE 30 days) was never enforced anywhere** — the
   historical analytics endpoint (`GET /api/v1/tracking/summary`, the `date`
   window used by the analytics/reporting views) accepted arbitrary past dates
   on every plan.
3. **No plan-based `auditLogRetentionDays`** (FREE None / PRO 30 days / TEAM 1
   year / Enterprise 7 years) on `audit.list` — every plan saw the same history.

Limits for features that do not exist yet (custom scoring rules 0/10/25/∞, seats
1/1/2–50/∞, attachment storage 100 MB/5 GB/10 GB and max file 10/100/250 MB,
AI requests/month 20/500/1000-per-seat) are **configured in the entitlements
table and surfaced through the new endpoint**, but are unenforceable until those
features are built; they are documented as remaining M6 work, not faked.

## What was implemented

| # | Change | Location |
|---|--------|----------|
| 1 | `GET /api/v1/account/entitlements` — auth-gated entitlement endpoint returning `{ plan, limits, usage }` (configured limits + live usage). Informational only: the server re-checks every limit on every mutating request. | `apps/web/src/app/api/v1/account/entitlements/route.ts` |
| 2 | `assertHistoryWindow` — resolves the caller's plan, reads the workspace time zone, computes the requested date's age in **workspace-local calendar days**, and refuses dates older than `trackingHistoryDays` with `ENTITLEMENT_LIMIT_REACHED` (HTTP 402). Paid plans (`null`) are unbounded. Wired into the historical-analytics endpoint. | `apps/web/src/server/services/entitlements.ts`, `apps/web/src/app/api/v1/tracking/summary/route.ts` |
| 3 | Plan-based audit-history window: `listAuditLogs` accepts an optional `retentionDays` — `0` (Free) returns no rows; a finite window hides rows older than it. `/api/v1/audit-logs` resolves the window from the caller's plan. The filter bounds what is *shown*; rows remain as internal security evidence (PRD §12.4 / §18.1 distinction; destruction is the purge worker's job and its retention/anonymization policy remains the open operations item from the audit-remediation report). | `apps/web/src/server/services/data-rights.ts`, `apps/web/src/app/api/v1/audit-logs/route.ts` |

## Verified behavior (DB-backed + browser)

New suite `apps/web/src/server/services/entitlements.export.integration.test.ts`
(11 tests, fresh account per test, real Postgres) and new browser spec
`apps/web/e2e/entitlements-exports.spec.ts` (4 tests, real session cookie):

| Scenario | Evidence |
|----------|----------|
| Entitlement endpoint: 401 unauthenticated; FREE plan exposes exactly the §18.1 configured limits (`activeTasks 200`, `projects 3`, `calendarConnections 1`, `trackingHistoryDays 30`, `exportsPerDay 1`, `auditLogRetentionDays 0`); usage reflects live task/project counts | integration + E2E (API and settings UI: "FREE", "1 of 200", "0 of 3") |
| Snapshot re-evaluates on plan change: upgrade FREE→PRO flips caps to unlimited and retention to 30 days; usage counts survive the change | integration |
| Task-cap boundary: 200 active → 201st create rejected 402 with no row persisted; completing one frees exactly one slot | integration |
| Plan-change re-evaluation on the next mutation, both directions: blocked at cap on FREE → allowed after upgrade (201st) → blocked again after downgrade, with all 201 existing rows preserved (no destructive reclamation) | integration |
| Project-cap boundary: 3rd OK / 4th rejected on FREE; paid creates the 4th; downgrade preserves all 4 and blocks the 5th | integration |
| Historical window: today, −29 and the −30 boundary day resolve on FREE; −31 rejected 402; boundary computed in the **workspace time zone** (UTC+14 fixture) not UTC; PRO sees −400 days | integration |
| Audit retention: seeded 10/40/400-day-old events — FREE sees 0, PRO 1, TEAM 2, ENTERPRISE 3; actor boundary holds even at 7-year retention (no cross-account rows in either direction) | integration |
| Export plan quota through the API: second export the same day → 402, list stays at exactly 1 | E2E (HTTP layer) |
| Authenticated JSON export: 401 unauthenticated with a problem document only (no content leak); 200 attachment, `no-store`, `formatVersion 1`, owner email, created task present; no password hash or credential anywhere in the snapshot | E2E |
| Account export completeness + tenant isolation: owner project/task present; no foreign workspace/task/project/reminder/event/result row anywhere in the bundle; `account.exported` audited | integration |
| Privacy scrub: a notification on A's account referencing B's task is exported with `taskId: null`, `reminderId: null`, canonical title, `body: null`; owned and workspace-less notifications intact; no foreign id/title/body string survives in the serialized bundle | integration |

Already-covered paths deliberately not duplicated (existing suites remain the
authority): async export generation/claim/retry/exhaustion, download token
state/expiry/tampering, idempotent replay of export requests, tenant-scoped
download refusal, expiry 410 in API and UI
(`export-workflow.integration.test.ts`, `e2e/exports.spec.ts`); calendar
connection cap, one-per-provider, token sealing, suspend/reactivate
(`calendar-connections.integration.test.ts`).

## Decisions (PRD-explicit; nothing guessed)

- "Audit log retention: None" (Free) means the plan sees **no** audit history
  (window 0); rows remain in the database as internal security evidence.
  Destructive retention/anonymization/legal-hold policy stays the open
  operations item from `AUDIT_REMEDIATION_REPORT.md` (F15) and was not invented.
- The 30-day analytics boundary uses **workspace-local calendar dates**, the
  same convention the tracking endpoints use; the boundary day (exactly 30 days
  old) is included.
- The synchronous account export (`GET /api/v1/account/export`) keeps its
  durable 3-per-hour rate limit; the §18.1 `exportsPerDay` plan quota applies to
  the §7.10 export-generation path, where it is already enforced.
- Entitlement changes take effect on the **next mutation**; over-cap downgrades
  never delete or mutate existing rows (existing behavior, now boundary-tested).

## Validation

- Unit + integration: **59 files / 587 tests passed** (576 prior + 11 new).
- Browser E2E: **129/129 passed** (3.4 min; 125 prior + 4 new). One local
  full-suite run showed 2 transient failures in `exports.spec.ts` (generation
  and foreign-access tests) that passed both on isolated re-run (4/4) and on the
  full-suite re-run (129/129); no code path touched by this slice affects export
  generation — classified as a load-induced flake, to be watched in CI.
- Lint: 0. Typecheck: 5/5. Production build: green (new routes included).
- Coverage (v8, server + core): **93.45% lines / 89.56% statements** overall
  (89.24% statements before), core **97.91%** vs the 85% threshold. New/changed
  files: `services/entitlements.ts` **100%** lines, `services/data-rights.ts`
  **96.0%** lines.
- No migrations; no changes to any M1–M5 verified behavior; no test weakened or
  deleted.

## Remaining M6 work (unchanged by this increment)

- Provider billing: Stripe checkout/webhooks/lifecycle, refunds,
  reconciliation, grace handling (explicitly deferred — no billing work started).
- Google Calendar two-way sync (OAuth, import/export of events, conflict
  resolution, webhooks/polling, revocation) — the connection model, capacity and
  suspend/reactivate hooks are ready; no provider exchange exists.
- Attachment upload/scan/download pipeline with plan storage and max-file
  gating (limits configured and surfaced; feature unbuilt).
- Seats/shared-workspace limits (workspace member table exists; seat-cap
  enforcement awaits the sharing feature).
- Custom scoring rules (cap 0/10/25/∞) — feature unbuilt.
- AI request quotas (20/500/1000-per-seat) — AI deferred.
- Destructive retention operations: purging/anonymizing rows beyond plan
  windows, legal hold, backup/object-store purge (open policy item).
- Support/status dashboards and operational acceptance.

## Next recommended increment

Either (a) the **retention-destruction + anonymization policy** slice (needs the
product/operations decision flagged in `AUDIT_REMEDIATION_REPORT.md` F15 before
any destructive semantics are chosen), or (b) the **attachment pipeline with
plan-based storage/max-file gating** (largest remaining M6 feature slice).
Billing and Calendar remain deferred until explicitly authorized.
