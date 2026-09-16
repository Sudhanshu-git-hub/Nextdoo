# M8-i3 — Wellbeing controls (PRD §7.9) — review + bounded proposal

Status: **review only — no product code changed this increment.**
Baseline: `99a7659` on `arena/01a085b7-nextdoo` (M8-i2 CLOSED and CI-verified at `be02566`).
Scope question: what remains required for the six §7.9 wellbeing controls, and what is a
bounded M8-i3 that closes the gap without inventing behavior the PRD does not define?

---

## 1. Exact PRD requirements

**§7.9 (verbatim):**

> Settings to independently disable: numeric scores · streaks · celebrations · sounds ·
> comparative metrics · overload warnings. Defaults: streaks **on**, celebrations **off**,
> comparisons **absent in MVP**.

Supporting anchors:

| Anchor | Text (relevant part) | Consequence |
|---|---|---|
| §7.4 Score model requirements | "… never compare users publicly in MVP · **allow users to disable scores and streaks**." | The disable-ability of scores *and* streaks is an explicit score-model requirement, not just a settings line item. |
| §7.11 TR-07 | "Scores disabled in settings → API omits score; explanation endpoint returns 403-free empty payload." | Defines exactly what "disable scores" means: a display/API control, never a data or calculation control. |
| §7.8 Analytics | Weekly: "execution score trend · completion consistency · …" | A user's **own** time series is analytics, not a "comparative metric" — it must survive every §7.9 toggle except the score toggle. |
| §2.10 Non-goals (MVP) | "… cross-user leaderboards …" | No cross-user comparison features exist or may exist in MVP. |
| PD-04 (decision register) | "No leaderboards or cross-user comparison in MVP." | Same; comparisons are structurally absent, not merely hidden. |
| PD-03 (decision register) | "Scores are explainable, correctable, and **disableable**." | A final product decision that the score display control is MVP-relevant. |
| §22.6 experiment 2 | "Score presentation test (score versus narrative only)." | The disabled state ("narrative only") is an expected, tested product state in beta. |
| §21.6 / §22.8 #10 | Risk: "Tracking feels punitive" → mitigation: "Wellbeing controls, language review, opt-out." | Why these controls exist; they are mitigations for the core differentiator. |
| §8.8 Accessibility | WCAG 2.2 AA: keyboard, semantic labels, announcements, reduced motion. | The settings card (and any celebration/sound surface, if ever built) must meet AA. |
| §14.3 Core endpoints | `PATCH /v1/me` — "Update profile and **preferences**". | The PRD's endpoint table groups preferences under `/me`; see §6 below for the bounded deviation. |
| §13.2 Core entities | `user_preferences`: `user_id, key, value`, unique `(user, key)`. | The established storage pattern; already migrated. |

The PRD does **not** define, anywhere: what a *streak* measures, what a *celebration*
is (animation? message? both?), what *sounds* are (completion chime? timer?), or what
*comparative metrics* compare (the only comparison the PRD ever mentions is cross-user,
which it forbids in MVP). Streaks/celebrations/sounds also appear nowhere in §4.1's MVP
inclusion list or in §21.3's milestone details.

## 2. Current implementation status (measured at `99a7659`)

| Control | PRD requirement | MVP-required? | Current status | Reusable existing implementation |
|---|---|---|---|---|
| **Numeric scores** | §7.4 disable-ability (PD-03); §7.9 setting; TR-07 behavior | **Yes** — the only remaining control with an existing MVP behavior to govern | **Server: complete.** `disableScores` `user_preferences` row is honored in: tracking summary (strips `averageScore` + per-day `score`, returns `scoresEnabled:false`), project analytics (same stripping), and task tracking detail (`result:null`, `scoresEnabled:false` — the 403-free empty payload TR-07 requires). **UI: complete.** AnalyticsView (stat + day-table column), TrackingPanel, ProjectAnalytics all render conditionally and show "Numeric scores are hidden by your stored preference." **Missing: the control itself** — neither the Settings UI nor any endpoint can write the key today (only direct DB rows, e.g. in tests). | `scoresEnabled(userId)` reader (`tracking-freshness.ts`), the stripping in `tracking.ts` summary + `project-analytics.ts` + `tracking-history.ts` detail, all three view components, TR-07-shaped tests in `tracking-workflow.integration.test.ts` / `project-analytics.integration.test.ts`. |
| **Streaks** | §7.9 setting, default **on**; §7.4 "disable … streaks" | The **setting** is required; a streak *feature* is **not** — undefined in the PRD, absent from §4.1, no streak semantics exist to implement without inventing them | **Nothing exists**: zero code references to streaks (grep across `apps`/`packages`). No computation, no UI, no data. | `user_preferences` storage; `GET/PATCH /v1/preferences` (M8-i2) as the settings home. |
| **Celebrations** | §7.9 setting, default **off** | The **setting** is required; a celebration feature is undefined and unbuilt | **Nothing exists** (zero references). | Same as streaks. |
| **Sounds** | §7.9 setting (no default stated → enabled by default per the "independently disable" framing) | The **setting** is required; no sound system exists | **Nothing exists** (no audio/sound/beep anywhere in the codebase). | Same as streaks. |
| **Comparative metrics** | §7.9 setting, default **absent in MVP**; PD-04; §2.10 | The **setting** is required as a guard; comparative *features* are forbidden in MVP (cross-user) and absent; Phase 2 team reporting would later need it | **Nothing to gate** — by design (PD-04). Critical: the user's **own** weekly trends/insights (§7.8) are individual trend reporting and are *not* comparative metrics; they must never be hidden by this toggle. | Same as streaks. |
| **Overload warnings** | §7.9 setting | Yes | **COMPLETE (M8-i2).** `disableOverloadWarnings` key, `GET/PATCH /v1/preferences`, Settings → Wellbeing card, TodayView banner swap, S2 suppression, audit `account.preferences_updated`, 3 integration tests + E2E. | — (done; regression anchor for the pattern). |

Existing tests that pin current behavior and must stay green unchanged:
`sessions.spec.ts:125` (exact `/v1/me` shape — "profile view never leaks other state"),
`account-sessions.integration.test.ts` (same shape at service level),
`remaining-boundaries.integration.test.ts` (export includes `user_preferences` rows incl.
`disableScores`), `tracking-workflow` / `project-analytics` integration tests
(scoresEnabled stripping via DB rows), `suggestions.spec.ts` (overload toggle E2E).

## 3. Semantic distinctions (deliberate, per the review mandate)

1. **Disabling numeric scores ≠ deleting/computing-away scores.** Per TR-07 the score
   keeps being calculated and stored; the **API responses omit the score figures** and the
   explanation endpoint returns a 403-free empty payload. No `tracking_results` row is
   touched, corrections/recalculation still work, and the data export (a §7.10 data-rights
   artifact, pinned by `remaining-boundaries`) still contains results and preference rows.
   "Disable scores" is a **display/API control**, not a data control.
2. **Hiding score-related UI is the implemented half of #1** — the views already key off
   `scoresEnabled`; the missing piece is only the user-reachable write path.
3. **Disabling a wellbeing feature entirely** — for streaks/celebrations/sounds the
   feature itself does not exist, so the toggle is a **forward gate**: it is persisted,
   audited, and readable, but toggling it changes **zero** MVP-visible behavior (this is
   an acceptance-tested invariant, not an oversight). Shipping dead checkboxes in the UI
   for non-existent features would invent behavior the PRD does not support; the UI
   therefore offers controls only for features that exist (scores, overload warnings).
4. **Comparative metrics vs individual trend reporting.** Comparative metrics =
   cross-user/peer comparison (leaderboards, "you vs others") — forbidden in MVP
   (PD-04/§2.10), absent by default, Phase-2 team territory. Individual trend reporting =
   the user's own time series (§7.8: score trend, completion consistency, week-insight
   text) — always available per §7.8, **never** gated by the comparative toggle, and only
   score-figures within it gated by the score toggle. The UI copy must not suggest that
   turning off comparative metrics hides the user's own history.

## 4. PRD ambiguities and the decisions taken

| # | Ambiguity | Decision (bounded, reversible) |
|---|---|---|
| A1 | Streak semantics undefined (§7.9/§7.4 only require the control). | Do **not** build streak metrics. Provide the `disableStreaks` setting (default `false` = streaks on per PRD) as a contract/API gate. If streaks are ever specified, the gate already exists; nothing renders while disabled. Flag for product: streak definition is a product decision, not an engineering one. |
| A2 | Celebration semantics undefined; default off. | `disableCelebrations` default **`true`** (PRD "celebrations off"). No celebration surface built. |
| A3 | Sound semantics and default undefined. | `disableSounds` default `false` (the "independently disable" framing implies enabled-by-default; there is no audio system to affect). No audio built. |
| A4 | "Comparisons absent in MVP" — does the toggle hide own-history comparisons? | No. The toggle defaults to **`true`** (comparisons absent) and guards only future cross-user/team comparison surfaces. Own-history trends are unaffected (AC-5). |
| A5 | §14.3 lists "profile and preferences" under `PATCH /v1/me`. | Keep `/v1/me` locked (its exact six-field shape is pinned by closed-milestone tests, and M8-i2 already established `/v1/preferences` as the wellbeing home per review AC-14). Extend `/v1/preferences` instead. This is the documented, consistent deviation from the §14.3 letter. |
| A6 | Data export vs score hiding. | Export is unchanged: it is the user's own data-rights artifact (§7.10/§11.9), not an analytics display. Pinned by existing tests; not weakened. |

## 5. What is actually missing (the MVP gap, precisely)

One thing: **a user-reachable, API-complete §7.9 settings surface.**

- `disableScores` has a complete server + UI honoring chain but **no way for a user to
  set it** (the only control the PRD requires that has MVP substance).
- The four undefined/absent controls have **no setting at all** (not even in the API
  contract), so the §7.9 list of six independently-disableable settings is satisfied by
  only one of six today (overload warnings, M8-i2).
- There is **no unified settings panel entry** for scores (M8 audit J6 gap: "No unified
  per-control settings panel"; the overload sub-gap was closed by M8-i2).

That is the entire gap. No computation, no features, no schema, no workers.

## 6. Endpoint decision: extend `GET/PATCH /v1/preferences`

**Extend the existing endpoint; do not add a separate one.**

- §7.9 defines one control group ("Settings to independently disable: …") = one
  per-user wellbeing-preferences object. One GET returns the whole object; one strict
  partial PATCH mutates any subset. That is exactly the current contract's shape.
- Same storage (`user_preferences`), same audit action (`account.preferences_updated`
  with the changed `preferences.*` fields), same auth/idempotency/rate-limit plumbing —
  a second endpoint would fragment one PRD group and duplicate the scaffolding.
- The contract is already strict-object + boolean-only + empty-patch-rejected; adding
  keys is a backward-compatible extension (clients that send one key continue to work;
  unknown keys still 400).
- `/v1/me` is **untouched** (A5). Its locked shape assertion stays byte-for-byte.

**Defaults (PRD-derived) for a user with no stored rows:**

| Key | Default | Basis |
|---|---|---|
| `disableScores` | `false` | scores on by default; TR-07 is opt-out (PD-03) |
| `disableStreaks` | `false` | §7.9 "streaks **on**" |
| `disableCelebrations` | `true` | §7.9 "celebrations **off**" |
| `disableSounds` | `false` | no default stated; "independently disable" ⇒ enabled by default (A3) |
| `disableComparativeMetrics` | `true` | §7.9 "comparisons **absent in MVP**" (A4) |
| `disableOverloadWarnings` | `false` | M8-i2 established |

Note the two non-trivial defaults: celebrations and comparisons are **disabled by
default**, so the service's default object is *not* "all false" — a regression test must
pin the exact six-value default vector.

## 7. Proposed bounded M8-i3 scope

**Files (≈5 touched/new, 0 new tables, 0 migrations, 0 workers, 0 new endpoints):**

1. `packages/contracts/src/preferences.ts` — extend `WellbeingPreferences` +
   `WELLBEING_PREFERENCE_KEYS` + `wellbeingPreferencesPatchSchema` to the six keys
   (strict; keep the empty-patch rejection).
2. `apps/web/src/server/services/preferences.ts` — PRD-default object (the vector above)
   instead of an all-false init; the key loop already generalizes.
3. `apps/web/src/components/views/SettingsView.tsx` — one new checkbox,
   "Hide numeric scores" (the real behavior, wired through the existing
   `setPreference`), in the existing Wellbeing card; card copy adjusted. No checkboxes
   for streaks/celebrations/sounds/comparative metrics (A1–A4) — the card may carry one
   honest line noting further wellbeing controls arrive with the features they govern.
4. `apps/web/src/server/services/preferences.integration.test.ts` — extend (not rewrite):
   six-key default vector, per-key persistence, audit field names, owner-scoping, no-op.
5. `apps/web/e2e/wellbeing.spec.ts` (new) — see §9.

**Explicitly not changed:** `/v1/me` · score calculation/results/corrections/recalculation
· data export · summary/project/tracking-detail routes (they already honor `disableScores`)
· TodayView/SuggestionsCard overload behavior · reminders/notifications · analytics
non-score figures · desktop.

## 8. Acceptance criteria

- **AC-1 Defaults.** A fresh user's `GET /v1/preferences` returns exactly
  `{ disableScores:false, disableStreaks:false, disableCelebrations:true,
  disableSounds:false, disableComparativeMetrics:true, disableOverloadWarnings:false }`.
- **AC-2 Strict partial update.** `PATCH /v1/preferences` accepts a non-empty subset of
  the six booleans; unknown keys → 400 `VALIDATION_FAILED`; empty body → 400; replay with
  the same idempotency key returns the original state; only provided keys change; the
  `account.preferences_updated` audit row names exactly the changed `preferences.*` fields;
  a no-op write (same value) still upserts idempotently with no duplicate rows.
- **AC-3 Scores control is real (TR-07 end-to-end).** Setting `disableScores:true` via
  Settings makes: the tracking summary omit `averageScore` and per-day scores and return
  `scoresEnabled:false`; project analytics the same; the task tracking detail return
  `scoresEnabled:false` with `result:null` (no 403); and the Analytics UI show "Numeric
  scores are hidden by your stored preference." with no score figures. Toggling back
  restores everything. Scores in `tracking_results` are untouched either way.
- **AC-4 Forward gates are inert in MVP.** Toggling each of `disableStreaks`,
  `disableCelebrations`, `disableSounds`, `disableComparativeMetrics` (each to both
  values) changes **zero** bytes of any existing API response or page (asserted by
  before/after equality on summary, project analytics, tracking detail, Today,
  suggestions) while persisting and auditing the change.
- **AC-5 Trends are not comparisons.** With `disableComparativeMetrics:true`, the user's
  own weekly trend figures/insights remain present and unchanged (individual trend
  reporting is §7.8, not §7.9 comparative metrics).
- **AC-6 Isolation.** Preferences are owner-scoped: a second user sees their own defaults
  after one user sets values; `GET` never returns another user's rows (route is
  `ctx.auth.userId`-scoped; asserted with two accounts).
- **AC-7 No planning impact.** No preferences write mutates any task/project/reminder/
  calendar/tracking row (before/after counts on the M8-i2 pattern).
- **AC-8 `/v1/me` untouched.** The sessions E2E exact-shape assertion and the
  account-sessions integration shape assertion pass **unmodified**.
- **AC-9 Accessibility.** The Wellbeing card passes axe wcag2a/wcag2aa; both checkboxes
  are keyboard-operable, labeled, and announce state changes (existing `role="status"` /
  `role="alert"` patterns).
- **AC-10 Export unchanged.** The existing export test (preferences rows incl.
  `disableScores` present; no credentials) passes unmodified.
- **AC-11 Regression.** Full vitest + full E2E green; M8-i2 overload behavior
  (banner swap, S2 suppression, audit) unchanged.

## 9. Test strategy

| Layer | Tests |
|---|---|
| Service integration (extend `preferences.integration.test.ts`) | AC-1 exact default vector; per-key upsert + no duplicate rows; audit fields for multi-key patch; owner-scoping across two accounts; empty-patch/no-op behavior. |
| Coupling integration (small, in the same file or `tracking-workflow`) | set `disableScores:true` through `setWellbeingPreferences` → `getSummary`/project analytics/tracking detail strip exactly per TR-07 (reusing the existing DB-row fixtures' expected shapes, now driven through the real settings path). |
| E2E (new `wellbeing.spec.ts`, ≈6 tests) | (1) fresh-user defaults via API; (2) malformed/unknown-key PATCH → 400; (3) Settings toggle hides scores in Analytics (UI round trip, note visible, score stat/column gone) and restores on untoggle; (4) toggling the four forward-gate keys changes no page (Analytics before/after text equality) while `/v1/preferences` reflects them; (5) two accounts isolation; (6) Wellbeing card axe. Reuse the `suggestions.spec.ts` request-context pattern for the second account. |
| Regression | sessions E2E (locked `/me` shape), remaining-boundaries (export), tracking-workflow + project-analytics (TR-07 shapes), suggestions E2E (overload toggle). Unmodified. |

## 10. Explicit non-goals

- **No streak feature** (semantics are a product decision the PRD never makes; A1).
- **No celebrations, no sounds/audio system** (undefined in the PRD; A2/A3).
- **No comparative/leaderboard/team metrics** (forbidden in MVP by PD-04/§2.10; A4).
- **No score-calculation, corrections, recalculation, or export changes** (A6).
- **No `/v1/me` change** (A5). No new tables, migrations, workers, or endpoints.
- **No desktop/mobile-specific surfaces** beyond the shared Settings card.

## 11. Recommended implementation order

1. Contracts: six-key `WellbeingPreferences` + patch schema (defaults documented).
2. Service: PRD-default object (two keys default `true`) + generalized upsert (already is).
3. Extend service integration tests (default vector, audit, isolation) — red→green.
4. SettingsView: "Hide numeric scores" checkbox + card copy.
5. New `wellbeing.spec.ts` E2E (defaults, 400s, scores UI round trip, inert gates,
   isolation, axe).
6. Full validation (unit/integration/E2E, typecheck, lint, coverage, build, CI),
   milestone doc + IMPLEMENTATION_LOG entry, commit/push, CI verification, STOP.

Bounded estimate: 1 contract file, 1 service file, 1 test file extended, 1 view file,
1 new E2E spec — the smallest possible closing of the J6 "unified settings panel" gap,
with every behavior traced to a PRD anchor and every ambiguity recorded in §4.

## 12. Sources

PRD §7.9 (line 605) · §7.4 · §7.8 · §7.11 TR-07 · §2.10 · §13.2 (`user_preferences`) ·
§14.3 · PD-03/PD-04 · §22.6 exp-2 · §21.6/§22.8 #10 · M8_ROADMAP_AUDIT.md J6 + §4.1
ranking ("wellbeing settings panel (J6) — real but small") ·
M8_i2_ADVISORY_SUGGESTIONS_REVIEW.md AC-14 · M8_i2_ADVISORY_SUGGESTIONS_MILESTONE.md
(§7.9 toggle implementation, deferred list) · current code at `99a7659`
(`preferences.ts` service + route + contract, `tracking-freshness.scoresEnabled`,
`tracking.ts`/`project-analytics.ts`/`tracking-history.ts` stripping,
AnalyticsView/TrackingPanel/ProjectAnalytics conditional rendering,
`preferences.integration.test.ts`, `remaining-boundaries` export test).
