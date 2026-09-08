# NEXTDOO — Product Requirements Document & Technical Blueprint

| Field | Value |
|---|---|
| Document status | Proposed |
| Version | 1.0 |
| Last updated | 2026-09-08 |
| Product | NEXTDOO |
| Initial platforms | Web, Windows Desktop |
| Mobile | Planned after product-market fit |
| Primary launch segment | Professionals and small teams whose work is deadline-driven, recurring, and measurable |
| Core promise | Help users plan work against available time, execute it, and understand whether their execution matched their intentions |

---

## 1. Executive Summary

NEXTDOO is an outcome-oriented task and time-management platform. Unlike conventional task managers that primarily track what users *intend* to do, NEXTDOO measures the relationship between:

- Planned work
- Available time
- Estimated effort
- Actual effort
- Completion timing
- Rescheduling behavior
- Recurrence adherence
- Goal and project outcomes

The first release focuses on a narrow product loop:

1. Capture a task quickly.
2. Organize it into a project or personal workstream.
3. Plan it against a date and available time.
4. Execute it using reminders, focus sessions, and time tracking.
5. Complete, reschedule, or skip it.
6. Calculate an explainable execution result.
7. Review patterns and improve future planning.

The MVP will **not** attempt to be a complete workspace, knowledge base, team collaboration suite, automation platform, plugin marketplace, or enterprise operating system.

### 1.1 Strategic Objective

Establish NEXTDOO as the best task manager for users who want **measurable improvement in execution reliability**, not merely a larger task list.

### 1.2 MVP Success Criteria

Within the first six months after public beta:

| Metric | Initial hypothesis |
|---|---|
| Task capture friction | Median capture-to-saved under 5 seconds |
| Sync reliability | Zero known silent data-loss incidents |
| Explainability | Users can trace every score to source events |
| Weekly review usage | ≥ 40% of activated users complete a weekly review |
| Focus/time tracking | ≥ 25% of activated users use it weekly |
| Analytics engagement | ≥ 20% of weekly active users view execution analytics |
| Qualitative | Paid users report improved planning or follow-through |
| Cost | Product maintains target reliability at acceptable infrastructure cost |

These are **initial hypotheses, not universal industry benchmarks**. They must be validated by cohort, persona, acquisition source, and subscription plan.

---

## 2. Product Strategy

### 2.1 Mission

Help people make realistic commitments, follow through consistently, and learn from how they actually work.

### 2.2 Vision

Become the execution intelligence layer for personal and team work: a system that helps users decide what to do, make realistic plans, complete work, and improve planning through evidence.

### 2.3 Launch Positioning

> NEXTDOO is an outcome-oriented task manager for professionals who want to know not just what they planned, but how reliably their plans became reality.

### 2.4 Ideal Customer Profile

**Primary ICP** — Knowledge workers and independent professionals who:

- Manage 20 to 100 active tasks
- Work across recurring responsibilities and projects
- Frequently underestimate work
- Reschedule tasks repeatedly
- Use calendars and task managers separately
- Need planning visibility without heavyweight project-management software
- Value measurable improvement but dislike punitive productivity systems

Examples: consultants, freelancers, agency operators, product managers, researchers, software engineers, marketing professionals, small business owners, operations specialists.

**Secondary ICP** — Small teams of 2–20 people that need shared projects, task ownership, deadlines, basic execution reporting, and lightweight coordination.

**Deferred ICP (not launch targets)**

- Large enterprises requiring SSO, SCIM, data residency, or complex compliance programs
- Consumers seeking a general-purpose habit or wellness application
- Developers seeking an automation and plugin platform
- Organizations requiring resource planning or portfolio management

### 2.5 User Problems

| Problem | Consequence |
|---|---|
| Users commit to more work than available time allows | Repeated rescheduling and missed deadlines |
| Estimates are not compared with actual effort | Users do not improve estimation |
| Task completion is tracked without context | Users cannot identify why plans fail |
| Calendars and task lists are disconnected | Planning is unrealistic |
| Productivity scores are opaque or punitive | Users distrust or avoid analytics |
| Offline work is unreliable | Users lose trust in synchronization |
| Existing tools are either too simple or too complex | Users maintain fragmented workflows |

### 2.6 Competitive Alternatives

| Alternative | Strength | Gap NEXTDOO exploits |
|---|---|---|
| Todoist / Things / TickTick | Fast capture, mature recurrence | No planned-vs-actual measurement, shallow estimate feedback |
| Notion / ClickUp | Flexibility, breadth | Slow, heavy, weak execution feedback loop |
| Motion / Reclaim | Calendar-aware auto-scheduling | Opaque automation, low user control, no explainable outcome scoring |
| Toggl / Clockify | Accurate time tracking | Not a planning system; no task lifecycle |
| Paper / spreadsheets | Total control | No reminders, no sync, no analysis |

### 2.7 Product Wedge

NEXTDOO competes initially on:

1. **Execution tracking** — planned versus actual behavior
2. **Explainable scoring** — users can understand and modify how results are calculated
3. **Calendar-aware planning** — tasks planned against available time
4. **Low-friction capture** — text now, voice later
5. **Evidence-based improvement** — analytics identify recurring planning problems

NEXTDOO does **not** compete initially on number of views, integrations, templates, or collaboration features.

### 2.8 Defensibility

- Longitudinal execution data
- Personalized estimation and planning models
- User-configured scoring rules
- Historical relationships between task attributes and outcomes
- High switching cost created by useful personal analytics
- Reliable cross-platform synchronization
- Trust created through explainability and privacy controls

Features alone are not defensible. The defensible asset is the user's accumulated execution history and the quality of insights derived from it.

### 2.9 Product Principles

1. **Plan against reality.** Available time matters more than wishful capacity.
2. **Measure without moralizing.** Scores describe patterns; they do not judge users.
3. **Explain every result.** Users must understand why analytics were produced.
4. **Offline means usable.** Core capture and edit work without connectivity.
5. **Automation must be safe.** No silent destructive or privileged actions.
6. **Privacy is a product feature.** Data use must be visible and controllable.
7. **One coherent workflow beats many disconnected features.**
8. **Reliability outranks feature count.**

### 2.10 Explicit Non-Goals (MVP)

Documents/knowledge base · mind maps · Gantt with resource leveling · plugin marketplace · user-written scripts · shell commands · enterprise SSO/SCIM · mobile apps · real-time collaborative editing · team chat · approval workflows · public template marketplace · customer-managed encryption keys · general-purpose AI agents · automatic destructive actions · cross-user leaderboards · psychological or behavioral health claims.

### 2.11 Business Model

| Plan | Price hypothesis (monthly, annual-billed) | Target buyer |
|---|---|---|
| Free | $0 | Trial and casual capture |
| Pro | $8 | Primary ICP individual |
| Team | $12 / seat | Secondary ICP (Phase 2) |
| Enterprise | Custom | Phase 3 only |

Pricing is a **hypothesis**. Validation plan:

| Step | Method | Decision gate |
|---|---|---|
| 1 | 30 problem interviews with primary ICP | ≥ 60% report planned-vs-actual pain unaided |
| 2 | Van Westendorp + Gabor-Granger on beta waitlist (n ≥ 200) | Acceptable range brackets $8 |
| 3 | Paid private alpha at $8 with no discount | ≥ 25% of alpha users convert |
| 4 | A/B on public beta pricing page ($6 / $8 / $10) | Choose max revenue-per-visitor with churn guardrail |
| 5 | Annual vs monthly mix | ≥ 40% annual mix at 2 months free |

### 2.12 Unit Economics Assumptions

| Item | Assumption (per paid user / month) | Notes |
|---|---|---|
| Compute + DB + Redis | $0.35 | Amortized at 10k paid users |
| Object storage + bandwidth | $0.10 | 2 GB avg, egress-lean |
| Email/push delivery | $0.05 | Transactional only |
| AI inference | $0.30 budgeted, $0.45 hard cap | Metered per plan quota |
| Payment processing | $0.35 | ~2.9% + $0.30 on $8 |
| Support | $0.45 | 1 contact / 12 users / month |
| **Total COGS** | **~$1.60** | |
| **Gross margin at $8** | **~80%** | Target floor 75% |

**Gross-margin risks:** AI overuse by power users (mitigate with quotas and cheaper models for parsing); attachment abuse (per-plan storage caps and lifecycle rules); high-touch support during beta (invest in in-product help and status page); Windows desktop crash triage cost (invest in crash telemetry early).

### 2.13 Acquisition Channels

| Channel | Hypothesis | Leading indicator |
|---|---|---|
| Content/SEO on estimation & planning | Highest-intent, compounding | Organic signups/week |
| Productivity communities (Reddit, HN, IndieHackers) | Early adopters accept rough edges | Waitlist conversion |
| Template/teardown content ("why your week slipped") | Demonstrates the wedge | Time on page, signup rate |
| Integration listings (Google Workspace Marketplace) | Distribution after calendar sync ships | Installs |
| Referral (Pro gives Pro month) | Low CAC expansion | Invite acceptance |
| Paid search (defensive, later) | Only after CAC payback proven | CAC payback < 9 months |

### 2.14 Funnel Metrics

| Stage | Definition | Initial target |
|---|---|---|
| Signup → activation | Created 5 tasks + completed 1 + set 1 estimate within 7 days | 45% |
| Activation → habit | 3+ active days in week 2 | 40% |
| Week-4 retention | Any task completed in week 4 | 35% |
| Free → paid | Within 30 days of activation | 6% |
| Monthly logo churn (Pro) | Cancelled / active | < 5% |
| Net revenue retention (Team, Phase 2) | Expansion − churn | > 100% |

### 2.15 Three-Year Strategic Roadmap

| Year | Focus | Outcome |
|---|---|---|
| Year 1 | Individual execution loop; Web + Windows; Google Calendar; tracking v1 | Paid-quality MVP, GA, first 1,000 paying users |
| Year 2 | Teams, mobile, smart planning, automations, advanced tracking rules | Expansion revenue, NRR > 100% |
| Year 3 | Platform + enterprise: public API, plugins, SSO/SCIM, residency | Upmarket motion with compliance program |

---

## 3. Personas And Jobs-To-Be-Done

### 3.1 The Overcommitted Professional

- **Profile:** Multiple projects, frequent reprioritization, finishes later than planned.
- **Job:** "Help me create a realistic day and understand why I missed it."
- **Needs:** Fast capture, calendar-aware planning, estimates, rescheduling visibility, weekly review, nonjudgmental analytics.

### 3.2 The Independent Operator

- **Profile:** Handles sales, delivery, admin, and recurring business tasks alone.
- **Job:** "Help me avoid dropping recurring obligations while preserving flexibility."
- **Needs:** Recurring tasks, reminders, projects, time tracking, basic reporting, desktop access.

### 3.3 The Small-Team Coordinator

- **Profile:** Coordinates work for 2–20 people.
- **Job:** "Help us make commitments visible and identify execution bottlenecks."
- **Needs:** Shared projects, assignment, comments, due dates, team summaries, permissions.

> Team collaboration is **Phase 2** and is not required for initial MVP launch.

---

## 4. Product Scope And Phasing

### 4.1 Phase 1 — Paid-Quality MVP

**Included:** Authentication and account recovery · personal workspace · tasks and subtasks · projects and sections · tags · priorities · estimates and actual duration · due dates and time zones · recurring tasks · list, board, and calendar views · task notes and attachments · natural-language capture · reminders · focus timer · time tracking · execution tracking · daily and weekly analytics · Google Calendar two-way sync · offline capture and sync · web app · Windows desktop app · billing and entitlements · data export and account deletion · auditability and operational monitoring.

**Explicitly deferred:** team collaboration · comments and mentions · advanced automations · voice capture · mobile apps · Outlook and CalDAV · plugin platform · marketplace · enterprise authentication · fully end-to-end encrypted workspaces · advanced AI scheduling · public API.

### 4.2 Phase 2 — Retention And Revenue Expansion

**Included:** workspace collaboration · assignment and team roles · comments and mentions · advanced execution rules and scoring formulas · smart scheduling suggestions · user-configurable automations · voice capture · Outlook Calendar · CalDAV/Apple Calendar · advanced reporting · mobile applications · public API for selected resources · expanded AI assistance.

**Explicitly deferred:** plugin execution sandbox · marketplace · SSO/SCIM · data residency · customer-managed keys · offline-capable mobile parity beyond capture.

### 4.3 Phase 3 — Platform And Enterprise

**Included:** SSO · SCIM · enterprise audit logs · data residency · customer-managed encryption options · plugin SDK · plugin review and permission model · marketplace · advanced workspace administration · compliance program · enterprise support · dedicated environments where commercially justified.

**Explicitly deferred:** on-premise self-hosting · full zero-knowledge workspaces for AI/search-dependent features · professional services organization.

---

## 5. Core Product Loop

### 5.1 Capture

Sources: quick-add input, keyboard shortcut, desktop global shortcut, natural-language text, calendar context.

Example input:

```
Prepare Q3 report tomorrow at 2pm for 90 minutes #finance
```

| Field | Value |
|---|---|
| Title | Prepare Q3 report |
| Due date | Tomorrow |
| Due time | 2:00 PM |
| Estimate | 90 minutes |
| Tag | finance |

Users must confirm interpreted fields before a task is saved when parser confidence is low.

### 5.2 Plan

Users can assign due date/time, add an estimate, place a task in a project, view calendar availability, select a planning window, identify overcommitted days, drag-and-drop, and mark a task flexible.

> The system must not claim a schedule is feasible unless it has enough information to calculate capacity.

### 5.3 Execute

Start a focus session · pause/resume · stop · log manual duration · complete · reschedule · skip a recurrence · add an execution note.

### 5.4 Review

Completion rate · on-time completion rate · estimate accuracy · reschedule frequency · planned vs actual duration · recurrence adherence · project completion trends · explanations for each execution result.

### 5.5 Improve

Suggestions: larger estimates for similar tasks · less work on overloaded days · earlier planning for recurring work · breaking large tasks into subtasks · reviewing frequently rescheduled tasks.

> Suggestions are advisory. They cannot automatically change user plans without confirmation.

---

## 6. Functional Requirements

Every feature below is specified with: user problem, user story, behavior, data, contract, acceptance criteria, security/privacy, performance, dependencies, phase, failure modes.

### 6.1 Authentication And Accounts

| Aspect | Specification |
|---|---|
| User problem | Users need secure, recoverable access across web and desktop |
| User story | As a user, I can sign up, recover my account, and control my sessions |
| Behavior | Email/password, email verification, password reset, session listing/revocation, optional TOTP MFA, multi-device |
| Data | `users`, `sessions`, `mfa_secrets`, `recovery_codes`, `password_reset_tokens` |
| Contract | `POST /v1/auth/register`, `/login`, `/logout`, `/password-reset`, `/mfa/enroll`, `/mfa/verify`; `GET/DELETE /v1/sessions` |
| Security | Argon2id hashing, generic error messages, IP + account rate limits, token hashing at rest, session rotation on privilege change |
| Performance | Login p95 < 400 ms |
| Dependencies | Email provider, Redis rate limiter |
| Phase | MVP (passkeys Phase 2) |
| Failure modes | Email deliverability failure, MFA device loss, session-store outage, credential stuffing |

**Acceptance criteria**

- Password reset tokens expire (≤ 30 min) and are single-use.
- Sessions can be revoked individually and globally; revocation takes effect within 60 seconds everywhere.
- MFA recovery codes are generated once and displayed only during enrollment.
- Account deletion requires explicit confirmation and re-authentication.
- Deleted accounts enter a defined retention period before permanent purge.
- Login endpoint is rate-limited per IP and per account with exponential backoff.

### 6.2 Workspaces

MVP supports one personal workspace per account. The data model must support multiple workspaces for Phase 2.

Fields: `id`, `owner_id`, `name`, `time_zone`, `default_week_start`, `default_workday_start`, `default_workday_end`, `created_at`, `updated_at`, `version`.

### 6.3 Tasks

**Required fields:** title · rich description · status · priority · due date · due time · time zone · estimate · actual duration · tags · project · section · parent task · dependencies · location · custom fields (Phase 2) · recurrence rule · created/updated/completed/archived/deleted timestamps · optimistic-lock `version`.

**States:** `ACTIVE`, `COMPLETED`, `ARCHIVED`, `DELETED`.

| From | To | Allowed action |
|---|---|---|
| Active | Completed | User or supported automation |
| Active | Archived | User |
| Active | Deleted | User, with retention |
| Completed | Active | Restore or reopen |
| Completed | Archived | User |
| Archived | Active | Restore |
| Deleted | Active | Restore during retention |
| Deleted | Permanently deleted | System retention job |

> A task cannot be permanently deleted while required by an immutable historical tracking record unless the tracking record is anonymized or retained per policy.

**Custom states without breaking the system (Phase 2):** each custom state maps to exactly one canonical status (`ACTIVE`, `COMPLETED`, `ARCHIVED`). Reporting, reminders, recurrence, search, and sync operate on the canonical status only; the custom label is presentation metadata with a stable `custom_state_id`. Deleting a custom state remaps its tasks to the canonical default and writes an audit entry.

**Acceptance criteria**

- Optimistic concurrency: a `PATCH` with a stale `version` returns `409 RESOURCE_VERSION_CONFLICT`.
- Completing a task writes exactly one `TASK_COMPLETED` tracking event, even on retry with the same idempotency key.
- Soft delete hides the task from all views within one sync cycle and creates a tombstone.
- Dependency cycles are rejected with `422`.

### 6.4 Projects And Sections

MVP supports project creation, archive and restore, section creation and reorder, task movement between projects, and project-level execution analytics. MVP does not support complex project templates or portfolio hierarchies.

Ordering uses fractional (`position`) keys to make reorder a single-row write and to keep drag-and-drop offline-safe.

### 6.5 Recurring Tasks

Supported: daily · weekly · monthly · specific weekdays · interval-based repetition · end date · occurrence count · time zone · skip occurrence · complete occurrence · reschedule occurrence.

Each recurrence generates an **occurrence record**. Historical occurrences must not be rewritten when the rule changes.

**Acceptance criteria**

- Editing future recurrence does not modify completed historical occurrences.
- Skipping an occurrence records a distinct `TASK_SKIPPED` event.
- Time-zone changes do not duplicate or silently delete occurrences (occurrence key = `rule_id + local_occurrence_date`).
- Duplicate generation is prevented through idempotency keys.
- DST transitions preserve local wall-clock time for the series.

**Failure modes:** generator lag creating a burst of overdue occurrences (cap look-ahead to 60 days and 50 occurrences); rule edits during generation (advisory lock per rule).

### 6.6 Reminders

Types: absolute date/time; relative to due date. Channels: browser notification, desktop notification, email (MVP where enabled). Supports snooze and automatic cancellation after completion.

**States:** `SCHEDULED` → `PROCESSING` → `SENT` | `FAILED` | `CANCELED` | `EXPIRED`.

Reminder delivery is best-effort and must expose delivery status to the user.

**Acceptance criteria**

- Completing a task cancels all pending reminders for it within 30 seconds.
- A reminder is never delivered twice for the same `(reminder_id, channel)` pair.
- Reminders more than 24 hours overdue transition to `EXPIRED` and are not delivered.

### 6.7 Focus Timer And Time Tracking

Start · pause · resume · stop · manual correction · association with a task · optional break intervals · offline operation · cross-device sync.

Only one active timer is permitted per device. The server resolves conflicts when multiple devices report active sessions (latest `started_at` wins as canonical; the other session is closed and flagged `OVERLAPPED`, never deleted).

Actual duration = sum of timer sessions ± audited manual adjustments. All adjustments are audit-logged.

### 6.8 Attachments

Upload · download · preview for supported types · delete · per-plan file-size limits · malware scanning · signed URLs with expiration.

> The client must never receive permanent object-storage credentials.

Flow: `POST /v1/attachments/presign` → direct PUT to storage → `POST /v1/attachments/confirm` → async scan → `scan_status` becomes `CLEAN`/`INFECTED`. Downloads are blocked until `CLEAN`.

### 6.9 Views

**List view:** sort by due date, priority, project, estimate, or custom order; filter by status, tag, project, date; bulk complete/archive/reschedule.

**Board view:** columns are sections; drag-and-drop movement; keyboard-accessible movement alternative; optimistic updates with rollback on failure.

**Calendar view:** day/week/month; tasks displayed with due date/time; calendar events read-only or editable depending on integration settings; overloaded periods visually indicated without implying certainty.

Performance: first meaningful render of Today under 1.5 s on a warm cache; list virtualization above 200 rows.

### 6.10 Natural-Language Capture

The parser may identify dates, times, durations, priorities, tags, projects, and recurrence. It must return structured output with per-field confidence, avoid mutations without confirmation when confidence is low, never infer sensitive recipients or external sharing, and preserve original input for correction subject to privacy settings.

```json
{
  "title": "Prepare Q3 report",
  "fields": {
    "due_date": { "value": "2026-09-09", "confidence": 0.98 },
    "estimate_minutes": { "value": 90, "confidence": 0.91 }
  },
  "requires_confirmation": false
}
```

Default implementation is a **deterministic local parser** (chrono-style grammar). The LLM path is a fallback for unparsed input and is opt-in, budgeted, and validated against the same schema before any mutation.

---

## 7. Execution Tracking System (Primary Differentiator)

### 7.1 Objective

Measure execution quality without assigning moral value to productivity. It answers:

- Was planned work completed?
- Was it completed on time?
- Was effort estimated accurately?
- Was work repeatedly rescheduled?
- Are recurring commitments being maintained?
- Which planning assumptions are consistently wrong?

### 7.2 Tracking Events (append-only)

`TASK_CREATED` · `TASK_PLANNED` · `TASK_STARTED` · `TASK_PAUSED` · `TASK_COMPLETED` · `TASK_RESCHEDULED` · `TASK_SKIPPED` · `TASK_REOPENED` · `TASK_ARCHIVED` · `TIME_LOGGED` · `ESTIMATE_CHANGED` · `RECURRENCE_GENERATED`

Each event includes: event ID · workspace ID · task ID · actor ID or system actor · event type · event timestamp · client timestamp · source device · payload · idempotency key · schema version.

### 7.3 Execution Outcomes

| Outcome | Definition |
|---|---|
| On time | Completed at or before the planned due time |
| Late | Completed after the planned due time |
| Early | Completed before the configured early threshold |
| Rescheduled | Due date changed before completion |
| Skipped | Recurring occurrence intentionally skipped |
| Incomplete | No completion event by review cutoff |
| Unmeasured | Insufficient data to calculate reliably |

> The system must use **Unmeasured** instead of fabricating a score when required data is unavailable.

### 7.4 Score Model

```
execution_score =
    completion_component        * 0.40
  + timing_component            * 0.25
  + estimate_accuracy_component * 0.20
  + recurrence_component        * 0.15
```

Weights are workspace-configurable in Phase 2; MVP uses defaults.

```
completion_component        = 100 if completed else 0
timing_component            = 100 if on time else max(0, 100 - lateness_penalty)
lateness_penalty            = min(100, hours_late * penalty_per_hour)   # default 4
estimate_accuracy_component = 100 - min(100, abs(actual - estimate) / estimate * 100)
recurrence_component        = completed_occurrences / expected_occurrences * 100
```

If no estimate exists, estimate accuracy is `Unmeasured` and excluded; the final score is **normalized over available components**:

```
score = Σ(component_i * weight_i) / Σ(weight_i)   for available components only
```

**Requirements:** show component values · show excluded components · show source events · allow recalculation · preserve prior calculation versions · permit manual annotation · never compare users publicly in MVP · allow users to disable scores and streaks.

### 7.5 Rule Language (Phase 2)

A **declarative, non-Turing-complete** JSON rule format — no user code execution.

```json
{
  "rule_id": "rule_high_priority_late",
  "when": {
    "all": [
      { "field": "priority", "op": "eq", "value": "high" },
      { "field": "outcome", "op": "eq", "value": "late" },
      { "field": "hours_late", "op": "gte", "value": 24 }
    ]
  },
  "then": { "adjust_score": -10, "label": "High-priority work slipped over a day" }
}
```

**Visual rule-builder constraints:** max 10 conditions per rule; max 25 rules per workspace; only whitelisted fields and operators; no loops, no external calls, no free-text expressions; every rule must be previewable against the last 30 days before activation; adjustments are clamped to ±25 points total per result.

### 7.6 Calculation Pipeline

1. Mutation commits → domain event emitted in the same transaction (outbox table).
2. Outbox relay publishes to the job queue.
3. `tracking.evaluate` worker loads the task's event stream.
4. Components are computed; unavailable components are marked `Unmeasured`.
5. Phase 2 rules are applied in deterministic order.
6. A `tracking_results` row is written with `calculation_version` and an explanation payload.
7. Daily/weekly rollups are recomputed for the affected date buckets.

**Idempotency:** results are keyed on `(task_id, occurrence_key, calculation_version, input_event_hash)`. Reprocessing the same inputs is a no-op.

**Recalculation strategy:** on correction, rule change, or engine version bump, enqueue a bounded backfill (default: last 90 days, chunked by workspace and day, rate-limited). Historical results are superseded, never mutated, and remain queryable.

### 7.7 Score Corrections

Users may correct an incorrect due date, mark a task as externally blocked, mark a completion as untracked, exclude a task from analytics, or recalculate a date range.

Corrections must record the actor and reason, preserve original events, mark derived results as recalculated, and avoid rewriting immutable history.

### 7.8 Analytics

**Daily:** planned task count · completed count · completion rate · on-time rate · planned duration · actual duration · average estimate variance · rescheduled count.

**Weekly:** execution score trend · completion consistency · recurrence adherence · most-rescheduled tasks · overloaded planning days · underestimated categories · focus-time trend.

Explanations must be plain language:

> "Your estimate accuracy decreased this week because tasks tagged `client-work` took 42% longer than estimated."

The product must avoid statements such as "You failed this week."

### 7.9 Wellbeing Controls

Settings to independently disable: numeric scores · streaks · celebrations · sounds · comparative metrics · overload warnings. Defaults: streaks **on**, celebrations **off**, comparisons **absent in MVP**.

### 7.10 Export

CSV and JSON export of events, results, and rollups, generated asynchronously and delivered via a signed URL expiring in 24 hours.

### 7.11 Acceptance Tests (tracking)

| ID | Scenario | Expected |
|---|---|---|
| TR-01 | Task completed 10 min before due | Outcome `on time`, timing 100 |
| TR-02 | Task completed 6 h late, penalty 4/h | timing 76 |
| TR-03 | No estimate, completed on time | estimate component `Unmeasured`, score normalized over 0.80 weight |
| TR-04 | Same completion event replayed | Exactly one result row; no score change |
| TR-05 | Due date corrected after completion | New result with `recalculated=true`; original events intact |
| TR-06 | Recurring series, 3 of 4 done, 1 skipped | recurrence component 75 |
| TR-07 | Scores disabled in settings | API omits score; explanation endpoint returns 403-free empty payload |

---

## 8. UX And Accessibility

### 8.1 Information Architecture

Primary navigation: **Today · Inbox · Projects · Calendar · Focus · Analytics · Settings**. Navigation exposes the core loop, not a feature catalog.

### 8.2 Capture Flow

Globally available in the desktop client · opens with a keyboard shortcut · accepts plain text · optional project and tag selection · saves immediately when unambiguous · shows parsed fields when ambiguous · works offline.

### 8.3 Daily Planning Flow

Shows tasks due today, unscheduled inbox items, calendar events, estimated workload, available work capacity, overload warning, and recommended adjustments. Recommendations never move tasks automatically.

### 8.4 Focus Flow

Current task · timer · estimate · elapsed time · pause/stop · notes · complete and reschedule actions. The UI must not make stopping or pausing difficult.

### 8.5 Review Flow

Completion summary · timing summary · estimate accuracy · rescheduling analysis · recurring adherence · suggested adjustments · optional notes.

### 8.6 System States

| State | Requirement |
|---|---|
| Empty | Explain the loop and offer one primary action; never a blank page |
| Loading | Skeletons ≤ 1 s; spinners only beyond that; never layout shift |
| Error | Human-readable cause, retry affordance, request ID for support |
| Offline | Persistent, non-blocking badge; queued mutation count visible |
| Conflict | Side-by-side local vs server values with per-field choose action |
| Degraded | Feature-level notice (e.g. "Calendar sync delayed") not a global banner |

### 8.7 Keyboard Shortcuts

| Key | Action |
|---|---|
| `Ctrl+Space` | Global quick capture (desktop) |
| `N` | New task |
| `E` | Edit selected |
| `Space` | Complete / uncomplete |
| `T` | Set due date |
| `F` | Start focus session |
| `/` | Search |
| `G` then `T/I/P/C/A` | Go to Today / Inbox / Projects / Calendar / Analytics |
| `?` | Shortcut help |

### 8.8 Accessibility

Target **WCAG 2.2 AA** where practical: full keyboard navigation · visible focus indicators · semantic labels · screen-reader announcements for timer and sync changes · no color-only meaning · minimum usable contrast (4.5:1 text, 3:1 UI) · reduced-motion mode · high-contrast mode · accessible drag-and-drop alternatives (move-to menu) · accessible date/time entry · errors associated with fields · no time limit without extension or pause control · target size ≥ 24×24 CSS px · focus never obscured by sticky UI.

### 8.9 Responsive Breakpoints

| Breakpoint | Layout |
|---|---|
| < 640 px | Single column, bottom action bar (web responsive, not a mobile app) |
| 640–1024 px | Two panes, collapsible sidebar |
| 1024–1440 px | Sidebar + content + optional detail pane |
| > 1440 px | Max content width 1280 px, extra space to the detail pane |

### 8.10 Localization

MVP: English, with locale-aware dates, times, numbers, and time zones. Phase 2: Spanish, French, German, Portuguese, Japanese. Architecture must support RTL, pluralization, variable-length strings, localized recurrence rules, and localized notification content. No concatenated sentence fragments; ICU message format only.

---

## 9. Technical Architecture

### 9.1 Selected Stack

| Layer | Decision |
|---|---|
| Web | Next.js App Router |
| UI | React + TypeScript |
| Desktop | Tauri (Windows) |
| Monorepo | pnpm + Turborepo |
| API | TypeScript modular monolith |
| Database | PostgreSQL |
| ORM | **Drizzle** |
| Cache and coordination | Redis |
| Jobs | Durable queue (BullMQ on Redis; managed queue if scale requires) |
| Object storage | S3-compatible |
| Search | PostgreSQL full-text search initially |
| Observability | OpenTelemetry logs, traces, metrics |
| Testing | Vitest, Playwright, contract tests, k6 load tests |
| Deployment | Containerized services + managed PostgreSQL |
| Billing | Stripe |

**Architecture decision — modular monolith.** The product has significant cross-domain consistency requirements across tasks, recurrence, tracking, billing, and sync. A modular monolith with workers reduces distributed-transaction complexity while preserving domain boundaries.

**ORM decision — Drizzle over Prisma.** Rationale: (a) SQL-first schema and query builder keep complex sync/tracking queries, CTEs, partial indexes, and `FOR UPDATE SKIP LOCKED` idiomatic; (b) no separate query engine binary — simpler Tauri sidecar and container images; (c) lower cold-start and memory footprint; (d) migrations are plain SQL and reviewable. Trade-off accepted: less mature tooling and no built-in studio. **Replacement criteria:** switch if team velocity on schema evolution demonstrably suffers over two consecutive milestones, or if a required feature (e.g. multi-schema tenancy tooling) is unavailable.

### 9.2 Domain Modules

Identity · Accounts · Workspaces · Tasks · Projects · Scheduling · Recurrence · Timers · Tracking · Calendar · Notifications · Attachments · Billing · Sync · Analytics · Audit.

Each module owns its database tables, domain services, validation, events, authorization checks, and tests. Cross-module access goes through published service interfaces and events — never direct table reads.

### 9.3 Service Responsibilities

| Component | Responsibilities |
|---|---|
| Web client | UI, local cache, offline mutation queue, client validation, sync client |
| Desktop client | Tauri shell, local SQLite, native notifications, global shortcut, offline operation, OS credential storage |
| API | AuthN/AuthZ, query and mutation endpoints, sync endpoints, billing portal handoff, event publication |
| Auth service | In-process module: sessions, MFA, password reset, revocation |
| Database | System of record for transactional data |
| Object storage | Attachments and generated exports; metadata stays in PostgreSQL |
| Search index | PostgreSQL FTS in MVP; dedicated engine only when justified |
| Job workers | Reminders, notifications, calendar sync, recurrence generation, tracking calculation, indexing, file scanning, exports, retention/deletion |
| Notification service | Channel abstraction (web push, desktop, email), delivery status, suppression |
| Billing service | Stripe integration, webhook verification, entitlement projection |
| AI service | Provider abstraction, quota and cost enforcement, response validation, redaction, telemetry |
| Analytics pipeline | Rollups from tracking events into daily/weekly aggregates; product telemetry separated from user analytics |

### 9.4 Conditions For Extracting A Service

A module may become a separate service only when: independent scaling is required · failure isolation is necessary · deployment cadence materially differs · regulatory or security boundaries require separation · team ownership is sufficiently independent · operational complexity is justified by measured load.

### 9.5 Repository Layout

```
nextdoo/
├─ apps/
│  ├─ web/           # Next.js App Router
│  ├─ desktop/       # Tauri shell
│  ├─ api/           # modular monolith HTTP API
│  └─ worker/        # queue consumers
├─ packages/
│  ├─ core/          # domain logic, pure and testable
│  ├─ db/            # Drizzle schema + migrations
│  ├─ sync/          # shared sync protocol + client repositories
│  ├─ nlp/           # deterministic capture parser
│  ├─ ui/            # design system
│  ├─ contracts/     # zod schemas, OpenAPI, event catalog
│  └─ config/        # eslint, tsconfig, tailwind presets
└─ docs/
```

---

## 10. Offline And Synchronization Design

### 10.1 MVP Strategy

**Local-first mutation queue with server-authoritative synchronization.** No CRDTs in MVP — the data model is field-scalar dominant and CRDT merge semantics, testing, and operational cost are not justified before collaborative editing exists.

The client stores cached entities, pending mutations, received server changes, tombstones, a sync cursor, and a device identifier.

### 10.2 Local Database

Desktop uses **SQLite** via a Tauri-compatible layer; web uses **IndexedDB** through a shared TypeScript repository abstraction. Structured task data must never live in browser local storage.

### 10.3 Mutation Format

```json
{
  "mutation_id": "mut_01J...",
  "device_id": "dev_01J...",
  "entity_type": "task",
  "entity_id": "task_01J...",
  "operation": "update",
  "base_version": 12,
  "payload": { "title": "Prepare report", "estimate_minutes": 90 },
  "created_at": "2026-09-08T14:00:00Z"
}
```

### 10.4 Synchronization Sequence

1. Client creates a local mutation.
2. Client applies an optimistic local update.
3. Client queues the mutation.
4. Client sends the mutation when connected (batched, ordered per entity).
5. Server validates authorization and `base_version`.
6. Server applies the mutation transactionally.
7. Server returns the canonical entity and new version.
8. Server emits a change record with a monotonic sequence.
9. Client acknowledges the mutation and drops it from the queue.
10. Client pulls missing changes using the sync cursor.

### 10.5 Conflict Detection

Conflicts occur when: the server version differs from `base_version` · the entity was deleted remotely · a recurrence rule changed on another device · calendar updates conflict with local task edits · a timer is active on another device.

### 10.6 Conflict Resolution

| Conflict | Resolution |
|---|---|
| Scalar task field | Last-write-wins only when no user-visible loss occurs |
| Title or description | Show conflict UI with local and server versions |
| Completion vs edit | Completion preserved; edit retained where possible |
| Delete vs edit | Delete wins, with restore option during retention |
| Recurrence rule | Server version wins and conflict is shown |
| Timer overlap | Preserve both sessions and flag overlap |
| Calendar date conflict | User chooses task or calendar value |

> The system must not silently discard user-authored content. Rejected local content is preserved in a recoverable `conflict_snapshots` store for 30 days.

### 10.7 Idempotency

Every mutation and worker operation requires an idempotency key. Repeated requests return the original result rather than duplicating tasks, recurrence occurrences, reminders, tracking events, billing entitlement updates, or calendar mappings.

### 10.8 Ordering, Retry, Partial Failure

- Ordering: FIFO per `entity_id`; independent entities may sync in parallel.
- Retry: exponential backoff 1s → 2s → 4s … capped at 5 min, with jitter; unlimited retries for network errors, 5 attempts for 5xx, none for 4xx (surfaced to the user).
- Partial batch failure: successful mutations are acknowledged individually; failures are isolated and do not block the batch.
- Poison mutation: after 5 hard failures, quarantine, surface in a "needs attention" list, keep raw payload.

### 10.9 Sync SLO

- 99% of connected mutations acknowledged within 5 seconds.
- 99.9% of successful sync operations preserve data integrity.
- No known silent data loss.
- Conflict resolution must be observable and testable.

---

## 11. Security And Privacy

### 11.1 Threat Model

| Asset | Threat | Control |
|---|---|---|
| Account credentials | Credential theft, stuffing | Argon2id, MFA, rate limits, breach-password checks |
| Sessions | Token theft, fixation | Secure/HttpOnly/SameSite cookies, rotation, revocation, device binding |
| Workspace data | Unauthorized access, IDOR | Object-level authorization on every query |
| Attachments | Malware, data leakage, SSRF via preview | Scanning, signed URLs, content-type allowlist, no server-side fetch of user URLs |
| Calendar tokens | OAuth compromise | Envelope encryption, least-privilege scopes, revocation on disconnect |
| Webhooks | Forged or replayed events | Signature verification, timestamp window, event-ID dedupe |
| Billing state | Client manipulation | Entitlements only from verified provider webhooks |
| Desktop capabilities | Privileged command execution | No arbitrary shell in MVP; Tauri allowlist minimized |
| AI requests | Sensitive data exposure, prompt injection | Consent, minimization, output validation, no tool-calling into destructive APIs |
| Exports | Data exfiltration | Authenticated generation, short expiry, audit log, rate limit |
| Admin access | Insider misuse | Least privilege, break-glass with approval, full audit |
| Account deletion | Malicious or accidental destruction | Re-authentication, retention window, audit, restore path |

### 11.2 Authentication

MVP: email/password · password reset · email verification · optional TOTP MFA · session listing and revocation. Phase 2: passkeys (WebAuthn) · social login where justified · workspace-level authentication policies.

### 11.3 Authorization

Authorization is enforced **server-side for every object**. MVP role: personal workspace owner. Phase 2 roles: Owner, Admin, Member, Guest, Billing administrator.

| Capability | Owner | Admin | Member | Guest | Billing |
|---|---|---|---|---|---|
| Manage billing | ✔ | ✖ | ✖ | ✖ | ✔ |
| Delete workspace | ✔ | ✖ | ✖ | ✖ | ✖ |
| Manage members | ✔ | ✔ | ✖ | ✖ | ✖ |
| Create/edit tasks | ✔ | ✔ | ✔ | own only | ✖ |
| View analytics | ✔ | ✔ | own | own | ✖ |
| Export data | ✔ | ✔ | own | ✖ | ✖ |

> Do not rely on hidden UI controls for security.

### 11.4 Data Protection

TLS 1.2+ everywhere · encryption at rest via managed infrastructure · secrets in a managed secrets manager (never in env files in production) · OAuth tokens encrypted with envelope encryption and a rotating KEK · passwords stored only as Argon2id hashes · attachment URLs signed and short-lived (≤ 15 min) · sensitive fields excluded from logs · production data access audited and time-boxed.

**Never stored in plaintext:** passwords, session tokens (hash only), MFA secrets, recovery codes (hash only), OAuth access/refresh tokens, webhook signing secrets, API keys (hash + last-4), export download tokens.

### 11.5 Security Headers And Input Handling

CSP with nonce-based scripts and no `unsafe-inline` · HSTS with preload · `X-Content-Type-Options: nosniff` · `Referrer-Policy: strict-origin-when-cross-origin` · `Permissions-Policy` minimized · strict CORS allowlist · SameSite cookies plus CSRF tokens for cookie-authenticated mutations · zod validation at every boundary · output encoding by default in React · parameterized queries only · rendered rich text sanitized server-side.

### 11.6 AI Privacy

By default: user data is not used to train external models · AI features are opt-in where external providers receive content · users can disable AI · sensitive task content can be excluded · AI requests have cost and rate limits · AI outputs are treated as untrusted suggestions · destructive mutations require confirmation.

### 11.7 Dangerous Capabilities

The MVP does **not** support arbitrary shell commands, user-authored executable scripts, unreviewed plugins, automatic external sharing, automatic billing changes, or silent calendar deletion.

Future automation must use a **constrained action vocabulary** with explicit permission grants, per-action confirmation for destructive operations, sandboxed execution, and rate limits.

### 11.8 Assurance Program

OWASP ASVS Level 2 as the verification baseline, mapped to test cases · SAST and dependency scanning on every PR · container image scanning on build · secret scanning with push protection · annual third-party penetration test plus a test before enterprise GA · documented incident response with severity levels, on-call, and customer notification timelines.

### 11.9 Privacy Operations

Data export · account deletion · workspace deletion · data-processing disclosures · retention policies · subprocessor list · consent records where required · access and correction workflows · legal hold capability for enterprise plans.

GDPR/CCPA operational commitments: DSAR fulfillment within 30 days · deletion propagated to backups by expiry of the backup window (documented) · DPA available · records of processing maintained · breach notification within 72 hours where applicable.

---

## 12. Reliability And Operations

### 12.1 Service-Level Objectives

| Area | MVP target |
|---|---|
| API availability | 99.9% monthly |
| Web availability | 99.9% monthly |
| API p95 latency (reads) | < 300 ms |
| API p95 latency (writes) | < 500 ms |
| Sync acknowledgement | 99% < 5 s |
| Reminder enqueueing | 99% within 60 s of schedule |
| Calendar sync freshness | 99% within 10 min |
| File upload success | 99.5% of accepted files |
| Background-job completion | 99% within job SLA |
| Search freshness | < 60 s |
| Error rate (5xx) | < 0.1% of requests |
| Data-loss incidents | Zero tolerated |

Targets exclude planned maintenance only when communicated per the status-page policy.

### 12.2 Recovery Targets

RTO 4 hours (primary production service) · RPO 15 minutes (transactional data) · attachment RPO 1 hour · regional recovery within RTO · daily backups retained 30 days subject to privacy and legal requirements.

### 12.3 Backups

Continuous point-in-time recovery · daily full backups · encrypted backup storage · separate backup credentials · **monthly restore tests** · quarterly disaster-recovery exercises · restore test results retained for audit.

### 12.4 Jobs

Every job defines: idempotency key · max retry count · exponential backoff · timeout · dead-letter behavior · structured error code · alert threshold · replay procedure.

| Job | Schedule | Retries | DLQ action |
|---|---|---|---|
| `recurrence.generate` | Every 15 min | 5 | Alert; manual replay per rule |
| `reminder.dispatch` | Every 30 s | 3 | Mark `FAILED`, surface in UI |
| `calendar.sync` | Webhook + 10 min poll | 5 | Pause connection, notify user |
| `tracking.evaluate` | On event | 5 | Alert; results marked stale |
| `attachment.scan` | On upload | 3 | Quarantine file |
| `export.generate` | On demand | 2 | Notify user with retry link |
| `retention.purge` | Daily | 3 | Alert; never auto-skip |

### 12.5 Deployment

Automated backward-compatible migrations (expand → migrate → contract) · feature flags for risky changes · canary deployment for major releases · documented rollback · no destructive migration without a tested reversal or restore plan · health and readiness checks · deployment audit trail.

### 12.6 Incident Management

| Severity | Definition | Response |
|---|---|---|
| SEV-1 | Data loss, security breach, or widespread outage | Immediate, 24/7 page |
| SEV-2 | Major feature unavailable or severe degradation | Response during on-call window |
| SEV-3 | Limited user impact | Normal engineering prioritization |
| SEV-4 | Minor defect or request | Backlog |

Every SEV-1/SEV-2 requires: incident owner · timeline · user-impact statement · mitigation · root-cause analysis · corrective actions · status-page communication where applicable.

### 12.7 Capacity Planning

| Users | Shape | Infrastructure |
|---|---|---|
| 1,000 | ~50 RPS peak | 1 API container ×2, 1 worker, small managed PG, small Redis |
| 10,000 | ~400 RPS peak | 4 API, 3 workers, PG with read replica, Redis with persistence |
| 100,000 | ~3,500 RPS peak | Autoscaled API, partitioned queues, PG read replicas + connection pooler, partitioned `tracking_events`, CDN for static |
| 1,000,000 | ~30,000 RPS peak | Sharded/regional PG by workspace, extracted sync + notification services, dedicated search cluster, tiered event storage |

---

## 13. Database Design

### 13.1 Conventions

UUIDv7-compatible identifiers · all tables carry `created_at`/`updated_at` · mutable entities carry `version` · restrictive FK deletion by default · soft deletion where recovery is required · tracking events are append-only · every workspace-scoped table carries `workspace_id` and is indexed on it.

### 13.2 Core Entities

| Entity | Important fields | Key indexes |
|---|---|---|
| users | id, email, password_hash, timezone, status | unique email |
| sessions | id, user_id, token_hash, expires_at, revoked_at | user, expiration |
| workspaces | id, owner_id, name, timezone | owner |
| workspace_members | workspace_id, user_id, role | unique (workspace, user) |
| roles_permissions | role, permission | unique composite |
| projects | id, workspace_id, name, status | (workspace, status) |
| sections | id, project_id, name, position | (project, position) |
| tasks | id, workspace_id, project_id, section_id, title, status, due_at, estimate_minutes, version | (workspace, status), due_at, project, parent_task_id |
| task_dependencies | task_id, depends_on_task_id | composite unique |
| tags | id, workspace_id, name | unique (workspace, name) |
| task_tags | task_id, tag_id | composite unique |
| comments (P2) | id, task_id, author_id, body | (task, created_at) |
| attachments | id, task_id, object_key, size, scan_status | task |
| reminders | id, task_id, scheduled_at, status | (status, scheduled_at) |
| recurrence_rules | id, task_id, rule, timezone | task |
| task_occurrences | id, recurrence_rule_id, occurrence_key, status | unique (rule, key) |
| timer_sessions | id, task_id, device_id, started_at, ended_at | (task, started_at) |
| tracking_configs | id, workspace_id, weights, enabled_features | workspace |
| tracking_rules (P2) | id, workspace_id, definition, active | (workspace, active) |
| tracking_events | id, task_id, type, occurred_at, idempotency_key | (task, occurred_at), unique idempotency_key |
| tracking_results | id, task_id, score, calculation_version | (task, calculation_version) |
| calendar_connections | id, user_id, provider, encrypted_token | (user, provider) |
| calendar_mappings | id, connection_id, task_id, external_id, sync_state | unique (connection, external_id) |
| automations (P2) | id, workspace_id, trigger, actions, enabled | (workspace, enabled) |
| automation_runs (P2) | id, automation_id, status, started_at | (automation, started_at) |
| notifications | id, user_id, type, status, scheduled_at | (user, status) |
| audit_logs | id, workspace_id, actor_id, action, target_type, target_id | (workspace, created_at) |
| api_keys (P3) | id, workspace_id, key_hash, last_four, scopes | workspace |
| oauth_tokens | id, user_id, provider, encrypted_access, encrypted_refresh | (user, provider) |
| subscriptions | id, user_id, provider_customer_id, status | provider_customer_id |
| entitlements | id, user_id, feature, limit_value, source | unique (user, feature) |
| user_preferences | user_id, key, value | unique (user, key) |
| device_registrations | id, user_id, device_id, platform, push_token | unique (user, device_id) |
| sync_changes | sequence, workspace_id, entity_type, entity_id, operation, payload | (workspace, sequence) |
| sync_tombstones | entity_type, entity_id, deleted_at | (entity_type, entity_id) |
| exports | id, user_id, status, object_key, expires_at | (user, status) |

### 13.3 Task Constraints

`title` required and length-limited (1–500) · `estimate_minutes >= 0` · due dates carry an explicit or inherited time zone · `parent_task_id <> id` · dependency cycles rejected · archived projects cannot accept new active tasks · deleted tasks cannot receive new reminders · completion timestamps immutable except through an audited correction.

### 13.4 Example Migration

```sql
-- 0003_tasks.sql
CREATE TYPE task_status AS ENUM ('ACTIVE','COMPLETED','ARCHIVED','DELETED');

CREATE TABLE tasks (
  id               uuid PRIMARY KEY,
  workspace_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id       uuid REFERENCES projects(id) ON DELETE SET NULL,
  section_id       uuid REFERENCES sections(id) ON DELETE SET NULL,
  parent_task_id   uuid REFERENCES tasks(id) ON DELETE CASCADE,
  title            text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 500),
  description      text,
  status           task_status NOT NULL DEFAULT 'ACTIVE',
  priority         smallint NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 3),
  due_at           timestamptz,
  due_timezone     text,
  estimate_minutes integer CHECK (estimate_minutes >= 0),
  position         numeric(20,10) NOT NULL DEFAULT 0,
  version          integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  archived_at      timestamptz,
  deleted_at       timestamptz,
  CONSTRAINT tasks_no_self_parent CHECK (parent_task_id IS DISTINCT FROM id)
);

CREATE INDEX tasks_ws_status_due_idx ON tasks (workspace_id, status, due_at)
  WHERE deleted_at IS NULL;
CREATE INDEX tasks_project_idx ON tasks (project_id) WHERE deleted_at IS NULL;
CREATE INDEX tasks_fts_idx ON tasks
  USING gin (to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(description,'')));
```

### 13.5 Retention

| Data | Default retention |
|---|---|
| Deleted tasks | 30 days |
| Audit logs | 1 year (personal accounts) |
| Tracking events | Life of account unless user deletes them |
| Failed jobs | 30 days |
| Application logs | 30 days |
| Security logs | 1 year |
| Export files | 24 hours |
| Conflict snapshots | 30 days |
| Billing records | As required by tax and accounting obligations |

Retention periods must be configurable where law, contract, or plan requirements differ.

---

## 14. API And Events

### 14.1 Standards

Version prefix `/v1` · JSON over HTTPS · cursor-based pagination · RFC 7807-style errors · idempotency keys on mutation endpoints · request IDs on every response · explicit time zones for date-time fields · authorization checked at the resource boundary.

### 14.2 Error Schema

```json
{
  "type": "https://api.nextdoo.example/errors/conflict",
  "title": "Version conflict",
  "status": 409,
  "code": "RESOURCE_VERSION_CONFLICT",
  "detail": "The task was changed on another device.",
  "request_id": "req_01J...",
  "resource": { "type": "task", "id": "task_01J..." }
}
```

### 14.3 Endpoint Catalog

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/auth/register` | Create account |
| POST | `/v1/auth/login` | Authenticate |
| POST | `/v1/auth/logout` | Revoke session |
| POST | `/v1/auth/password-reset` | Request reset |
| POST | `/v1/auth/mfa/enroll` | Begin TOTP enrollment |
| GET | `/v1/me` | Current user |
| GET / DELETE | `/v1/sessions` | List / revoke sessions |
| GET / POST | `/v1/workspaces` | List / create workspace |
| GET / POST | `/v1/tasks` | Query / create task |
| GET / PATCH / DELETE | `/v1/tasks/:id` | Fetch / update / soft-delete |
| POST | `/v1/tasks/:id/complete` | Complete task |
| POST | `/v1/tasks/:id/reopen` | Reopen task |
| POST | `/v1/tasks/:id/reschedule` | Reschedule task |
| POST | `/v1/tasks/:id/restore` | Restore deleted task |
| GET / POST | `/v1/projects` | List / create project |
| GET / POST | `/v1/projects/:id/sections` | Sections |
| GET / POST | `/v1/views` | Saved views |
| GET | `/v1/tracking/summary` | Analytics summary |
| GET | `/v1/tracking/tasks/:id` | Task execution result + explanation |
| POST | `/v1/tracking/recalculate` | Bounded recalculation |
| POST | `/v1/timers` | Start timer |
| PATCH | `/v1/timers/:id` | Pause / resume / stop |
| GET / POST / DELETE | `/v1/reminders` | Reminder management |
| GET | `/v1/calendar/connections` | List calendar connections |
| POST | `/v1/calendar/connections` | Begin OAuth connection |
| DELETE | `/v1/calendar/connections/:id` | Disconnect and revoke tokens |
| POST | `/v1/calendar/sync` | Force sync |
| GET / POST | `/v1/automations` | Phase 2 |
| GET / POST | `/v1/tasks/:id/comments` | Phase 2 |
| POST | `/v1/attachments/presign` | Get signed upload URL |
| POST | `/v1/attachments/confirm` | Confirm upload |
| GET | `/v1/billing/portal` | Stripe portal handoff |
| GET | `/v1/billing/entitlements` | Current entitlements |
| POST | `/v1/exports` | Request data export |
| DELETE | `/v1/account` | Request account deletion |
| POST | `/v1/sync/push` | Submit mutation batch |
| GET | `/v1/sync/pull` | Pull changes since cursor |

### 14.4 Endpoint Detail — Create Task

| Aspect | Value |
|---|---|
| Method / path | `POST /v1/tasks` |
| Auth | Session cookie or bearer token |
| Authorization | Caller must be a member of `workspace_id` |
| Idempotency | `Idempotency-Key` header required; 24 h replay window |
| Rate limit | 120 req/min per user |
| Audit event | `task.created` |

Request:

```json
{
  "workspace_id": "ws_01J...",
  "title": "Prepare Q3 report",
  "project_id": "prj_01J...",
  "due_at": "2026-09-09T14:00:00+02:00",
  "due_timezone": "Europe/Berlin",
  "estimate_minutes": 90,
  "priority": 2,
  "tags": ["finance"]
}
```

Response `201`:

```json
{
  "id": "task_01J...",
  "version": 1,
  "status": "ACTIVE",
  "title": "Prepare Q3 report",
  "due_at": "2026-09-09T12:00:00Z",
  "due_timezone": "Europe/Berlin",
  "estimate_minutes": 90,
  "created_at": "2026-09-08T10:22:31Z"
}
```

Errors: `400 VALIDATION_FAILED` · `401 UNAUTHENTICATED` · `403 FORBIDDEN` · `409 IDEMPOTENCY_CONFLICT` · `422 DEPENDENCY_CYCLE` · `429 RATE_LIMITED`.

### 14.5 Endpoint Detail — Sync Push

`POST /v1/sync/push`, auth required, batch ≤ 200 mutations, 60 req/min per device.

```json
{ "device_id": "dev_01J...", "mutations": [ { "mutation_id": "mut_01J...", "entity_type": "task", "entity_id": "task_01J...", "operation": "update", "base_version": 12, "payload": { "title": "Prepare report" } } ] }
```

```json
{
  "results": [
    { "mutation_id": "mut_01J...", "status": "applied", "entity": { "id": "task_01J...", "version": 13 } }
  ],
  "cursor": "seq_918273"
}
```

Per-mutation statuses: `applied` · `duplicate` · `conflict` (includes server entity) · `rejected` (includes error object).

### 14.6 Pagination

```
GET /v1/tasks?workspace_id=...&status=ACTIVE&limit=50&cursor=eyJ...
```

```json
{ "data": [], "page": { "next_cursor": "eyJ...", "has_more": true } }
```

### 14.7 Rate Limits

| Scope | Limit |
|---|---|
| Auth endpoints | 10/min per IP, 5/min per account |
| Read endpoints | 600/min per user |
| Write endpoints | 120/min per user |
| Sync push | 60/min per device |
| AI endpoints | Plan quota + 10/min per user |
| Export | 3/day per user |

### 14.8 Event Catalog

| Event | Payload highlights | Consumers |
|---|---|---|
| `task.created` | task_id, workspace_id, actor | Tracking, sync, audit |
| `task.updated` | changed fields, version | Tracking, sync, audit |
| `task.completed` | completed_at, planned_due_at | Tracking, reminders (cancel), analytics |
| `task.deleted` / `task.restored` | task_id, actor | Sync, audit, retention |
| `reminder.scheduled` / `.sent` / `.failed` / `.canceled` | reminder_id, channel, status | Notifications, audit |
| `tracking.result_created` / `.recalculated` | task_id, score, calculation_version | Analytics, UI |
| `calendar.item_imported` / `.updated` | external_id, mapping_id | Sync, UI |
| `automation.started` / `.succeeded` / `.failed` / `.retried` | run_id, automation_id | Audit, UI (Phase 2) |
| `subscription.changed` | plan, status, period_end | Entitlements, notifications |
| `workspace.member_changed` | member_id, role, actor | Authorization cache, audit |

All events carry `event_id`, `occurred_at`, `schema_version`, and are published via a transactional outbox.

---

## 15. Integrations

### 15.1 Prioritization

| Integration | Customer value | Implementation risk | Phase |
|---|---|---|---|
| Google Calendar | High | Medium | MVP |
| Email (transactional) | High | Low | MVP |
| Outlook Calendar | Medium-high | Medium | Phase 2 |
| Apple / CalDAV | Medium | High | Phase 2 |
| Slack notifications | Medium | Low | Phase 2 |
| Zapier / public API | Medium | Medium | Phase 3 |

### 15.2 Google Calendar (MVP)

| Aspect | Specification |
|---|---|
| Authentication | OAuth 2.0 authorization code with PKCE |
| Scopes | `calendar.events` + `calendar.readonly` (least privilege; no Drive, no contacts) |
| Data imported | Event id, title, start/end, all-day flag, recurrence, busy/free status, calendar id |
| Data exported | Tasks with a due time, as timed events on a dedicated "NEXTDOO" calendar |
| Sync direction | Two-way for NEXTDOO-created events; one-way read for user's other calendars |
| Webhooks | Google push notification channels, renewed before expiry |
| Polling fallback | Incremental sync token every 10 minutes when a channel is unhealthy |
| Rate-limit handling | Respect 403/429 backoff, token-bucket per connection, batch requests |
| Conflict behavior | If both sides changed since last sync, surface conflict UI; never auto-delete a user event |
| Token rotation | Refresh tokens encrypted; access tokens refreshed on demand and cached ≤ expiry |
| Disconnect behavior | Revoke tokens with the provider, retain mappings 30 days for reconnect, stop all jobs |
| Data deletion | On disconnect + retention expiry, purge imported event cache and mappings |

**Acceptance criteria:** a task with a due time appears on the NEXTDOO calendar within 60 seconds; deleting the task removes the event; deleting the event in Google marks the task as unscheduled and notifies the user; sync never creates duplicate events for the same task (unique `(connection_id, task_id)` mapping).

---

## 16. AI And Voice

### 16.1 Principles

AI is **assistive, explainable, and optional**. AI must never silently delete, reschedule, share, execute commands, or change billing.

### 16.2 Features

| Feature | Phase | Implementation | Confirmation required |
|---|---|---|---|
| Natural-language task parsing | MVP | Deterministic grammar; LLM fallback opt-in | Only on low confidence |
| Categorization (project/tag suggestion) | Phase 2 | Small model + heuristics | Yes, suggested chips |
| Duplicate detection | Phase 2 | Embedding similarity + trigram | Yes |
| Scheduling suggestions | Phase 2 | Rules over calendar capacity + history | Yes |
| Weekly summarization | Phase 2 | LLM over aggregated, minimized data | No (read-only output) |
| Voice capture | Phase 2 | Speech-to-text → same parser path | Yes, transcript shown |

### 16.3 Architecture

```
Client → /v1/ai/* → AI Service
  ├─ consent + entitlement check
  ├─ quota + cost budget check (Redis counters)
  ├─ redaction / minimization
  ├─ provider adapter (primary, fallback)
  ├─ structured output validation (zod / JSON schema)
  ├─ confirmation gate for any mutation
  └─ telemetry: tokens, latency, cost, model + prompt version
```

Prompt and model versions are stored in `packages/contracts` and pinned per release; every AI response records `prompt_version` and `model_id` for reproducibility.

### 16.4 Controls

| Control | Value |
|---|---|
| Cost budget | $0.30/user/month soft, $0.45 hard cap, then degrade to deterministic parser |
| Rate limit | 10 requests/min per user |
| Failure fallback | Deterministic parser; feature hidden with a clear notice on outage |
| Data sent to third parties | Only with explicit opt-in; per-workspace toggle; excluded fields configurable |
| Training | Contractual opt-out with providers; customer data never used to train models |
| Local models | Roadmap item for Phase 3 desktop (on-device parsing for privacy-sensitive users) |

---

## 17. Monetization

### 17.1 Entitlement Matrix

| Capability | Free | Pro | Team (P2) | Enterprise (P3) |
|---|---|---|---|---|
| Active tasks | 200 | Unlimited | Unlimited | Unlimited |
| Projects | 3 | Unlimited | Unlimited | Unlimited |
| Attachment storage | 100 MB | 5 GB | 10 GB/seat | Negotiated |
| Max file size | 10 MB | 100 MB | 250 MB | Negotiated |
| Calendar connections | 1 read-only | 3 two-way | 5/seat | Unlimited |
| Execution tracking history | 30 days | Unlimited | Unlimited | Unlimited |
| Custom scoring rules | ✖ | 10 | 25 | Unlimited |
| AI requests / month | 20 | 500 | 1,000/seat | Negotiated |
| Focus timer & time tracking | ✔ | ✔ | ✔ | ✔ |
| Offline desktop | ✔ | ✔ | ✔ | ✔ |
| Export (CSV/JSON) | Manual, 1/day | Unlimited | Unlimited | Scheduled |
| Collaboration seats | 1 | 1 | 2–50 | Unlimited |
| Audit logs | ✖ | 30 days | 1 year | 7 years |
| SSO / SCIM | ✖ | ✖ | ✖ | ✔ |
| Support | Community | Email, 2 business days | Priority, 1 business day | SLA-backed |

### 17.2 Lifecycle Rules

| Situation | Behavior |
|---|---|
| Trial | 14 days of Pro, no card required; on expiry account becomes Free, no data deleted |
| Upgrade | Immediate entitlement grant, prorated charge via Stripe |
| Downgrade | Effective at period end; over-limit data becomes read-only, never deleted |
| Failed payment | Stripe dunning; 7-day grace with full access; then Free with banner |
| Cancellation | Access until period end; export available for 30 days |
| Refunds | Pro-rated refund within 14 days of first charge; case-by-case afterwards |
| Taxes | Handled by Stripe Tax; VAT/GST collected where required |
| Marketplace revenue share | Phase 3: 80/20 developer/platform split, documented before SDK launch |

### 17.3 Entitlement Integrity

Entitlements are derived **only** from verified Stripe webhooks, stored server-side, and cached with a short TTL. A client-side response never grants access. Webhook handling is idempotent on Stripe `event.id`, and a nightly reconciliation job compares Stripe subscription state to local entitlements and alerts on drift.

---

## 18. Testing And Quality Gates

### 18.1 Test Strategy

| Layer | Tool | Scope | Target |
|---|---|---|---|
| Unit | Vitest | Domain logic: recurrence, scoring, parser, conflict rules | ≥ 85% on `packages/core` |
| Component | Vitest + Testing Library | UI components, states | Critical components covered |
| Integration | Vitest + ephemeral PG/Redis | Repositories, workers, transactions | All mutation paths |
| Contract | OpenAPI + zod snapshot | API request/response shapes | 100% of `/v1` endpoints |
| E2E | Playwright | Capture → plan → focus → complete → review | Core loop on Chromium + WebView2 |
| Sync/conflict | Deterministic simulator | Multi-device, offline, partial failure | Scenario matrix below |
| Calendar | Sandbox account + mocked API | Two-way sync, tokens, revocation | All acceptance criteria |
| Security | SAST, dependency, secret scan, ASVS L2 checklist | Every PR | Zero high findings |
| Accessibility | axe-core + manual keyboard/screen-reader | Every core screen | Zero critical violations |
| Performance | Lighthouse CI + API benchmarks | Web vitals, p95 latency | Budgets enforced |
| Load | k6 | 10× expected peak | SLOs hold |
| Backup/restore | Scheduled job | Monthly restore into clean env | RTO/RPO verified |
| Chaos | Fault injection | DB failover, Redis loss, provider 5xx, clock skew | Graceful degradation |

### 18.2 Sync Scenario Matrix

| ID | Scenario | Expected |
|---|---|---|
| SY-01 | Offline create, reconnect | Task appears once, server ID reconciled |
| SY-02 | Same mutation replayed twice | `duplicate`, no second entity |
| SY-03 | Two devices edit different fields | Both retained |
| SY-04 | Two devices edit the title | Conflict UI, no silent loss |
| SY-05 | Delete on A, edit on B | Delete wins; B offered restore |
| SY-06 | Complete on A, reschedule on B | Completion preserved |
| SY-07 | Timer running on two devices | Both sessions kept, overlap flagged |
| SY-08 | Clock skew of 10 minutes | Server timestamps authoritative |
| SY-09 | Batch with one invalid mutation | Others applied; invalid quarantined |
| SY-10 | 5,000 queued offline mutations | Drained without duplication or timeout |

### 18.3 Release Gates

| Gate | Criterion |
|---|---|
| Correctness | All unit/integration/E2E green; sync matrix green |
| Security | No high/critical SAST, dependency, or secret findings; ASVS L2 items for touched areas verified |
| Accessibility | No critical axe violations; keyboard path verified on changed screens |
| Performance | p95 read < 300 ms, write < 500 ms in staging load test; web vitals budget met |
| Reliability | Error budget not exhausted; alerting in place for new jobs |
| Migration safety | Backward-compatible, tested rollback or restore plan |
| Observability | New paths emit traces, metrics, and structured logs with request IDs |
| Rollback readiness | Feature flag or documented revert within 15 minutes |

---

## 19. Delivery Plan (12 Months)

### 19.1 Team Composition

| Role | Count | Notes |
|---|---|---|
| Full-stack engineer | 3 | One owns sync, one owns tracking, one owns product surface |
| Frontend/design engineer | 1 | Design system, accessibility, desktop shell |
| Product/PM (founder) | 1 | Research, prioritization, GTM |
| Part-time SRE/security | 0.5 | Infra, on-call setup, ASVS, pen-test coordination |
| Part-time support/success | 0.5 | From beta onwards |

Capacity assumption: ~4.5 engineering FTE, 70% on roadmap, 20% on quality/ops, 10% on unplanned work.

### 19.2 Milestones

| Milestone | Months | Ships | Explicitly deferred | Go/no-go |
|---|---|---|---|---|
| M0 Foundations | 1 | Monorepo, CI, auth, workspace, PG schema, observability skeleton | Any UI polish | Auth + deploy pipeline working end-to-end |
| M1 Task core | 2–3 | Tasks, subtasks, projects, sections, tags, list view, quick capture | Board/calendar views | Core CRUD passes E2E + contract tests |
| M2 Time & sync | 4–5 | Offline queue, sync protocol, desktop shell, timer, time tracking | Multi-workspace | Sync scenario matrix green |
| M3 Tracking v1 | 6–7 | Events, scoring, explanations, daily/weekly analytics, review flow | Custom rules | Tracking acceptance tests green |
| M4 Calendar & reminders | 8 | Google Calendar two-way, reminders, notifications | Outlook/CalDAV | Calendar acceptance criteria met |
| M5 Private alpha | 9 | Billing, entitlements, export, deletion, board + calendar views | Collaboration | 30 alpha users, no SEV-1 for 2 weeks |
| M6 Public beta | 10–11 | Hardening, performance, accessibility, docs, status page, support tooling | Mobile | SLOs met 30 days; ≥ 25% alpha conversion |
| M7 GA | 12 | Pricing live, marketing site, onboarding, pen-test remediation | Enterprise | Pen test clean; restore test passed; error budget healthy |

### 19.3 Technical Spikes

| Spike | Question | Timebox |
|---|---|---|
| Sync protocol prototype | Does the mutation-queue model hold under the scenario matrix? | 2 weeks (M0–M1) |
| Tauri + SQLite + WebView2 | Packaging, auto-update, notification, shortcut reliability on Windows | 1 week (M2) |
| Recurrence + DST | Does the occurrence-key model survive time-zone edge cases? | 1 week (M1) |
| Calendar two-way | Duplicate/echo prevention with push channels | 1 week (M4) |
| Tracking recalculation cost | Backfill cost at 100k tasks | 3 days (M3) |

### 19.4 Per-Phase Requirements

Every milestone must ship with: instrumentation for its funnel events · at least 5 user-research sessions · written acceptance criteria · success metrics · an operational readiness checklist (alerts, runbook, dashboard, rollback, on-call owner).

### 19.5 Launch Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Sync complexity slips M2 | Everything downstream slips | Spike first, cut multi-workspace, keep conflict UI minimal |
| Tracking feels punitive | Core differentiator rejected | Wellbeing controls, language review, alpha qualitative testing |
| Google Calendar review delays | M4 slips | Start verification early; ship one-way read first |
| Windows desktop support cost | Support overload | Crash telemetry, auto-update, staged rollout |
| Low willingness to pay | No revenue | Pricing validation plan (§2.11) before GA |
| Solo-founder key-person risk | Delivery risk | Documentation, ADRs, pairing on critical modules |

---

## 20. Final Decision Register

### 20.1 Architecture Decisions

| ID | Decision | Rationale |
|---|---|---|
| AD-01 | Modular monolith + workers | Cross-domain consistency; extract later on measured need |
| AD-02 | Drizzle over Prisma | SQL-first, no query engine binary, cheaper container/desktop footprint |
| AD-03 | PostgreSQL FTS before a search engine | Adequate at expected scale; avoids a second system of record |
| AD-04 | Mutation queue, not CRDTs, for MVP | Scalar-dominant model; CRDT cost unjustified pre-collaboration |
| AD-05 | SQLite (desktop) + IndexedDB (web) behind one repository abstraction | Shared sync logic, platform-appropriate storage |
| AD-06 | Transactional outbox for events | Guarantees event/state consistency |
| AD-07 | BullMQ on Redis for jobs | Operational simplicity; managed queue only if throughput demands |
| AD-08 | Stripe for billing, webhook-driven entitlements | Never rebuild billing; integrity from server-verified events |

### 20.2 Product Decisions

| ID | Decision |
|---|---|
| PD-01 | Launch single-user; collaboration is Phase 2 |
| PD-02 | Execution tracking is the wedge; everything else supports it |
| PD-03 | Scores are explainable, correctable, and disableable |
| PD-04 | No leaderboards or cross-user comparison in MVP |
| PD-05 | Google Calendar is the only integration at launch |
| PD-06 | Deterministic parser is the default; LLM is fallback and opt-in |
| PD-07 | Windows-only desktop at launch; macOS/Linux after PMF |

### 20.3 Security Decisions

| ID | Decision |
|---|---|
| SD-01 | No shell commands, no user scripts, no unreviewed plugins in MVP |
| SD-02 | OWASP ASVS L2 as the verification baseline |
| SD-03 | OAuth tokens under envelope encryption with rotating KEK |
| SD-04 | Entitlements only from verified provider webhooks |
| SD-05 | AI opt-in for third-party processing; no training on customer data |
| SD-06 | Object-level authorization on every read and write |

### 20.4 Deferred Decisions

Mobile framework (React Native vs native) · dedicated search engine choice · multi-region residency architecture · plugin sandbox technology · workspace-level E2EE scope · Team pricing per-seat vs flat · analytics warehouse choice.

### 20.5 Highest-Risk Assumptions

1. Users will maintain estimates consistently enough for estimate accuracy to be meaningful.
2. Explainable execution scoring is motivating rather than discouraging.
3. Individual professionals will pay ~$8/month for planning feedback.
4. Google Calendar alone is sufficient integration coverage at launch.
5. Offline sync can be made reliable enough to be a trust asset with 4.5 FTE.
6. Tracking data creates real switching cost within 90 days of use.

### 20.6 Required Experiments

| Experiment | Validates | Success signal |
|---|---|---|
| Estimate prompt A/B (required vs optional) | Assumption 1 | ≥ 60% of tasks carry an estimate |
| Score presentation test (score vs narrative only) | Assumption 2 | Higher week-4 retention in winning arm |
| Paid alpha at list price | Assumption 3 | ≥ 25% conversion |
| Integration demand survey during beta | Assumption 4 | < 20% cite a missing integration as a blocker |
| Chaos + offline drills | Assumption 5 | Zero data-loss findings across the matrix |
| Cohort analysis of analytics users | Assumption 6 | Analytics viewers churn at less than half the rate |

### 20.7 Open Questions

- Should Free include any execution tracking history at all, or a 7-day teaser?
- Is the weekly review a page, an email, or both?
- Should calendar events be plannable objects or purely context?
- How much history should the desktop client cache offline by default?
- Do we ship a public roadmap during beta?

### 20.8 Top Ten Failure Modes

| # | Failure mode | Detection | Mitigation |
|---|---|---|---|
| 1 | Silent sync data loss | Integrity checks, client/server entity diff canary | Conflict snapshots, no destructive merges, alert on diff |
| 2 | Duplicate recurrence generation | Unique occurrence keys, duplicate metric | Idempotency keys, advisory locks |
| 3 | Reminder storm after outage | Queue depth alert | Expiry window, dispatch rate limit |
| 4 | Calendar echo loop | Sync-origin tagging, event rate metric | Origin markers, loop breaker, backoff |
| 5 | Entitlement drift after webhook loss | Nightly reconciliation | Replay Stripe events, alert on mismatch |
| 6 | Tracking backfill saturates the DB | Job latency + DB CPU alerts | Chunked, rate-limited, off-peak backfills |
| 7 | Attachment malware served to users | Scan status gating, scanner health check | Block downloads until `CLEAN`, quarantine |
| 8 | AI cost blowout | Per-user and global cost counters | Hard caps, degrade to deterministic path |
| 9 | Desktop auto-update bricks clients | Crash telemetry, update success rate | Staged rollout, rollback channel |
| 10 | Punitive analytics drives churn | Cohort retention by analytics exposure | Wellbeing controls, language review, opt-out |

### 20.9 Recommended First Engineering Tickets

| # | Ticket | Outcome |
|---|---|---|
| 1 | Scaffold pnpm + Turborepo monorepo with `web`, `api`, `worker`, `core`, `db`, `contracts` | Buildable skeleton, CI on PR |
| 2 | PostgreSQL + Drizzle baseline schema: users, sessions, workspaces, projects, sections, tasks | Migrations run in CI |
| 3 | Auth module: register, login, verify, reset, sessions, revocation, Argon2id | E2E auth flow green |
| 4 | Task CRUD API with optimistic versioning and RFC 7807 errors | Contract tests pass |
| 5 | Transactional outbox + BullMQ worker skeleton with idempotency helper | One job end-to-end |
| 6 | Tracking event writer wired to task mutations | Events append-only with idempotency |
| 7 | Sync protocol v1: `/v1/sync/push` and `/v1/sync/pull` with cursor and tombstones | Scenario matrix SY-01…SY-05 green |
| 8 | Web shell: Today, Inbox, quick capture, list view with optimistic updates | Core loop clickable |
| 9 | Deterministic NL parser package with confidence scores | Parser unit suite green |
| 10 | Observability baseline: OpenTelemetry traces, request IDs, structured logs, health checks | Dashboards and alerts live |

---

## Appendix A — Glossary

| Term | Definition |
|---|---|
| Occurrence | A single generated instance of a recurring task |
| Execution result | A calculated, explainable outcome record for a task or occurrence |
| Unmeasured | A component excluded from scoring due to insufficient data |
| Mutation | A client-originated change submitted through the sync protocol |
| Tombstone | A record marking an entity as deleted for sync purposes |
| Entitlement | A server-side capability grant derived from billing state |
| Wedge | The narrow initial advantage the product competes on |

## Appendix B — Document Control

| Item | Value |
|---|---|
| Owner | Product (founder) |
| Reviewers | Engineering, Security, SRE, Design |
| Review cadence | Per milestone |
| Change process | PR against `docs/PRD.md` with decision-register update |
