# M8-i2 Review — Advisory "Improve" Suggestions (PRD §5.5)

**Status:** REVIEW COMPLETE — bounded implementation proposal, not started.
**Directive constraints honored:** no AI/LLM; no recommendation engines
outside the written PRD; no product code modified during this review.

---

## 1. Exact §5.5 requirements (PRD text)

> **### 5.5 Improve**
> Suggestions: larger estimates for similar tasks · less work on overloaded
> days · earlier planning for recurring work · breaking large tasks into
> subtasks · reviewing frequently rescheduled tasks.
> > *Suggestions are advisory. They cannot automatically change user plans
> without confirmation.*

Supporting PRD text that constrains the implementation:

| Section | Requirement (verbatim essence) |
|---|---|
| §8.3 Daily Planning Flow | Shows … overload warning, and **recommended adjustments**. "Recommendations never move tasks automatically." |
| §8.5 Review Flow | Completion summary · timing summary · estimate accuracy · rescheduling analysis · recurring adherence · **suggested adjustments** · optional notes. |
| §7.8 Analytics | Weekly analytics must include **most-rescheduled tasks · overloaded planning days · underestimated categories**. Explanations "must be plain language"; avoid "You failed this week." |
| §7.3 Execution Outcomes | "The system must use **Unmeasured** instead of fabricating a score when required data is unavailable." |
| §7.9 Wellbeing Controls | Settings to independently disable: … **overload warnings** (among others). |
| §14.3 Core Endpoints | `POST /v1/ai/suggestions` — "Generate advisory suggestions". |
| §14.8 Rate limits | Standard authenticated reads 600 req/min/user (the suggestions endpoint is a read). |
| §17.1 AI Scope | MVP AI is limited to NL parsing, categorization suggestions, duplicate suggestions, basic execution summaries. **§5.5 improve-suggestions are NOT in the AI scope**; default paths are deterministic. |
| §6.10 NL Capture | "Default implementation is a **deterministic local parser** … the LLM path is a fallback" — the PRD's established deterministic-first pattern. |

**What "advisory improve suggestions" means:** five specific, named,
deterministic suggestion themes generated from the user's own execution
data, surfaced in the review flow (§8.5) and daily planning flow (§8.3),
that can never mutate a plan except through an explicit user confirmation
on that specific suggestion — and per §8.3 can *never* initiate task moves.

## 2. The five required user-visible suggestions

| ID | Theme (§5.5 wording) | Meaning (narrowest PRD-faithful reading) |
|----|----------------------|-------------------------------------------|
| S1 | larger estimates for similar tasks | For an active task with an estimate, its "similar" cohort (shared tag, else shared project) has measured work that systematically runs over estimate → suggest a concrete larger estimate. |
| S2 | less work on overloaded days | A planned day whose workload exceeds the workspace workday guideline → suggest reducing that day's load. **View-only: it must never offer an automatic move (§8.3).** |
| S3 | earlier planning for recurring work | A recurring series whose measured occurrences are consistently late (or poorly adhered) → suggest planning it earlier, with a concrete earlier time. |
| S4 | breaking large tasks into subtasks | An active task with a large estimate/measured duration and no subtasks → suggest splitting. |
| S5 | reviewing frequently rescheduled tasks | A task rescheduled repeatedly in the window → suggest reviewing its due date/scope. |

No other suggestion types are in scope (AC-1 below enforces this).

## 3. Inputs each suggestion may use (data allow-list)

Everything below already exists and is workspace-scoped; **no new data is
collected** (AC-12):

| Suggestion | Inputs (existing tables/computations) |
|---|---|
| S1 | `tasks` (estimate, status, tags, project, workspace), `task_tags`/`tags`, `tracking_results` (measured actual minutes via estimate component / input snapshot) — reuses the existing `tagVariances` cohort computation (≥2 measured tasks, ≥ +10 % mean overrun, PRD §7.8 "underestimated categories") |
| S2 | existing per-day summary `days[].plannedMinutes/workdayMinutes/overloaded` (workspace `workday_start/end_minute`); Today view `DayCapacity` for "today" only. Must preserve `CAPACITY_UNKNOWN` honesty: never assert available capacity. |
| S3 | `recurrence_rules` + per-occurrence `tracking_results` (timing component → lateness `(100 − timing)/4` h per §7.4; recurrence component → adherence §7.4/TR-06) |
| S4 | `tasks.estimateMinutes`, measured actual (tracking results), `tasks.parentTaskId` / child count (`tasks_parent_idx` exists) |
| S5 | `tasks.rescheduleCount` — reuses the existing `mostRescheduled` computation (max 5, PRD §7.8) |
| all | `user_preferences` (wellbeing toggles), `tracking_corrections` (EXCLUDED_FROM_ANALYSIS tasks are hidden from suggestion inputs — consistent with the existing summary) |

**Forbidden inputs:** other users'/workspaces' rows, raw event payloads
beyond what `tracking_results` already exposes, calendar busy-time
availability claims, anything external.

## 4. Deterministic? Yes — mandatory

- §17.1 excludes improve-suggestions from the AI scope; §6.10 establishes
  deterministic-first; the audit (J8) classifies the gap as "heuristic
  (non-AI) suggestions never built" with "the AI-bound variant … deferred";
  the standing directive defers all AI/LLM.
- Therefore: a **pure function** over already-computed data; fixed versioned
  rule set (like `CALCULATION_VERSION` in tracking); same inputs ⇒ same
  output (AC-11). No model, no provider, no network.

## 5. Actions suggestions may trigger

Strictly: **render + optional navigation + at most one confirmable mutation,
never automatic.**

- S1 — the *only* suggestion with a mutation action: "Raise estimate to
  N min" on that one task, applied **only after explicit user click**, via
  the **existing** versioned task-update endpoint (optimistic version +
  audit, no new mutation path).
- S2 — navigation only ("See tasks due {day}"). A move action is
  **prohibited** (§8.3 "Recommendations never move tasks automatically").
- S3 — navigation only (open the recurrence). A confirmed rule-time change
  is a possible *later* extension, out of scope here.
- S4 / S5 — navigation only (open the task; the subtask UI and due-date
  edit already exist there).

## 6. Informational only vs. mutating

Informational by default. Exactly one confirmable mutation (S1 estimate),
gated per §5.5 ("without confirmation"). S2 can never initiate a move per
§8.3. All other suggestions are pure information + navigation. No
background mutation, no queue, no worker.

## 7. Acceptance criteria (derived directly from the PRD)

| AC | Statement |
|----|-----------|
| AC-1 Scope | Only the five §5.5 themes are ever produced; the rule set is closed and versioned. |
| AC-2 Advisory invariant | Reading suggestions (API/UI) mutates zero rows; no mutation happens without an explicit per-suggestion confirmation action; S2 offers no move action (E2E asserts). |
| AC-3 S1 | Cohort (tag, else project) with ≥2 measured tasks and mean overrun ≥ +10 % → suggestion with concrete value `estimate × (1 + variance/100)` (rounded to 5 min); no measured actuals ⇒ no S1 (Unmeasured, AC-8). Confirmable raise updates exactly that field, version-checked + audited. |
| AC-4 S2 | Planned workload > workday guideline for a day ⇒ suggestion naming that day and the overage; text is a planning guideline, never an availability claim (CAPACITY_UNKNOWN-safe); suppressed when the §7.9 overload-warnings preference is off. |
| AC-5 S3 | Series with ≥3 measured occurrences and (median lateness ≥ 30 min OR adherence < 80 %) ⇒ suggestion with concrete earlier time (due time − median lateness, rounded to 15 min); navigation only. |
| AC-6 S4 | ACTIVE task with estimate (or measured actual) ≥ 240 min and no subtasks ⇒ suggestion; capped at 3 per window; navigation only. |
| AC-7 S5 | Task with `rescheduleCount` ≥ 3 in the window ⇒ suggestion (reuses `mostRescheduled` data); navigation only. |
| AC-8 Insufficient data | Any suggestion whose inputs are Unmeasured/insufficient is omitted, never fabricated (§7.3); empty state = existing "Not enough signal yet" behavior. |
| AC-9 Isolation & corrections | Inputs strictly workspace-scoped; a second user sees no cross-tenant titles/tags; EXCLUDED_FROM_ANALYTICS tasks (correction) contribute nothing (same hiding as the summary). |
| AC-10 Tone | Plain language, non-punitive, bounded length; contract test rejects empty/oversized strings and punitive phrasing patterns. |
| AC-11 Determinism | Same inputs ⇒ identical suggestion list (unit test with fixtures; two calls compared). |
| AC-12 No new collection | No new tables/columns storing behavior or suggestion content; computed on read. (Dismissal, if ever wanted, is client-side.) |
| AC-13 Endpoint | `POST /v1/ai/suggestions` (the PRD-named endpoint) — authed, workspace-scoped, idempotent read, standard rate limits; returns typed `Suggestion[]`. The *heuristic* is the deterministic default provider behind the PRD's contract — mirroring §6.10's deterministic-parser-first design; an AI provider, when ever permitted, would be a later fallback behind the same contract. |
| AC-14 Wellbeing dependency | §7.9 "overload warnings" independent toggle implemented (per-user `user_preferences` key, same pattern as `disableScores`) and honored by both the S2 suggestion and the existing Today overload banner (closes the J6 overload-toggle sub-gap, which §5.5's S2 depends on). |
| AC-15 Regression | Existing insights, summary shape, Today banner behavior (modulo the new toggle) and all suites unchanged; no existing test weakened. |

## 8. What stays out of scope (AI/LLM deferred + others)

- **All LLM/model-backed generation** for any of the five themes; provider
  abstraction, cost budgets, per-plan AI quotas, prompt versioning
  (§17.2/§17.3 machinery) — deferred by standing directive.
- The other §17.1 AI items (NL LLM fallback parsing, categorization
  suggestions, duplicate-task suggestions, basic execution summaries) —
  already deferred; untouched.
- **Smart scheduling** (PRD Phase 2, §4.2): automatic/optimized
  rescheduling, feasibility claims, capacity-based schedule proposals.
- Cross-task semantic "similarity" (anything beyond tag/project heuristics).
- Rule language (§7.5, Phase 2); automations; cross-user comparison
  (absent in MVP per §7.4/§7.9).
- Suggestion dismissal persistence, suggestion history tables,
  per-suggestion settings beyond the §7.9 toggle, mobile/desktop surfaces.

## 9. Existing implementation (cross-check — do not duplicate)

| Already delivered (location) | Reused, not rebuilt |
|---|---|
| "What this suggests" insights card in AnalyticsView (tracking summary `insights`) | Host surface for S1–S5 (augment, never replace) |
| `tagVariances` (≥2 tasks, ≥ +10 %) + "underestimated categories" text | S1 cohort signal + thresholds |
| `mostRescheduled` (max 5) + reschedule insights | S5 signal |
| `days[].overloaded/workdayMinutes` + TodayView OVERLOADED banner ("consider moving something") + `DayCapacity` engine (honest CAPACITY_UNKNOWN) | S2 signal + Today surface |
| `tracking_results` (outcome, components incl. timing/recurrence, input snapshot), `CALCULATION_VERSION`, freshness | S3 lateness/adherence math |
| `recurrence_rules` (60-day generation horizon), RecurrenceView | S3 target + navigation |
| `tasks.estimateMinutes/rescheduleCount/parentTaskId`, task-relations subtask UI, versioned task update + audit | S4/S5 signals + S1 confirmable mutation |
| `user_preferences` (`disableScores` pattern) + TR-07 honoring | AC-14 toggle pattern |
| Deterministic `nl-parse` (per-field confidence, confirmation pattern) + `POST /v1/natural-language/parse` route pattern | Route/auth/idempotency conventions; proof the deterministic-default pattern is house style |
| §7.8 weekly analytics data (all inputs above) | Nothing new to collect |

**Gap (exactly):** the typed suggestion model + closed deterministic rule
set for the five themes; the `POST /v1/ai/suggestions` endpoint; actionable
UI (confirmable S1, navigation for S2–S5) in AnalyticsView + TodayView; the
§7.9 overload-warnings toggle; S3 lateness computation; S4 large-task
detection; and the AC-1…AC-15 test coverage.

## 10. Proposed bounded architecture

```
POST /api/v1/ai/suggestions  { period: 'day'|'week' }   (authedRoute, read)
        │
        ▼
services/suggestions.ts  buildSuggestions(db, actor, window)   — PURE, versioned RULE_VERSION
        │  reads (workspace-scoped, corrections-filtered):
        │   tasks + tags + tracking_results (ACTIVE rows) + recurrence rules
        │   + workspace workday + user_preferences
        ▼
Suggestion[] (contracts/suggestions.ts)
{ id, type: 'S1_ESTIMATE'|'S2_OVERLOAD'|'S3_RECURRING'|'S4_SPLIT'|'S5_REVIEW',
  message, ruleVersion,
  target?: { kind: 'task'|'day'|'recurrence', id?, dayKey?, label? },
  action?: { kind: 'raise_estimate', taskId, suggestedMinutes, version }
        | { kind: 'open_task'|'open_day'|'open_recurrence', ... },
  evidence?: { cohort, taskCount, variancePct | overByMinutes | medianLateMinutes | … } }
        │
        ├── AnalyticsView ("What this suggests" card, §8.5): renders typed
        │   suggestions above/beside existing insights; S1 confirm button →
        │   existing PATCH tasks/:id (version + audit); others → navigation.
        └── TodayView (§8.3): S2 for today attached to the existing
            overload banner (honest planning-guideline wording); hidden when
            the §7.9 overload toggle is off (banner text switches to the
            neutral "planned X min" line).
```

Deterministic rule table (initial `RULE_VERSION = 1`):

| Rule | Trigger (all must hold) | Suggested value | Cap |
|---|---|---|---|
| S1 | active task with estimate; tag (else project) cohort ≥2 measured, mean overrun ≥ +10 % | `estimate × (1+variance/100)`, round 5 min | top 2 tasks by estimate×variance |
| S2 | day `plannedMinutes > workdayMinutes` (workday known) | overage = `plannedMinutes − workdayMinutes` | top 2 days (today first in day period) |
| S3 | series ≥3 measured occurrences; median lateness ≥ 30 min OR adherence < 80 % | due time − median lateness, round 15 min | top 2 series |
| S4 | ACTIVE, no children; estimate ≥ 240 min OR measured actual ≥ 240 min | — (advice only) | top 3 by size |
| S5 | `rescheduleCount ≥ 3` in window | — (review advice) | top 3 by count |

Totals: ≤ 11 suggestions per read, stable order (S1…S5, then evidence
severity), each message ≤ 200 chars, plain language, no punitive phrasing.

## 11. Negative / security / privacy cases (must be tested)

1. **Cross-tenant:** user B's read (and the DB queries) never include user A's titles/tags/estimates — two-workspace integration test with distinctive markers.
2. **Corrections honored:** a task marked EXCLUDED_FROM_ANALYTICS contributes nothing to any suggestion (parity with the summary).
3. **Unmeasured:** no actuals ⇒ no S1; single-occurrence series ⇒ no S3; missing workday ⇒ no S2 (never guess a guideline).
4. **Advisory invariant:** repeated reads (and UI renders) change zero rows — assert row counts + `updated_at` stable; only the confirmed S1 action mutates, with version conflict → 409 on stale version.
5. **No move path:** no API/UI path from an S2 suggestion mutates any `dueAt` (route table + E2E assertion).
6. **Rate/abuse:** standard limits apply; a malformed body → 400 without side effects.
7. **Privacy:** suggestion text contains only the caller's own task titles/tags (already visible to them); nothing is logged with task titles; no external transmission (deterministic — a property, verified by the absence of any network call in the service).
8. **Preference off:** `disableOverloadWarnings=true` ⇒ no S2 anywhere (banner neutralized too), other suggestions unaffected.
9. **Tone/contract:** unit test over the message builder (bounded length, no empty, no "failed" phrasing).
10. **Degradation:** suggestions endpoint failure never blocks the review UI (existing best-effort pattern, as with capacity fetch).

## 12. Test strategy

- **Unit (pure rules):** fixtures for each rule trigger + each suppression;
  determinism (two builds, deep-equal); caps and ordering; tone contract.
- **Integration (real DB, `nextdoo_test`):** one scenario per AC-3…AC-9
  (cohort overrun, overloaded day, late series, large task, rescheduled
  task, isolation markers, corrections-hidden, no-mutation-on-read, S1
  confirm + version conflict + audit row); reuses the reminder/tracking
  integration harness patterns.
- **E2E (real browser):** AnalyticsView renders typed suggestions with
  actions; S1 confirm flow end-to-end (estimate changes, task editor shows
  new value, audit visible); S2 in TodayView with toggle on/off; empty
  state; axe on both surfaces; advisory invariant (render ⇒ no mutation).
- **Regression/full battery:** typecheck, lint, coverage gate, build,
  full vitest + E2E; no existing test weakened; coverage must not drop.

## 13. Implementation plan (for the next directive turn)

1. Contracts: `suggestions.ts` (Suggestion type + rule version) — typecheck.
2. `services/suggestions.ts` + pure rule module; unit tests (AC-1, 3–8, 10, 11, 12).
3. `POST /api/v1/ai/suggestions` route (authedRoute read pattern) + service
   wiring; isolation/corrections/no-mutation integration tests (AC-2, 9, 13).
4. §7.9 `disableOverloadWarnings` preference (settings API + Today banner +
   S2 suppression) — AC-14.
5. UI: AnalyticsView card + TodayView attachment; E2E + axe.
6. Full battery → commit → push → CI → milestone doc `M8_i2_ADVISORY_SUGGESTIONS_MILESTONE.md` + ledger → STOP.

Estimated surface: ~6 files new, ~5 touched (contracts, service, route,
2 views, settings), 0 schema tables, 0 new workers, 0 external services.
