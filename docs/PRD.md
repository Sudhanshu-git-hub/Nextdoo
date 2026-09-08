# NEXTDOO — Product Requirements Document & Technical Blueprint

| Field | Value |
|---|---|
| Document status | Proposed |
| Version | 1.1 |
| Last updated | 2026-09-08 |
| Product | NEXTDOO |
| Initial platforms | Web, Windows Desktop |
| Mobile | Planned after product-market fit |
| Primary launch segment | Professionals and small teams whose work is deadline-driven, recurring, and measurable |
| Core promise | Help users plan work against available time, execute it, and understand whether their execution matched their intentions |

---

## Contents

| § | Section |
|---|---|
| 1 | [Executive Summary](#1-executive-summary) |
| 2 | [Product Strategy](#2-product-strategy) |
| 3 | [Personas And Jobs-To-Be-Done](#3-personas-and-jobs-to-be-done) |
| 4 | [Product Scope And Phasing](#4-product-scope-and-phasing) |
| 5 | [Core Product Loop](#5-core-product-loop) |
| 6 | [Functional Requirements](#6-functional-requirements) |
| 7 | [Execution Tracking System](#7-execution-tracking-system-primary-differentiator) |
| 8 | [UX And Accessibility](#8-ux-and-accessibility) |
| 9 | [Technical Architecture](#9-technical-architecture) |
| 10 | [Offline And Synchronization Design](#10-offline-and-synchronization-design) |
| 11 | [Security And Privacy](#11-security-and-privacy) |
| 12 | [Reliability And Operations](#12-reliability-and-operations) |
| 13 | [Database Design](#13-database-design) |
| 14 | [API Design](#14-api-design) |
| 15 | [Event Architecture](#15-event-architecture) |
| 16 | [Calendar Integration](#16-calendar-integration) |
| 17 | [AI And Voice](#17-ai-and-voice) |
| 18 | [Monetization](#18-monetization) |
| 19 | [Testing And Quality Gates](#19-testing-and-quality-gates) |
| 20 | [Analytics And Instrumentation](#20-analytics-and-instrumentation) |
| 21 | [Delivery Plan](#21-delivery-plan) |
| 22 | [Final Decision Register](#22-final-decision-register) |
| A | [Glossary](#appendix-a--glossary) |
| B | [Document Control](#appendix-b--document-control) |

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

Flow: `POST /v1/attachments/upload` (upload authorization) → direct PUT to storage → `POST /v1/attachments/:id/complete` → async scan → `scan_status` becomes `CLEAN`/`INFECTED`. Downloads are issued through `GET /v1/attachments/:id/download` as a short-lived signed URL and are blocked until `CLEAN`.

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

## 14. API Design

### 14.1 API Standards

Version prefix `/v1` · JSON over HTTPS · cursor-based pagination · RFC 7807-style errors · idempotency keys on mutation endpoints · request IDs on every response · explicit time zones for date-time fields · authorization checked at the resource boundary · no breaking change without a new version.

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

Canonical error codes: `VALIDATION_FAILED` · `UNAUTHENTICATED` · `FORBIDDEN` · `NOT_FOUND` · `RESOURCE_VERSION_CONFLICT` · `IDEMPOTENCY_CONFLICT` · `DEPENDENCY_CYCLE` · `ENTITLEMENT_LIMIT_REACHED` · `RATE_LIMITED` · `PROVIDER_UNAVAILABLE` · `INTERNAL_ERROR`.

### 14.3 Core Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/auth/login` | Authenticate |
| POST | `/v1/auth/logout` | Revoke current session |
| POST | `/v1/auth/logout-all` | Revoke all sessions |
| POST | `/v1/auth/password-reset` | Request password reset |
| POST | `/v1/auth/password-reset/confirm` | Complete password reset |
| POST | `/v1/auth/mfa/enable` | Start TOTP enrollment |
| POST | `/v1/auth/mfa/verify` | Confirm TOTP enrollment |
| POST | `/v1/auth/mfa/disable` | Disable TOTP |
| GET | `/v1/me` | Fetch current user |
| PATCH | `/v1/me` | Update profile and preferences |
| GET | `/v1/me/sessions` | List active sessions |
| DELETE | `/v1/me/sessions/:id` | Revoke a session |
| GET | `/v1/workspaces` | List available workspaces |
| POST | `/v1/workspaces` | Create a workspace |
| GET | `/v1/workspaces/:id` | Fetch workspace |
| PATCH | `/v1/workspaces/:id` | Update workspace settings |
| DELETE | `/v1/workspaces/:id` | Delete workspace |
| GET | `/v1/tasks` | Query tasks |
| POST | `/v1/tasks` | Create task |
| GET | `/v1/tasks/:id` | Fetch task |
| PATCH | `/v1/tasks/:id` | Update task |
| POST | `/v1/tasks/:id/complete` | Complete task |
| POST | `/v1/tasks/:id/reopen` | Reopen task |
| POST | `/v1/tasks/:id/reschedule` | Reschedule task |
| POST | `/v1/tasks/:id/archive` | Archive task |
| POST | `/v1/tasks/:id/restore` | Restore task |
| DELETE | `/v1/tasks/:id` | Soft-delete task |
| POST | `/v1/tasks/bulk` | Execute authorized bulk operations |
| GET | `/v1/tasks/:id/history` | Fetch task event history |
| GET | `/v1/projects` | List projects |
| POST | `/v1/projects` | Create project |
| GET | `/v1/projects/:id` | Fetch project |
| PATCH | `/v1/projects/:id` | Update project |
| POST | `/v1/projects/:id/archive` | Archive project |
| POST | `/v1/projects/:id/restore` | Restore project |
| GET | `/v1/projects/:id/analytics` | Fetch project analytics |
| GET | `/v1/sections` | List sections |
| POST | `/v1/sections` | Create section |
| PATCH | `/v1/sections/:id` | Update or reorder section |
| DELETE | `/v1/sections/:id` | Delete section |
| GET | `/v1/tags` | List tags |
| POST | `/v1/tags` | Create tag |
| PATCH | `/v1/tags/:id` | Update tag |
| DELETE | `/v1/tags/:id` | Delete tag |
| GET | `/v1/tracking/summary` | Fetch daily or weekly summary |
| GET | `/v1/tracking/tasks/:id` | Fetch task execution result |
| POST | `/v1/tracking/recalculate` | Recalculate a date range |
| POST | `/v1/tracking/corrections` | Record a tracking correction |
| GET | `/v1/tracking/events` | Query tracking events |
| POST | `/v1/timers` | Start timer |
| GET | `/v1/timers/active` | Fetch active timer |
| PATCH | `/v1/timers/:id` | Pause, resume, or stop timer |
| POST | `/v1/timers/:id/correct` | Apply audited duration correction |
| GET | `/v1/reminders` | List reminders |
| POST | `/v1/reminders` | Create reminder |
| PATCH | `/v1/reminders/:id` | Update reminder |
| POST | `/v1/reminders/:id/snooze` | Snooze reminder |
| DELETE | `/v1/reminders/:id` | Cancel reminder |
| GET | `/v1/calendar/connections` | List calendar connections |
| POST | `/v1/calendar/connections/google/start` | Begin Google OAuth |
| GET | `/v1/calendar/connections/google/callback` | Complete Google OAuth |
| POST | `/v1/calendar/connections/:id/sync` | Request synchronization |
| PATCH | `/v1/calendar/connections/:id` | Update sync settings |
| DELETE | `/v1/calendar/connections/:id` | Disconnect calendar |
| GET | `/v1/calendar/events` | Fetch normalized calendar events |
| POST | `/v1/attachments/upload` | Create upload authorization |
| POST | `/v1/attachments/:id/complete` | Confirm upload completion |
| GET | `/v1/attachments/:id/download` | Create signed download URL |
| DELETE | `/v1/attachments/:id` | Delete attachment |
| POST | `/v1/natural-language/parse` | Parse task text |
| POST | `/v1/ai/suggestions` | Generate advisory suggestions |
| GET | `/v1/notifications` | List notifications |
| PATCH | `/v1/notifications/:id` | Mark notification read |
| GET | `/v1/billing/subscription` | Fetch subscription state |
| POST | `/v1/billing/checkout` | Start checkout |
| POST | `/v1/billing/portal` | Open billing portal |
| POST | `/v1/billing/webhooks` | Receive provider events |
| GET | `/v1/sync/pull` | Pull changes after cursor |
| POST | `/v1/sync/push` | Submit offline mutations |
| GET | `/v1/exports` | List exports |
| POST | `/v1/exports` | Request data export |
| GET | `/v1/exports/:id` | Fetch export status |
| GET | `/v1/exports/:id/download` | Download export |
| POST | `/v1/account/deletion` | Request account deletion |
| POST | `/v1/account/deletion/cancel` | Cancel pending deletion |

### 14.4 Task Creation Request

`POST /v1/tasks` — session cookie or bearer token; caller must be a member of `workspace_id`; `Idempotency-Key` header required with a 24-hour replay window; 120 requests/minute per user; emits audit event `task.created`.

```json
{
  "workspace_id": "ws_01J...",
  "title": "Prepare Q3 report",
  "description": null,
  "project_id": "proj_01J...",
  "section_id": "sec_01J...",
  "priority": "HIGH",
  "due_at": "2026-09-09T14:00:00-04:00",
  "time_zone": "America/New_York",
  "estimate_minutes": 90,
  "tag_ids": ["tag_01J..."],
  "recurrence_rule": null,
  "client_mutation_id": "mut_01J..."
}
```

### 14.5 Task Response

```json
{
  "id": "task_01J...",
  "workspace_id": "ws_01J...",
  "title": "Prepare Q3 report",
  "status": "ACTIVE",
  "priority": "HIGH",
  "due_at": "2026-09-09T14:00:00-04:00",
  "time_zone": "America/New_York",
  "estimate_minutes": 90,
  "actual_duration_minutes": 0,
  "version": 1,
  "created_at": "2026-09-08T14:00:00Z",
  "updated_at": "2026-09-08T14:00:00Z"
}
```

Errors: `400 VALIDATION_FAILED` · `401 UNAUTHENTICATED` · `403 FORBIDDEN` · `409 IDEMPOTENCY_CONFLICT` · `422 DEPENDENCY_CYCLE` · `429 RATE_LIMITED`.

### 14.6 Sync Push Contract

`POST /v1/sync/push` — authentication required, batch of at most 200 mutations, 60 requests/minute per device.

```json
{
  "device_id": "dev_01J...",
  "mutations": [
    {
      "mutation_id": "mut_01J...",
      "entity_type": "task",
      "entity_id": "task_01J...",
      "operation": "update",
      "base_version": 12,
      "payload": { "title": "Prepare report" }
    }
  ]
}
```

```json
{
  "results": [
    {
      "mutation_id": "mut_01J...",
      "status": "applied",
      "entity": { "id": "task_01J...", "version": 13 }
    }
  ],
  "cursor": "seq_918273"
}
```

Per-mutation statuses: `applied` · `duplicate` · `conflict` (includes the server entity) · `rejected` (includes an error object).

### 14.7 Pagination

Collection endpoints use cursor pagination:

```
GET /v1/tasks?limit=50&cursor=eyJvZmZzZXQiOjUwfQ==
```

```json
{
  "data": [],
  "pagination": {
    "next_cursor": "eyJvZmZzZXQiOjEwMH0=",
    "has_more": true
  }
}
```

Rules:

- Default page size: 50.
- Maximum page size: 100.
- Cursors are opaque.
- Cursors expire after 24 hours.
- Results use stable ordering.
- Deleted records are excluded by default.
- Clients can request archived records explicitly.

### 14.8 Rate Limits

| Client type | Limit |
|---|---:|
| Unauthenticated authentication routes | 10 requests/minute/IP |
| Standard authenticated reads | 600 requests/minute/user |
| Standard authenticated writes | 120 requests/minute/user |
| Sync push | 60 requests/minute/device |
| AI parsing | Plan-specific |
| File-upload authorization | 30 requests/minute/user |
| Data exports | 3 requests/hour/user |
| Recalculation jobs | 10 requests/hour/user |
| Calendar synchronization | Provider and plan-specific |

Rate-limit responses use HTTP 429 and include a `Retry-After` header.

---

## 15. Event Architecture

### 15.1 Event Envelope

```json
{
  "event_id": "evt_01J...",
  "event_type": "task.completed",
  "schema_version": 1,
  "occurred_at": "2026-09-08T18:30:00Z",
  "workspace_id": "ws_01J...",
  "actor_id": "user_01J...",
  "entity_type": "task",
  "entity_id": "task_01J...",
  "correlation_id": "req_01J...",
  "payload": {}
}
```

### 15.2 Domain Events

| Event | Producer | Consumers |
|---|---|---|
| `task.created` | Tasks | Tracking, sync, analytics |
| `task.updated` | Tasks | Sync, reminders, calendar |
| `task.completed` | Tasks | Tracking, recurrence, analytics |
| `task.reopened` | Tasks | Tracking, analytics |
| `task.rescheduled` | Tasks | Tracking, reminders, analytics |
| `task.deleted` | Tasks | Sync, reminders, retention |
| `task.restored` | Tasks | Sync, analytics |
| `recurrence.occurrence_generated` | Recurrence | Tasks, reminders, sync |
| `reminder.scheduled` | Reminders | Notification workers |
| `reminder.sent` | Notifications | Analytics, audit |
| `reminder.failed` | Notifications | Retry and alerting |
| `timer.started` | Timers | Tracking, sync |
| `timer.stopped` | Timers | Tracking, analytics |
| `tracking.result_created` | Tracking | Analytics, notifications |
| `tracking.result_recalculated` | Tracking | Analytics, audit |
| `calendar.item_imported` | Calendar | Tasks, sync |
| `calendar.item_updated` | Calendar | Tasks, sync |
| `subscription.changed` | Billing | Entitlements, audit |
| `workspace.member_changed` | Workspaces | Authorization cache, audit |
| `automation.started` / `.succeeded` / `.failed` / `.retried` | Automations (Phase 2) | Audit, UI |
| `export.completed` | Exports | Notifications |
| `account.deletion_requested` | Accounts | Retention and compliance jobs |

### 15.3 Transactional Event Publication

Domain changes and their corresponding outbox events must be written in the **same database transaction**.

A worker publishes pending outbox records to the internal event bus. Events are:

- Immutable.
- Versioned.
- Retriable.
- Idempotently consumable.
- Traceable through correlation IDs.

A failed consumer must not roll back the original user transaction.

---

## 16. Calendar Integration

### 16.1 Google Calendar MVP

The first calendar integration supports Google Calendar.

Capabilities: OAuth authorization · calendar selection · event import · task-to-event export where enabled · two-way updates for mapped records · webhook-based change detection where supported · polling fallback · manual sync · disconnect and token revocation.

| Aspect | Specification |
|---|---|
| Authentication | OAuth 2.0 authorization code with PKCE |
| Data imported | Event ID, title, start/end, all-day flag, recurrence, busy/free status, calendar ID |
| Data exported | Tasks with a due time, as timed events on a dedicated NEXTDOO calendar |
| Sync direction | Two-way for NEXTDOO-created events; one-way read for the user's other calendars |
| Webhooks | Google push notification channels, renewed before expiry |
| Polling fallback | Incremental sync token every 10 minutes when a channel is unhealthy |
| Rate-limit handling | Respect 403/429 backoff, token bucket per connection, batched requests |
| Token rotation | Refresh tokens encrypted; access tokens refreshed on demand and cached until expiry |

### 16.2 Requested Permissions

Request the minimum permissions required for the selected mode:

- Read-only calendar access for availability display.
- Read/write calendar access only when task-to-event synchronization is enabled.

The user must choose the synchronization mode **before** authorization is completed. No Drive, contacts, or mail scopes are requested.

### 16.3 Normalization

External events are normalized into:

```json
{
  "external_id": "google_event_123",
  "calendar_id": "calendar_123",
  "title": "Client meeting",
  "starts_at": "2026-09-09T15:00:00-04:00",
  "ends_at": "2026-09-09T16:00:00-04:00",
  "time_zone": "America/New_York",
  "is_all_day": false,
  "busy": true,
  "source": "google"
}
```

### 16.4 Conflict Behavior

- External calendar changes never silently overwrite user-authored task titles.
- If both systems modify a mapped date, the mapping enters `CONFLICT`.
- The user sees local and external values.
- The user may select: keep the NEXTDOO value, keep the calendar value, or unlink the records.
- Conflict decisions are audit-logged.

### 16.5 Disconnect Behavior

When a calendar is disconnected:

- OAuth tokens are revoked where supported.
- Tokens are deleted from application storage.
- Mappings are retained as historical metadata for 30 days.
- Future synchronization stops immediately.
- Imported tasks remain unless the user explicitly chooses removal.
- Exported calendar events are not automatically deleted by default.

### 16.6 Acceptance Criteria

- A task with a due time appears on the NEXTDOO calendar within 60 seconds.
- Deleting the task removes the mapped event.
- Deleting the event in Google marks the task unscheduled and notifies the user.
- Sync never creates duplicate events for the same task (unique `(connection_id, task_id)` mapping).
- A revoked or expired token pauses the connection and surfaces a reconnect prompt rather than failing silently.

### 16.7 Integration Prioritization

| Integration | Customer value | Implementation risk | Phase |
|---|---|---|---|
| Google Calendar | High | Medium | MVP |
| Email (transactional) | High | Low | MVP |
| Outlook Calendar | Medium-high | Medium | Phase 2 |
| Apple / CalDAV | Medium | High | Phase 2 |
| Slack notifications | Medium | Low | Phase 2 |
| Zapier / public API | Medium | Medium | Phase 3 |

---

## 17. AI And Voice

### 17.1 AI Scope

MVP AI is limited to:

- Natural-language task parsing.
- Task categorization suggestions.
- Duplicate-task suggestions.
- Basic execution summaries.

AI output must be **advisory** unless the user explicitly confirms a mutation. The default parsing path is a deterministic local grammar; the model-backed path is a fallback for unparsed input and is opt-in, budgeted, and schema-validated before any mutation.

### 17.2 Structured AI Contract

```json
{
  "operation": "parse_task",
  "input": "Prepare Q3 report tomorrow at 2pm for 90 minutes #finance",
  "result": {
    "title": "Prepare Q3 report",
    "due_at": "2026-09-09T14:00:00-04:00",
    "estimate_minutes": 90,
    "tags": ["finance"]
  },
  "confidence": {
    "title": 0.99,
    "due_at": 0.98,
    "estimate_minutes": 0.91,
    "tags": 0.96
  },
  "requires_confirmation": false,
  "model_version": "task-parser-1"
}
```

### 17.3 AI Safety Rules

AI must **not**: delete tasks · complete tasks without confirmation · reschedule tasks without confirmation · send messages · share data externally · modify billing · execute code · change security settings · create calendar events without confirmation.

AI requests must have: per-user rate limits · per-plan quotas · maximum input size · maximum output size · provider timeout · fallback behavior · cost tracking · prompt and parser versioning · redaction of secrets and access tokens.

| Control | Value |
|---|---|
| Cost budget | $0.30/user/month soft, $0.45 hard cap, then degrade to the deterministic parser |
| Rate limit | 10 requests/minute per user |
| Max input | 2,000 characters per parse request |
| Provider timeout | 5 seconds, single retry on connection error only |
| Data sent to third parties | Explicit opt-in; per-workspace toggle; excluded fields configurable |
| Training | Contractual opt-out; customer data never used to train models |
| Local models | Roadmap item for Phase 3 desktop (on-device parsing for privacy-sensitive users) |

### 17.4 AI Failure Handling

If AI fails or times out:

- Preserve the original user input.
- Offer ordinary manual task creation.
- Do not partially apply a mutation.
- Record a non-sensitive operational failure metric.
- Avoid repeatedly retrying expensive requests without user action.

### 17.5 Voice

Voice capture is **Phase 2**. Requirements:

- Explicit microphone permission.
- Clear recording indicator.
- Local deletion of temporary audio after transcription.
- No background recording.
- User confirmation before task creation.
- Transcript editing before mutation.
- Provider disclosure where third-party transcription is used.

---

## 18. Monetization

### 18.1 Entitlement Model

Billing status is determined by verified provider webhooks and synchronized into an internal entitlement table. **The client cannot grant or extend access.**

| Capability | Free | Pro | Team | Enterprise |
|---|---|---|---|---|
| Personal tasks | Limited | Unlimited | Unlimited | Unlimited |
| Projects | Limited | Unlimited | Unlimited | Unlimited |
| Calendar connections | 1 | Multiple | Multiple | Multiple |
| Execution analytics | Basic | Advanced | Advanced | Advanced |
| Historical analytics | 30 days | Unlimited | Unlimited | Unlimited |
| Focus timer | Yes | Yes | Yes | Yes |
| Attachments | Limited | Increased | Increased | Custom |
| AI parsing | Limited | Increased | Shared quota | Custom |
| Offline sync | Yes | Yes | Yes | Yes |
| Shared workspaces | No | No | Yes | Yes |
| Comments and mentions | No | No | Yes | Yes |
| Team reporting | No | No | Yes | Yes |
| SSO and SCIM | No | No | No | Yes |
| Audit retention | Limited | Limited | Extended | Custom |
| Support | Community | Standard | Priority | Dedicated |

Exact limits must be configured server-side and exposed through an entitlement endpoint. Initial configured values (subject to the pricing validation plan in §2.11):

| Limit | Free | Pro | Team | Enterprise |
|---|---|---|---|---|
| Active tasks | 200 | Unlimited | Unlimited | Unlimited |
| Projects | 3 | Unlimited | Unlimited | Unlimited |
| Attachment storage | 100 MB | 5 GB | 10 GB/seat | Negotiated |
| Max file size | 10 MB | 100 MB | 250 MB | Negotiated |
| Calendar connections | 1 read-only | 3 two-way | 5/seat | Unlimited |
| Custom scoring rules | 0 | 10 | 25 | Unlimited |
| AI requests/month | 20 | 500 | 1,000/seat | Negotiated |
| Export | 1/day | Unlimited | Unlimited | Scheduled |
| Seats | 1 | 1 | 2–50 | Unlimited |
| Audit log retention | None | 30 days | 1 year | 7 years |

### 18.2 Subscription States

`TRIALING` · `ACTIVE` · `PAST_DUE` · `GRACE_PERIOD` · `CANCELED` · `EXPIRED` · `PAUSED`

| From | To | Trigger |
|---|---|---|
| TRIALING | ACTIVE | Successful first payment |
| TRIALING | EXPIRED | Trial ends without payment |
| ACTIVE | PAST_DUE | Payment failure |
| PAST_DUE | GRACE_PERIOD | Dunning window opens |
| GRACE_PERIOD | ACTIVE | Payment recovered |
| GRACE_PERIOD | EXPIRED | Dunning exhausted |
| ACTIVE | CANCELED | User cancels; access until period end |
| CANCELED | EXPIRED | Paid period ends |
| ACTIVE | PAUSED | Supported pause request |

### 18.3 Billing Rules

- Provider webhooks are signature-verified.
- Webhook events are idempotently processed (deduplicated on provider `event.id`).
- Entitlements are updated transactionally.
- Downgrades do not delete user data; over-limit data becomes read-only.
- Limits apply at the next billing period unless legally required otherwise.
- Failed payments enter a grace period (7 days with full access).
- Users receive warnings before access is restricted.
- Cancellation preserves access through the paid period; export remains available for 30 days.
- Billing history remains available for tax and accounting retention.
- Refunds are handled through the billing provider and reflected through webhook events; pro-rated within 14 days of first charge, case-by-case afterwards.
- Taxes are handled by the provider's tax service; VAT/GST collected where required.
- Marketplace revenue share (Phase 3): 80/20 developer/platform, documented before SDK launch.

A nightly reconciliation job compares provider subscription state against local entitlements and alerts on drift.

---

## 19. Testing And Quality Gates

### 19.1 Test Categories

| Category | Coverage | Tooling |
|---|---|---|
| Unit | Domain rules, scoring, recurrence, authorization policies | Vitest |
| Component | Forms, views, state transitions, accessibility behavior | Vitest + Testing Library |
| Integration | Database transactions, outbox, queues, object storage | Vitest + ephemeral PostgreSQL/Redis |
| Contract | API schemas and event schemas | OpenAPI + zod snapshots |
| End-to-end | Capture, planning, focus, completion, review, billing | Playwright (Chromium + WebView2) |
| Sync | Offline mutations, retries, conflicts, tombstones | Deterministic multi-device simulator |
| Calendar | OAuth, import, export, conflict resolution | Sandbox account + mocked provider |
| Security | Authentication, authorization, uploads, webhooks, rate limits | SAST, dependency and secret scanning, ASVS L2 checklist |
| Accessibility | Keyboard, screen readers, contrast, reduced motion | axe-core + manual passes |
| Performance | API latency, sync throughput, search, analytics | Lighthouse CI + API benchmarks |
| Reliability | Retry behavior, dead letters, restore, failover | k6 load tests + fault injection |

Coverage target: ≥ 85% on `packages/core`; 100% of `/v1` endpoints under contract test.

### 19.2 Required Acceptance Tests

The MVP cannot ship unless:

1. A user can create a task offline and synchronize it later.
2. Duplicate mutation delivery does not duplicate the task.
3. A task completed on one device appears completed on another.
4. Conflicting title edits do not silently destroy either version.
5. Recurring occurrences are not duplicated after worker retries.
6. Reminders are canceled after task completion.
7. Calendar disconnect removes stored OAuth credentials.
8. Billing access cannot be granted through client-side modification.
9. Deleted accounts cannot authenticate.
10. Export files expire and become inaccessible.
11. Attachment malware detection blocks unsafe downloads.
12. Analytics show `Unmeasured` when required data is missing.
13. All critical flows are keyboard accessible.
14. Database restore has been tested successfully.

### 19.3 Sync Scenario Matrix

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

### 19.4 Release Gates

A release requires:

- No unresolved critical security issues.
- No unresolved data-loss issue.
- Passing migration tests.
- Passing synchronization tests.
- Passing core end-to-end tests.
- Accessibility checks completed.
- Monitoring dashboards updated.
- Alerts tested.
- Rollback procedure verified.
- Support documentation available.
- Feature flag and kill-switch behavior verified.

| Gate | Objective criterion |
|---|---|
| Correctness | Unit, integration, E2E, and sync matrix green |
| Security | No high/critical SAST, dependency, or secret findings; ASVS L2 items verified for touched areas |
| Accessibility | No critical axe violations; keyboard path verified on changed screens |
| Performance | p95 read < 300 ms, write < 500 ms in staging load test; web vitals budget met |
| Reliability | Error budget not exhausted; alerting in place for new jobs |
| Migration safety | Backward-compatible with a tested rollback or restore plan |
| Observability | New paths emit traces, metrics, and structured logs with request IDs |
| Rollback readiness | Feature flag or documented revert within 15 minutes |

---

## 20. Analytics And Instrumentation

### 20.1 Product Events

Track: account created · first task created · first task completed · first project created · first calendar connected · first focus session started · first weekly review completed · first execution result viewed · first export requested · trial started · subscription started · subscription canceled.

### 20.2 Activation Definition

A user is activated when, within seven days, they:

- Create at least three tasks.
- Set at least one estimate.
- Complete at least one task.
- View or use the daily planning screen.
- Return on at least two separate days.

> Activation criteria must be tested against retention outcomes and revised if they do not predict meaningful product value.

### 20.3 Metrics

| Metric | Definition |
|---|---|
| Task capture latency | Time from capture UI open to saved task |
| First-value time | Time from account creation to first completed task |
| Weekly review rate | Activated users completing a review each week |
| On-time completion | Tasks completed at or before planned due time |
| Estimate accuracy | Difference between estimate and actual duration |
| Reschedule rate | Rescheduled tasks divided by planned tasks |
| Sync success | Mutations acknowledged without user intervention |
| Calendar freshness | Time since last successful sync |
| AI acceptance rate | Parsed suggestions accepted without major correction |
| Paid conversion | Trial users becoming paid |
| Gross margin | Revenue minus direct infrastructure and provider costs |
| Churn | Customers lost in a billing period |

Analytics must distinguish: personal versus team users · free versus paid users · acquisition source · platform · cohort · time zone · consent state.

> Do not collect unnecessary task content for analytics. Product telemetry is stored separately from user-facing execution analytics, and content fields are excluded by default.

---

## 21. Delivery Plan

### 21.1 Team Assumptions

Initial team:

- 1 product manager/founder.
- 1 product designer.
- 2 full-stack engineers.
- 1 desktop/client engineer.
- 1 part-time QA or automation engineer.
- 1 part-time security/SRE consultant.
- 1 part-time growth/customer-support operator.

The plan assumes a small team and prioritizes modular architecture over parallel feature development. Capacity assumption: roughly 4.5 engineering FTE, with 70% on roadmap, 20% on quality and operations, and 10% on unplanned work.

### 21.2 Twelve-Month Roadmap

| Period | Focus | Exit criteria |
|---|---|---|
| Months 1–2 | Architecture, authentication, database, task core | Tasks and accounts work in staging |
| Months 3–4 | Projects, views, recurrence, reminders | Core task workflow passes acceptance tests |
| Months 5–6 | Timers, tracking events, analytics | Explainable execution results available |
| Months 7–8 | Offline sync, Windows desktop, attachments | Cross-platform synchronization passes conflict tests |
| Month 9 | Google Calendar, billing, exports, deletion | Paid beta operational |
| Month 10 | Accessibility, performance, security hardening | Release gates pass |
| Month 11 | Private beta and user research | Retention and reliability issues prioritized |
| Month 12 | Public beta or GA decision | Go/no-go criteria satisfied |

### 21.3 Milestone Details

#### Milestone 1: Foundation

**Includes:** repository and CI · environment configuration · authentication · user and workspace models · database migrations · API conventions · error handling · logging and tracing · basic web shell.

**Deferred:** desktop client · AI · calendar · billing.

**Required instrumentation:** deploy success rate · authentication error rate · request tracing coverage.

#### Milestone 2: Core Task Management

**Includes:** quick capture · tasks · subtasks · projects · sections · tags · list and board views · due dates · estimates · archive and restore.

**Deferred:** calendar view · collaboration · custom fields.

**Required instrumentation:** capture latency · task creation success rate · task mutation error rate · active-task count.

#### Milestone 3: Planning And Execution

**Includes:** calendar view · daily planning · focus timer · manual time logging · reminders · recurrence · completion and rescheduling flows.

**Deferred:** smart scheduling · automations.

**Required instrumentation:** timer usage · reminder delivery · reschedule rate · daily planning usage · recurrence failures.

#### Milestone 4: Tracking And Analytics

**Includes:** append-only tracking events · calculation pipeline · execution results · daily analytics · weekly review · explainability interface · score controls.

**Deferred:** user-defined scoring rules · team reporting.

**Required instrumentation:** result-view rate · score correction rate · analytics engagement · unmeasured result rate.

#### Milestone 5: Cross-Platform Reliability

**Includes:** desktop application · local SQLite store · web IndexedDB store · mutation queue · sync cursors · conflict UI · tombstones · offline capture.

**Deferred:** mobile clients · multi-workspace switching.

**Required instrumentation:** sync latency · mutation retries · conflict frequency · queue depth · data-integrity checks.

#### Milestone 6: Commercial Readiness

**Includes:** Google Calendar · billing · entitlements · data export · account deletion · attachment scanning · support tools · status page · operational dashboards.

**Deferred:** Outlook and CalDAV · public API · marketplace.

**Required instrumentation:** trial conversion · billing webhook failures · calendar sync freshness · export completion · deletion completion.

### 21.4 Beta Stages

**Private alpha**

- 10 to 25 users.
- Founder-led onboarding.
- Manual support.
- Daily issue review.
- No expectation of broad reliability.

**Private beta**

- 50 to 150 users.
- At least three user segments.
- Automated crash and sync monitoring.
- Weekly research interviews and issue triage.
- Published known-issues list.
- Entry gate: no SEV-1 for two consecutive weeks in alpha.

**Public beta**

- Open signup with a paid plan available.
- SLOs measured and published internally.
- Status page live.
- Support response targets enforced.
- Entry gate: 30 days meeting SLOs; sync scenario matrix green; restore test passed.

**General availability**

- Pricing live and marketing site published.
- Penetration-test findings remediated.
- Documented runbooks and on-call rotation.
- Entry gate: clean pen test, healthy error budget, verified backup restore, go/no-go review completed.

### 21.5 Technical Spikes

| Spike | Question | Timebox |
|---|---|---|
| Sync protocol prototype | Does the mutation-queue model hold under the scenario matrix? | 2 weeks (M1) |
| Tauri + SQLite + WebView2 | Packaging, auto-update, notifications, shortcut reliability on Windows | 1 week (M5) |
| Recurrence and DST | Does the occurrence-key model survive time-zone edge cases? | 1 week (M3) |
| Calendar two-way | Duplicate and echo prevention with push channels | 1 week (M6) |
| Tracking recalculation cost | Backfill cost at 100,000 tasks | 3 days (M4) |

### 21.6 Launch Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Sync complexity slips Milestone 5 | Everything downstream slips | Spike first, cut multi-workspace, keep conflict UI minimal |
| Tracking feels punitive | Core differentiator rejected | Wellbeing controls, language review, alpha qualitative testing |
| Google Calendar verification delays | Milestone 6 slips | Start verification early; ship one-way read first |
| Windows desktop support cost | Support overload | Crash telemetry, auto-update, staged rollout |
| Low willingness to pay | No revenue | Pricing validation plan before GA |
| Key-person concentration | Delivery risk | Documentation, decision records, pairing on critical modules |

### 21.7 Go/No-Go Criteria

| Criterion | Threshold |
|---|---|
| Data integrity | Zero known data-loss defects |
| Reliability | SLOs met for 30 consecutive days |
| Security | No unresolved high or critical findings |
| Accessibility | No critical violations on core flows |
| Commercial | Billing, entitlement, refund, and deletion paths verified end to end |
| Support | Runbooks, status page, and response targets in place |
| Demand | Alpha-to-paid conversion at or above target |

---

## 22. Final Decision Register

### 22.1 Architecture Decisions

| ID | Decision | Rationale |
|---|---|---|
| AD-01 | Modular monolith with workers | Cross-domain consistency; extract later on measured need |
| AD-02 | Drizzle over Prisma | SQL-first, no query engine binary, cheaper container and desktop footprint |
| AD-03 | PostgreSQL full-text search before a search engine | Adequate at expected scale; avoids a second system of record |
| AD-04 | Mutation queue, not CRDTs, for MVP | Scalar-dominant model; CRDT cost unjustified before collaborative editing |
| AD-05 | SQLite (desktop) + IndexedDB (web) behind one repository abstraction | Shared sync logic, platform-appropriate storage |
| AD-06 | Transactional outbox for events | Guarantees event and state consistency |
| AD-07 | Redis-backed durable queue for jobs | Operational simplicity; managed queue only if throughput demands |
| AD-08 | Billing provider with webhook-driven entitlements | Never rebuild billing; integrity from server-verified events |

### 22.2 Product Decisions

| ID | Decision |
|---|---|
| PD-01 | Launch single-user; collaboration is Phase 2 |
| PD-02 | Execution tracking is the wedge; everything else supports it |
| PD-03 | Scores are explainable, correctable, and disableable |
| PD-04 | No leaderboards or cross-user comparison in MVP |
| PD-05 | Google Calendar is the only integration at launch |
| PD-06 | Deterministic parser is the default; the model path is fallback and opt-in |
| PD-07 | Windows-only desktop at launch; macOS and Linux after product-market fit |

### 22.3 Security Decisions

| ID | Decision |
|---|---|
| SD-01 | No shell commands, user scripts, or unreviewed plugins in MVP |
| SD-02 | OWASP ASVS Level 2 as the verification baseline |
| SD-03 | OAuth tokens under envelope encryption with a rotating key-encryption key |
| SD-04 | Entitlements only from verified provider webhooks |
| SD-05 | AI opt-in for third-party processing; no training on customer data |
| SD-06 | Object-level authorization on every read and write |

### 22.4 Deferred Decisions

Mobile framework · dedicated search engine choice · multi-region residency architecture · plugin sandbox technology · workspace-level end-to-end encryption scope · Team pricing model (per-seat versus flat) · analytics warehouse choice.

### 22.5 Highest-Risk Assumptions

1. Users will maintain estimates consistently enough for estimate accuracy to be meaningful.
2. Explainable execution scoring is motivating rather than discouraging.
3. Individual professionals will pay the hypothesized price for planning feedback.
4. Google Calendar alone is sufficient integration coverage at launch.
5. Offline sync can be made reliable enough to be a trust asset with the assumed team size.
6. Tracking data creates real switching cost within 90 days of use.

### 22.6 Required Experiments

| Experiment | Validates | Success signal |
|---|---|---|
| Estimate prompt A/B (required versus optional) | Assumption 1 | ≥ 60% of tasks carry an estimate |
| Score presentation test (score versus narrative only) | Assumption 2 | Higher week-4 retention in the winning arm |
| Paid alpha at list price | Assumption 3 | ≥ 25% conversion |
| Integration demand survey during beta | Assumption 4 | < 20% cite a missing integration as a blocker |
| Chaos and offline drills | Assumption 5 | Zero data-loss findings across the matrix |
| Cohort analysis of analytics users | Assumption 6 | Analytics viewers churn at less than half the rate |

### 22.7 Open Questions

- Should Free include any execution tracking history at all, or a seven-day teaser?
- Is the weekly review a page, an email, or both?
- Should calendar events be plannable objects or purely context?
- How much history should the desktop client cache offline by default?
- Do we publish a public roadmap during beta?

### 22.8 Top Ten Failure Modes

| # | Failure mode | Detection | Mitigation |
|---|---|---|---|
| 1 | Silent sync data loss | Integrity checks, client/server entity diff canary | Conflict snapshots, no destructive merges, alert on diff |
| 2 | Duplicate recurrence generation | Unique occurrence keys, duplicate metric | Idempotency keys, advisory locks |
| 3 | Reminder storm after an outage | Queue depth alert | Expiry window, dispatch rate limit |
| 4 | Calendar echo loop | Sync-origin tagging, event rate metric | Origin markers, loop breaker, backoff |
| 5 | Entitlement drift after webhook loss | Nightly reconciliation | Replay provider events, alert on mismatch |
| 6 | Tracking backfill saturates the database | Job latency and database CPU alerts | Chunked, rate-limited, off-peak backfills |
| 7 | Attachment malware served to users | Scan status gating, scanner health check | Block downloads until clean, quarantine |
| 8 | AI cost blowout | Per-user and global cost counters | Hard caps, degrade to the deterministic path |
| 9 | Desktop auto-update breaks clients | Crash telemetry, update success rate | Staged rollout, rollback channel |
| 10 | Punitive analytics drives churn | Cohort retention by analytics exposure | Wellbeing controls, language review, opt-out |

### 22.9 Recommended First Engineering Tickets

| # | Ticket | Outcome |
|---|---|---|
| 1 | Scaffold pnpm and Turborepo monorepo with `web`, `api`, `worker`, `core`, `db`, `contracts` | Buildable skeleton with CI on pull requests |
| 2 | PostgreSQL and Drizzle baseline schema: users, sessions, workspaces, projects, sections, tasks | Migrations run in CI |
| 3 | Authentication module: register, login, verify, reset, sessions, revocation, Argon2id | End-to-end authentication flow green |
| 4 | Task CRUD API with optimistic versioning and RFC 7807 errors | Contract tests pass |
| 5 | Transactional outbox and worker skeleton with an idempotency helper | One job end to end |
| 6 | Tracking event writer wired to task mutations | Append-only events with idempotency |
| 7 | Sync protocol v1: `/v1/sync/push` and `/v1/sync/pull` with cursor and tombstones | Scenario matrix SY-01 through SY-05 green |
| 8 | Web shell: Today, Inbox, quick capture, list view with optimistic updates | Core loop clickable |
| 9 | Deterministic natural-language parser package with confidence scores | Parser unit suite green |
| 10 | Observability baseline: OpenTelemetry traces, request IDs, structured logs, health checks | Dashboards and alerts live |

---

## Appendix A — Glossary

| Term | Definition |
|---|---|
| Occurrence | A single generated instance of a recurring task |
| Execution result | A calculated, explainable outcome record for a task or occurrence |
| Unmeasured | A component excluded from scoring due to insufficient data |
| Mutation | A client-originated change submitted through the sync protocol |
| Tombstone | A record marking an entity as deleted for synchronization purposes |
| Entitlement | A server-side capability grant derived from billing state |
| Outbox | A table written in the same transaction as a domain change, later published as events |
| Wedge | The narrow initial advantage the product competes on |

## Appendix B — Document Control

| Item | Value |
|---|---|
| Owner | Product (founder) |
| Reviewers | Engineering, Security, SRE, Design |
| Review cadence | Per milestone |
| Change process | Pull request against `docs/PRD.md` with a decision-register update |
