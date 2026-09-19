# M3 provider-aware capacity planning — report

Date: 2026-09-10 (Asia/Calcutta). Scope: the next M3 increment from the
[PHASE1_COMPLETION_PLAN.md](PHASE1_COMPLETION_PLAN.md) milestone table —
"Complete provider-aware capacity planning": the workspace/plan/provider-aware
capacity rule for the daily planning screen, correct entitlement and capacity
calculations, tenant isolation, and safe handling of configuration changes,
integrated into the existing task/workflow architecture without breaking
verified behavior. **Explicitly not included** (deferred with the rest of M3 /
M6): provider OAuth/sync integration, offline timers, real push/email
delivery, desktop.

## PRD requirements addressed

- **§5.2 (Plan):** "The system must not claim a schedule is feasible unless it
  has enough information to calculate capacity." → while an active calendar
  connection has not synced through the end of the planned day, the server
  returns `CAPACITY_UNKNOWN` and the Today view shows the §8.6
  "calendar sync delayed" degraded state with **no** overload/feasibility
  claim — only the known task workload. Disconnecting the calendar (soft
  state change) restores known capacity immediately.
- **§8.3 (Daily Planning Flow):** Today shows "estimated workload, available
  work capacity, overload warning, and recommended adjustments.
  Recommendations never move tasks automatically." The workload is now
  computed **server-side over the full ACTIVE collection due that day** (not
  the loaded page), against the workspace's configured workday window
  (overnight-aware). Overload renders a warning banner; nothing is ever moved
  or rescheduled automatically.
- **§13.2 (Core Entities):** `calendar_connections` (`user_id`, `provider`,
  encrypted token) — the stored connection state drives both the provider
  capacity rule and the plan entitlement; tokens stay server-side encrypted.
- **§14.3 (Core Endpoints):** implements the listed `GET /v1/calendar/connections`
  and `DELETE /v1/calendar/connections/:id` (disconnect = soft state change,
  row and sealed token retained); adds `GET /v1/calendar/capacity` as the
  server seam the §8.3 screen requires (full-collection workload/capacity can
  only be computed server-side). The OAuth start/callback and sync endpoints
  from the same table remain deferred with provider integration.
- **Plan/entitlement limits** (PRD §14.3 rate table: "Calendar
  synchronization — provider and plan-specific"; §16.15 entitlements):
  creating a connection checks the plan limit from `limitsFor(plan)`
  (`ENTITLEMENT_LIMIT_REACHED` when exceeded — FREE allows 1); Settings shows
  real plan-aware usage ("1 of 1" at the FREE boundary); a plan change
  **suspends** the newest over-limit connections and **reactivates** the
  oldest when the plan grows — it never deletes user data.

## Design decisions

- **One pure engine, testable at the core.** `packages/core/src/capacity.ts`
  (`planDayCapacity`) is timezone-free and pure: it takes the configured
  workday minutes (overnight window computed as
  `(end−start+1440) % 1440`), the full-collection workload in minutes, a
  `capacityKnown` boolean, and provider busy intervals in UTC, and returns
  `{ workdayMinutes, workloadMinutes, busyMinutes, capacityMinutes,
  overByMinutes, status: 'OK' | 'OVERLOADED' | 'CAPACITY_UNKNOWN' }`. Busy
  intervals are clipped to the day, sorted and merged (overlap-safe,
  `Math.ceil` on partial minutes) before subtraction. Nulls (`busyMinutes`,
  `capacityMinutes`, `overByMinutes`) are **load-bearing**: while capacity is
  unknown they stay null and no `OVERLOADED` verdict is possible.
- **Capacity is only reported when fully known** (`services/capacity.ts`):
  `capacityKnown = no active connection OR min(lastSyncedAt) ≥ day end`
  (inclusive). A seeded/never-synced connection therefore always degrades to
  `CAPACITY_UNKNOWN` rather than pretending the free calendar is empty.
- **Provider awareness is state, not protocol.** This slice consumes the
  existing `calendar_connections` rows (provider, status, `lastSyncedAt`,
  encrypted token) and the existing `calendar_events` table for busy
  intervals; it deliberately does not implement OAuth or sync (deferred), so
  the rule is already correct for whatever sync pipeline lands later.
- **Tenant isolation end to end.** Capacity GET passes through the shared
  `assertWorkspaceAccess` (403 for foreign workspaces); connection
  list/disconnect are filtered by the authenticated `user_id` (404 for
  foreign ids); anonymous requests get 401. Connection responses are a
  strict serialisation that never includes token material.
- **Configuration changes recompute, nothing is cached.** Workday start/end
  edits go through the existing optimistic versioned `PATCH /v1/workspaces/:id`
  (conflicts keep the draft, unchanged); the capacity endpoint and Today
  banner are recomputed per request, so a 480→120-minute workday edit
  immediately flips a day from `OK` to `OVERLOADED` (verified by E2E).
- **Best-effort UI.** The Today banner fetches `/calendar/capacity`
  client-side and fails silently to `null` (no banner) — a capacity fetch can
  never block or blank the task list. The list's own "N tasks loaded — more
  available" affordance is unchanged, which is exactly the contrast the
  E2E pins: 50 loaded, banner reports all 60.
- **Intentional copy change (behavior mandated by §5.2/§8.3).** The old
  client-side banner computed over *loaded* tasks only ("…planned in the
  loaded tasks. That exceeds your configured workday…") — the precise
  inaccuracy this milestone removes. It is replaced by the server-verified
  banner; `e2e/workspaces.spec.ts`'s workday-guideline assertion was aligned
  to the new copy (same test, same intent: Today warns when planned work
  exceeds the configured workday).

## Verification evidence

- **Unit (core engine):** `packages/core/src/capacity.test.ts` — 9 tests
  covering the overnight window, empty-day capacity, busy clipping/merging,
  overlap-safe busy math, overload boundary (exactly-full = OK), and the
  `CAPACITY_UNKNOWN` null-contract.
- **Integration (real Postgres):** `services/capacity.integration.test.ts`
  (10) + `services/calendar-connections.integration.test.ts` (8) — 18/18:
  full-collection workload (page-size independence), sync-delay blocking,
  disconnect restore, tenant isolation (cross-tenant reads 403/404, no token
  leakage in list payloads), plan-limit enforcement and
  suspend/reactivate-on-plan-change (never deletes).
- **Browser/API E2E:** `e2e/capacity-planning.spec.ts` — 5 scenarios:
  (1) 60×30-min due tasks → list shows 50 loaded, banner reports the full
  30h vs 8h workday ("22h over") and the subtitle "30h planned today";
  (2) unsynced connection → sync-delay banner, no overload claim, DELETE →
  `DISCONNECTED` restores known capacity (300 min vs 480 workday = no
  banner), list payload contains no token marker; (3) anonymous 401,
  foreign user 403/404 and empty own list, victim connection untouched;
  (4) workday PATCH 480→120 min → `OVERLOADED` with `overByMinutes: 80` and
  the re-computed banner; (5) Settings shows "1 of 1" at the FREE boundary
  and "0 of 1" for an empty user.
- **Full local gates at the milestone commit:** lint (0 warnings),
  typecheck (5/5 packages), **54 test files / 524 unit+integration tests**
  (baseline 51/498), coverage **87.85%** statements (baseline 87.41%),
  production build (Next.js 15.5.25), migration replay (`db:migrate` ×2,
  idempotent), **110/110 browser/API E2E scenarios** (baseline 105 + the 5
  new ones).

### Defect correction (2026-09-10, M5 closeout)

CI (GitHub Actions, `workspaces.spec.ts` date-boundary scenario) exposed a
genuine capacity defect in a **positive-offset** timezone: the day-window end
in `services/capacity.ts` was computed by advancing the **UTC** calendar date
of the local-midnight start instant and re-interpreting it as a local date.
For zones where local midnight lands on the *previous* UTC date
(e.g. `Pacific/Kiritimati`, UTC+14 — and equivalently every positive offset),
the window collapsed to zero length and the endpoint reported
`workloadMinutes: 0` for days that were not empty, so the §8.3 overload
banner never rendered. Negative-offset and UTC zones (all prior local and CI
runs) happened to keep a 24-hour window, which is why the milestone's original
verification was green. Corrected to advance the **local** calendar date
(month/year rollover via `Date.UTC`), keeping the window exactly one local
day in every zone. Regression test added to
`services/capacity.integration.test.ts`: a Kiritimati workspace where the
2026-09-11 local window is UTC [2026-09-10 10:00, 2026-09-11 10:00) — the
noon task is counted (120 min, `OK`), the previous and next local days are
distinct non-leaking windows. Re-verified after the fix: 569/569
unit+integration, 121/121 E2E (including the previously failing
`workspaces.spec.ts` date-boundary scenario in the +14 branch), lint 0,
typecheck clean, coverage 88.62%, production build green.

## Remaining (M3 and beyond, explicitly not started)

- Provider OAuth/sync integration (real `POST …/google/start`,
  `…/google/callback`, sync pipeline feeding `calendar_events` and
  `lastSyncedAt`) — M6 scope.
- Offline timers, real browser/background push and enabled reminder email
  delivery; desktop remains excluded.
- Staging/operational qualification stays external to this workspace.
