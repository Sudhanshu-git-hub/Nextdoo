# M4 workspace-local reporting and richer trends — report

Commit: `61dd487` on `arena/01a085b7-nextdoo` (branched from `b80d8a3`, the
green M4 corrections state).
Scope: one bounded milestone — workspace-local day/week reporting windows,
the seven PRD §7.8 weekly trend metrics with plain-language explanations,
and the §8.5 review flow (incl. optional per-day notes). No changes to score
math, weights, normalization, calculation versions (still 2), correction
behavior, append-only event semantics, or historical results.

## PRD requirements addressed

- **§7.8 daily:** planned/completed counts, completion rate, on-time rate,
  planned vs actual time, estimate variance, reschedule counts and the
  unmeasured/missing-result counts — now computed over the workspace-local
  day (previously UTC), with the workday-guideline load check per day.
- **§7.8 weekly:** execution score trend (per-day score column, current
  stored results only), completion consistency (per-day completion plus a
  steady/varied explanation across scheduled days), recurrence adherence
  (mean of *measured* recurrence components only — unmeasured never counts
  as zero), most-rescheduled tasks (top 5, hidden tasks excluded),
  overloaded planning days (planned load vs the workspace workday
  guideline, next-day workdays included), underestimated categories
  (tag-level estimate variance, ≥2 measured tasks, ≥+10% signal, top 3) and
  the focus-time trend (per-day tracked focus, bucketed by local start day,
  excluded tasks hidden).
- **§7.8 explanations:** every insight is plain, descriptive and never
  judgemental, with tag attribution (e.g. “Tasks tagged ‘client-work’ took
  about 42% longer than estimated (2 task(s)).”).
- **§8.5 review flow:** completion summary, timing summary (incl. mean
  lateness), estimate accuracy (overall + per category), rescheduling
  analysis, recurring adherence, suggested adjustments, and optional notes —
  one owner-authored note per local day (≤500 chars), saved/cleared from the
  analytics page, tenant-scoped, and available even in the empty state.
- **Unmeasured/excluded/corrections/freshness/history:** per-day scores use
  current stored results only (superseded rows never pollute a day);
  `EXTERNALLY_BLOCKED`/`UNTRACKED_COMPLETION` effects appear in trends
  exactly as the engine stored them; `EXCLUDED_FROM_ANALYTICS` removes the
  task from every cohort figure **and** from focus time; freshness is still
  reported per cohort; historical results remain queryable per task.

## Design decisions

- **Week semantics:** “This week” is the workspace-local week containing the
  reference day — from the configured `weekStart` through the end of the
  reference day (a partial current week is shown as-is, not padded). This
  matches the delivered calendar’s week grid (same `workspaceWeek` core
  helper) and the workspace settings. The previous rolling seven-day UTC
  window is retired; the UI and API state the window explicitly
  (`from`/`to`/`timeZone`/`weekStart` + a human line).
- **Time zone:** all windows and day keys are computed in the workspace IANA
  zone via the existing core helpers (`localDayBounds`, `workspaceWeek`,
  `localDateKey`). A requested `date` resolves to local noon in that zone so
  the key always round-trips; impossible calendar dates (Feb 30) are
  rejected with `VALIDATION_FAILED` instead of silently shifting the window.
  The recalculation backfill’s UTC day chunking (M4 corrections) is an
  internal partitioning detail and is unchanged.
- **Trend data sources:** everything is read from the same cohort and the
  same current stored results as the window totals — nothing is recomputed
  (scoring stays in the engine). Focus time comes from `timer_sessions`
  (accumulated + manual adjustment seconds), bucketed by the local day a
  session *started*; a session is attributed to one day, and the UI says so.
- **Notes storage:** `review_notes(workspace_id, day, body, updated_by,
  timestamps)`, PK `(workspace_id, day)`, `day` a local date key (stable
  across DST/zone changes), 500-char CHECK. Routes:
  `GET/PUT/DELETE /api/v1/tracking/review-notes?workspaceId&day` (PUT/DELETE
  idempotent, 300/120 per-minute limits, owner-scoped via the standard
  `assertWorkspaceAccess`).
- **Scores off (PRD §7.2):** the summary route and project reports strip
  `averageScore` **and** every per-day `score` when the stored preference
  disables numeric scores (absent from the JSON, not zero).
- **Tenant isolation:** summary/focus/tag/recurrence queries are
  workspace-scoped; notes enforce owner access (403 for foreign tenants);
  E2E + integration both verify no cross-workspace leakage.

## Verification (local, PG 18)

- **Unit+integration: 56 files / 550 tests** (baseline 55/536; +14 reporting
  scenarios covering TZ day/week boundaries, weekStart switches, next-day
  workday overload, current-result-only day scores with a correction
  re-scoring the day, measured-only recurrence adherence, tag-variance
  signal threshold, top-5 rescheduled with hidden tasks excluded, excluded
  focus hiding, local-day focus bucketing, mean lateness, cross-workspace
  non-leakage, note upsert/clear/boundary and zone date validation).
- **E2E/a11y: 118/118** (baseline 114; +4 in `analytics-reporting.spec.ts`:
  IST day/week windows + weekStart label, weekly trends rendered from real
  data with non-judgemental insights + Axe, excluded-task focus removal,
  note save/persist/clear/validation/tenant-isolation + Axe).
  `project-analytics` specs updated to the workspace-local window
  expectations (assertions kept, values corrected — none weakened).
- Lint 0; typecheck 5/5; coverage **88.41%** statements (baseline 88.03%);
  build OK; migration replay ×2 on a fresh DB (19 migrations) idempotent.
- Remote CI: see IMPLEMENTATION_LOG (pending on `61dd487`).

## Remaining M4 / not in scope

- TR-03 and the full TR acceptance matrix remain unresolved (requires the
  outstanding policy decisions).
- Independent tracking/wellbeing controls, retention policy, routed alerts,
  sustained freshness/load SLO qualification — deferred.
- No provider, offline, billing, AI, or desktop work was started or
  invented.
