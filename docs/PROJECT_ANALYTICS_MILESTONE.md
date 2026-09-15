# Project execution analytics milestone

Date: 2026-09-08. Incremental continuation of board milestone `ccd2d4a` on
`arena/01a080d5-nextdoo`. This is an aggregate project-reporting slice of PRD §6.4
and §7.8, not completion of the entire tracking/analytics subsystem or MVP.

## Delivered

Open **Projects → a project → Project analytics**. List and Board remain available,
and List remains the default. Archived projects retain read access to analytics.

The view provides a selected UTC day or rolling seven-day window ending on a
selected date, with:

- Task count, current completion rate, on-time rate and late-completion count.
- Estimated and recorded time, preserving second-level duration precision.
- Average estimate variance and its measured-task denominator.
- Count of cohort tasks whose due date has changed at least once.
- Average measured stored execution score, with result-coverage counts and explicit
  missing/Unmeasured states. Missing results do not become zero scores.
- Plain-language planning observations and calculation definitions.
- Loading, empty and retry states that do not display old metrics as fresh data.
  Older requests are canceled when superseded or when the view unmounts.

The new project endpoint respects an existing stored `disableScores: true`
preference by omitting `averageScore`; the project view hides the numeric score.
This does not implement a preference-settings UI or establish preference enforcement
across all pre-existing analytics/explanation endpoints.

## Reporting definitions — deliberately preserved

These reports reuse the existing summary and scoring engine, not a new model.

**Cohort:** all non-deleted tasks currently assigned to this project whose current
due date falls in the selected window. This is not limited to the 50 loaded UI tasks.
Unscheduled tasks are excluded. Archived tasks with a due date remain in the cohort.

**Window:** UTC midnight through 23:59:59.999 inclusive. A seven-day window includes
the selected date and six preceding dates, not a calendar week. These are not local-
time reports; the UI explicitly labels UTC even for a non-UTC account.

**Current state, not historical attribution:** completion counts use current task
status and can include completions outside the due-date window. Moving a task to
another project/date, reopening, archiving or deleting it can change past reports.
There is no immutable “project at time of completion” snapshot in this slice.

**Time and estimates:** actual time sums persisted minutes plus second remainders;
running elapsed time is not included until recorded. Estimate variance averages
`(actual - estimate) / estimate` over tasks with both a positive estimate and tracked
time. It is not the ratio of aggregate durations. Rescheduled count is lifetime
rescheduling for tasks in this cohort, not reschedule events inside the date range.

**Stored scores:** only non-superseded stored results for the same cohort contribute.
The report does not recalculate, modify events or replace calculation history.
Existing task mutations evaluate inline; a result can still be absent or outdated,
notably when a due instant passes without a new mutation. The UI discloses this.
Detailed component/source-event drilldown, historical attribution, corrections and
background freshness guarantees are not added here.

## API and consistency

`GET /api/v1/projects/:id/analytics?period=day|week&date=YYYY-MM-DD`

- Default period: `week`; omitted date uses today's UTC date.
- Project/workspace identity comes from the authenticated session and path, not a
  supplied workspace query parameter. Unknown query fields are rejected.
- Invalid identifiers, periods and impossible dates return 400. Dates must be year
  1 or later and a seven-day window cannot begin before year 1.
- Unauthenticated requests return 401; foreign/deleted projects return 404.
  Archived projects remain readable.
- Uses existing request IDs, problem-details errors, no-store response protection,
  and a 120-per-minute user/route rate limit. GET does not require a mutation key.
- Reads project access, current task cohort, results and preference in one PostgreSQL
  **read-only repeatable-read transaction**. A concurrent project move cannot combine
  the old cohort with newly written results.
- Returns the summary fields plus `projectId`, `timeZone: "UTC"`,
  `cohort: "current-project-due-date"`, `scoresEnabled`, and measurement coverage.
  `averageScore` is omitted when disabled, null when enabled but unmeasured.

The shared summary response receives additive coverage fields: `storedResultCount`,
`scoredCount`, `missingResultCount`, `actualMeasuredCount`, `estimateMeasuredCount`.
Existing routes, fields and pagination remain in place. No migration, dependency,
scoring weight, mutation behavior or historical event schema was replaced.

### Regression fixed while reusing summaries

Shared summaries previously summed only whole minutes, dropping sub-minute tracked
time and excluding those tasks from estimate variance. A real-database regression
first demonstrated that 30 tracked seconds against a one-minute estimate returned
0 minutes rather than 0.5. Summaries now preserve the seconds and report -50% variance.
The existing global Analytics time display also uses the tested duration formatter,
avoiding floating-point minute tails while preserving whole-minute formatting.

## Validation

| Gate | Result |
|---|---|
| Frozen-lockfile installation | PASS |
| Lint | PASS, zero warnings |
| Typecheck | PASS across all five packages |
| Unit/integration/tooling | **310 passed**, 35 files, no skipped tests |
| Production build | PASS |
| Browser/API scenarios | **29 passed**, no retries |
| Core coverage | 96.66% statements / 85.88% branches / 100% functions / 99.75% lines; all four 85% gates pass |
| Whole-repo measured coverage | 83.63% statements / 77.94% branches / 87.90% functions / 88.20% lines; not an all-repo 85% claim |
| Project-report accessibility | Zero WCAG-tagged axe violations in the tested report; keyboard entry verified |
| Dependency audit | **0 findings**, 364 dependencies |
| `git diff --check` | PASS |

Eight new PostgreSQL tests cover cohort/score isolation, UTC boundaries, invalid
dates, missing measurements, second precision, foreign/deleted/archive/move behavior,
score preference/history preservation, concurrent snapshot consistency and a
52-task cohort with superseded-score exclusion. One new duration unit test covers
whole-minute and second-level formatting. Four new browser/API scenarios cover
metrics/periods/empty states/axe, authenticated tenant/date/archived contracts,
failed-request retry and cancellation of a delayed older response.

Initial service RED: five unimplemented-report failures plus the genuine shared
seconds-precision failure. Initial browser RED: all three original scenarios reached
missing Project analytics controls; the API assertions passed before the archived-
project UI assertion failed. Typecheck caught an incorrect Drizzle transaction-option
name, corrected to `accessMode: 'read only'` before final verification. Existing tests
were retained; no assertions were weakened to obtain green results.

Environment: isolated real PostgreSQL 18.4 UTF-8 and Chromium 149. Evidence outside
Git: `/home/user/nextdoo-project-analytics/`, including `service-red.log`,
`service-expanded.log`, `browser-red.log`, `browser-green.log`, `final-install.log`,
`final-verify.log`, `final-audit.json`. Expected negative-test and missing-production-
SMTP logs do not qualify email delivery. Remote CI and production deployment were
not run. Deploy the endpoint before the new UI; mixed-version rollout is not qualified.

## Remaining scope

This is aggregate project reporting, not the full analytics PRD: local-time buckets,
weekly trends, recurrence/focus/category breakdowns, individual score explanation UI,
corrections, recalculation, historical project attribution, wellbeing settings and
exports remain broader work. Summaries currently read the matching cohort in memory;
large-scale rollups and load qualification are not claimed.

Subtasks/dependencies and richer task-lifecycle UX are logical future bounded slices.
Full offline reconciliation, cursor expiry/virtualization, broader collection paging,
AI, billing, Calendar, attachments and desktop are not delivered here. Existing
production security, retention, provider, observability, load and disaster-recovery
blockers remain. Scoped axe success is not full WCAG certification.


## Subsequent continuation

The next Phase 1 core-task slice is documented in
[Subtasks and dependencies milestone](TASK_RELATIONSHIPS_MILESTONE.md). This analytics
report retains its original validation counts and evidence.
