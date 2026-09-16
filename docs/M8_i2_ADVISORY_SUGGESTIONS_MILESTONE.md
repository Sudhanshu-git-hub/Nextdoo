# M8-i2 — Advisory Suggestions (deterministic heuristic) — implementation

**Status: IMPLEMENTED (this milestone).** Design authority:
`docs/M8_i2_ADVISORY_SUGGESTIONS_REVIEW.md` (committed at `a224bc9`, CI-verified),
PRD §§5.5, 7.3, 7.8, 7.9, 8.3, 8.5, 6.10, 14.3, 17.1.

M8-i2 implements the PRD §5.5 "improve" suggestions as a **bounded,
deterministic, heuristic-only** feature. Per PRD §17.1 the AI features are out
of MVP scope; per §6.10's deterministic-first precedent the heuristic IS the
default provider behind the PRD's own endpoint (`POST /v1/ai/suggestions`,
PRD §14.3 "Generate advisory suggestions"). **No LLM, no model API, no new
external service, no new database tables, no workers.** Suggestions are
advisory: they cannot change a plan except through one explicitly
user-confirmed action (PRD §5.5: "They cannot automatically change user plans
without confirmation."; §8.3: "Recommendations never move tasks
automatically.").

## What was built

| File | Kind | Purpose |
| --- | --- | --- |
| `packages/contracts/src/suggestions.ts` | new | Typed `Suggestion`/`SuggestionAction`/`SuggestionsResponse` + `SUGGESTION_RULE_VERSION = 1` |
| `apps/web/src/server/services/suggestion-rules.ts` | new | Pure, side-effect-free rule module (S1–S5, thresholds, caps, rounding, deterministic ordering) |
| `apps/web/src/server/services/suggestions.ts` | new | Workspace-scoped, corrections-filtered, read-only service (reuses `getSummary` + plain SELECTs) |
| `apps/web/src/app/api/v1/ai/suggestions/route.ts` | new | `POST /api/v1/ai/suggestions` — authenticated, tenant-isolated, idempotent read |
| `packages/contracts/src/preferences.ts` | new | `WellbeingPreferences` type + strict `wellbeingPreferencesPatchSchema` |
| `apps/web/src/server/services/preferences.ts` | new | `getWellbeingPreferences` / `setWellbeingPreferences` — per-user `user_preferences` rows, audit `account.preferences_updated` |
| `apps/web/src/app/api/v1/preferences/route.ts` | new | `GET`/`PATCH /v1/preferences` — authed, idempotent PATCH, strict booleans-only body |
| `apps/web/src/server/services/preferences.integration.test.ts` | new | 3 service tests (defaults + persistence + no-op, audit record, owner-scoping) |
| `apps/web/src/components/SuggestionsCard.tsx` | new | Analytics (§8.5) suggestion list: advisory wording, S1 confirm button, S2–S5 navigation |
| `apps/web/src/components/views/AnalyticsView.tsx` | touched | Renders `SuggestionsCard` |
| `apps/web/src/components/views/TodayView.tsx` | touched | §7.9: overload banner honors the toggle (warn → neutral planned-load line) |
| `apps/web/src/components/views/SettingsView.tsx` | touched | Wellbeing card: the §7.9 "Hide overload warnings" toggle |
| `apps/web/src/server/services/suggestion-rules.test.ts` | new | 32 unit tests (per-rule triggers, non-triggers, insufficient data, rounding, caps, determinism, Unmeasured, tone) |
| `apps/web/src/server/services/suggestions.integration.test.ts` | new | 9 service tests (five themes, determinism, zero-row mutation, corrections-hidden, isolation, toggle, S1 confirmation path, malformed input, no window leak, Unmeasured, fail-closed) |
| `apps/web/e2e/suggestions.spec.ts` | new | 6 E2E tests (401, malformed bodies, all five themes in Analytics + confirm, Today banner + toggle, isolation, axe) |

## The five rules (RULE_VERSION = 1)

Window = the analytics window for the requested `period` (`day`/`week`,
optional `dateKey`), i.e. exactly the cohort the analytics page shows:
non-deleted tasks with `dueAt` in the window, minus tasks whose latest
correction is `EXCLUDED_FROM_ANALYTICS` SET (PRD §7.7 — corrections hide data
from analytics, never from the task). "Measured" always means the existing
n≥2 / actual-time convention; `Unmeasured` is never treated as zero.

| Rule | §5.5 theme | Trigger (all must hold) | Suggestion value | Cap |
| --- | --- | --- | --- | --- |
| S1 `S1_ESTIMATE` | larger estimates for similar tasks | Task is ACTIVE with estimate > 0, and its tag cohort (else project cohort) has ≥ 2 measured tasks and mean signed variance ≥ +10% | `estimate × (1 + variance/100)`, rounded to 5 min (skipped if rounding is a no-op) | 2, ranked by uplift, tie title |
| S2 `S2_OVERLOAD` | less work on overloaded days | Day's planned minutes > workspace workday minutes (workday known), and §7.9 overload warnings enabled | Overage = planned − workday | 2, ranked by overage |
| S3 `S3_RECURRING` | earlier planning for recurring work | Series has ≥ 3 measured occurrences (stored `recurrence` scoring component, TR-06) in the window AND (median positive lateness ≥ 30 min OR adherence < 80%) | If a next occurrence exists: due time − median lateness, rounded to 15 min; else generic "earlier" wording | 2, ranked by median lateness |
| S4 `S4_SPLIT` | breaking large tasks into subtasks | Task is ACTIVE, has no subtasks, and (estimate ≥ 240 min OR measured actual ≥ 240 min) | — (navigation only) | 3, ranked by size |
| S5 `S5_REVIEW` | reviewing frequently rescheduled tasks | Task in the window has `rescheduleCount ≥ 3` | — (navigation only) | 3, ranked by count |

Totals: **≤ 11 suggestions per read** (per-type caps sum to 12; the explicit
total cap deterministically trims the tail when every theme saturates).
Stable order S1→S5, then severity, then label/id — independent of input
order. Messages: ≤ 200 chars, plain, non-punitive, own-data-only (never
another user's/task's information).

### Actions model (advisory invariant)

- `raise_estimate` (S1 **only**, the single permitted mutation): the UI shows
  a confirm button; on confirmation it calls the **existing versioned task
  PATCH** (`estimateMinutes` + `version`). No other mutation path exists.
- `open_day` (S2 → `/calendar`), `open_recurrence` (S3 → `/recurrences`),
  `open_task` (S4/S5 → task editor dialog). Navigation only — S2 in
  particular **never moves a task** (PRD §8.3).
- Generation itself (`POST /api/v1/ai/suggestions`) is **read-only**: every
  statement is a SELECT; verified by a zero-row-mutation snapshot test across
  tasks/projects/tags/task_tags/tracking_results/tracking_events/
  tracking_corrections/recurrence_rules/task_occurrences/user_preferences/
  audit_logs/sync_changes.

## §7.9 overload-warning toggle

- New user preference `disableOverloadWarnings` (PRD §7.9), same
  `user_preferences` (user, key) pattern as the existing `disableScores`
  reader (TR-07). Default: warnings enabled (everything shown).
- Surface: dedicated `GET`/`PATCH /v1/preferences` (authed; idempotent,
  strict booleans-only body; per-key upsert; audit
  `account.preferences_updated` naming the changed fields). The `/v1/me`
  profile contract is untouched — its exact response shape stays pinned by
  the existing account/session tests.
- Effects (view-only, never data-changing):
  - `listSuggestions` suppresses **S2 only** — all other themes unaffected.
  - TodayView (§8.3) swaps the overload warning banner for a neutral
    "You have planned X of work in tasks due today." line.
- UI surface: the new Settings → Wellbeing card ("Hide overload warnings").
  The other §7.9 controls (streaks, celebrations, sounds, comparative
  metrics, numeric scores) stay out of this milestone's scope.

## Security / privacy / determinism

- Endpoint: `authedRoute` (session auth, same as all §14.3 routes),
  `ctx.auth.workspaceId` scoping — the service only ever queries that
  workspace; unknown workspace fails closed (NOT_FOUND via the summary).
  Tenant isolation covered by integration + E2E.
- Corrections-filtered everywhere (same `EXCLUDED_FROM_ANALYTICS` latest-SET
  predicate as the analytics summary); hidden tasks never appear in
  suggestions (asserted).
- No new data collection: the call reads existing tables only; no
  tracking_results/tracking_events/user rows are written (asserted by the
  zero-mutation snapshot).
- Deterministic: pure rules module (no clock, no randomness, no model calls);
  identical state → identical payload (unit shuffle test + integration/E2E
  double-call equality). Rate limit 120/min (heavy-read convention).
- Body contract: `{ period?: 'day'|'week', dateKey?: 'YYYY-MM-DD' }` strict;
  impossible dates (Feb 30) rejected VALIDATION_FAILED by the reused summary
  window check.

## Test & CI evidence

- Unit: `suggestion-rules.test.ts` — 32 tests (per-rule positive /
  non-trigger / insufficient-data / rounding / caps / determinism /
  Unmeasured / tone / action-policy).
- Integration: `suggestions.integration.test.ts` — 9 tests incl. exact
  actions/evidence for all five themes, determinism, **zero-row mutation**,
  corrections-hidden, workspace isolation, §7.9 toggle (S2 only), S1
  confirmation via the normal versioned update (ESTIMATE_CHANGED event + sync
  pipeline, no bespoke write), malformed/leak/fail-closed cases. Plus 3
  `preferences` service tests (defaults/persistence/no-op, audit, owner-scoping).
- E2E: `suggestions.spec.ts` — 6 tests (401; malformed bodies → 400; all five
  themes visible in Analytics with advisory wording; S1 explicit confirmation
  raises the estimate and the card reflects it; Today banner + §7.9 toggle
  (neutral line, S2 gone server-side, S4 unaffected); cross-workspace
  isolation; axe wcag2a/wcag2aa on the card).
- Full local battery (this milestone): typecheck ✓, lint (0 warnings) ✓,
  vitest full suite **859/859** ✓ (815 previous + 44 new), coverage ✓,
  production build ✓, E2E ✓. CI: see IMPLEMENTATION_LOG (commit SHA).

### Pre-existing test-isolation defect fixed (disclosed)

While validating this milestone, the full suite exposed a **pre-existing**
cross-file test-isolation defect (not introduced by M8-i2, not a product
defect): reminder-related test files (`task-bulk`, `lifecycle.integrity`)
left due `SCHEDULED` reminders in the shared test database, which the
global `deliverDueReminders` scan of `push-notifications` /
`push-unconfigured` then dispatched, inflating their **global** `sent`
counters under concurrent load (reproduced: 4/6 instead of 1). Fixed by
(a) scoped reminder cleanup in the two leaking files and (b) scoping the two
counter assertions to their own fixture reminder via the
`reminder.dispatch` audit (exactly one dispatched) — the no-double-dispatch
guarantee is unchanged and is still asserted via the (reminder,
subscription) unique rows and single notification. No product code was
changed; no assertion was weakened.

## Deferred (out of scope, per review + standing directive)

- Any model-backed/LLM suggestion provider, semantic similarity, "smart
  scheduling", automations, rule languages, or any other §17 AI feature.
- S2 task-move actions (PRD §8.3 forbids automatic moves; the toggle and
  navigation are the bounded behavior).
- Per-suggestion dismissal/memory (nothing is stored — suggestions are a
  function of current state by design).
