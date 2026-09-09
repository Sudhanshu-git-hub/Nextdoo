# Reminder lifecycle and durable in-app notifications

Date: 2026-09-09 (Asia/Calcutta). **Verified online milestone, not completion of the entire notification PRD or Phase 1.** Latest authorization covers remaining non-AI/non-billing online MVP work, while excluding AI, billing integration, desktop and full offline mode.

## Why this milestone came first

Review against PRD §6.6, §12.4 and the current ledger found a missing user-facing delivery workflow and concrete integrity problems:

- A valid 500-character task title exceeded the notification column's 300-character limit. One failing insert rolled back the entire dispatch batch, blocking unrelated recipients.
- Reminder lifecycle helpers lacked workspace scoping on cancel/snooze, could rearm completed work, and reused a delivered reminder's identity when snoozing.
- Dispatch did not validate recipient/workspace/task consistency or suppress pending-deletion recipients.
- Failures lacked a bounded per-reminder retry state. Exhausted legacy processing claims could be rearmed repeatedly.
- Notifications were durable database rows but had no usable center/read workflow; reminder status history was absent.

Malformed legacy references are a defense-in-depth/data-integrity concern; this report does not claim an externally exploitable cross-tenant HTTP path was demonstrated. New authenticated routes were tested against tenant, ownership and version boundaries before closure.

## Functional scope delivered

**Notifications** is now available in navigation. Task rows link to their **Reminders** page. Users can:

- Schedule absolute reminders or reminders relative to a task's due date, with active-task and optional task-version validation.
- See delivery status, attempt count, structured failure reason, next retry and replaced-reminder history.
- Snooze an eligible reminder for ten minutes through the UI (API: 1 minute–7 days), creating a **new absolute delivery identity**. Original sent history remains sent; pending/failed sources are canceled and linked to the replacement. No source can create multiple snooze children.
- Cancel pending/failed reminders, with version conflicts requiring review. Delivered notifications cannot be recalled.
- Browse durable notifications, mark them read idempotently and open the associated task.
- Browse 50-item cursor pages of notifications and reminder history; failed continuation retains loaded records. Explicit refresh and successful mutations reload the first page. Failed creation retains input and its unchanged request identity while the view remains mounted.

Relative pending reminders follow due-date edits; snoozed absolute reminders do not. Task completion/archive/skip/deletion still cancels pending reminders atomically. These automatic transitions now advance reminder versions so stale commands cannot overwrite them. Deleted/unavailable task titles are not exposed through the notification center, and deleted task rows do not offer a broken Reminders link.

The UI explicitly states: **WEB / SENT means stored in this in-app center, not successful browser/desktop push or email delivery.** Users refresh to retrieve deliveries. No native notification permission, automatic background push or provider acknowledgement is fabricated. External reminder channels are rejected by creation while disabled; legacy external requests fail honestly with `DELIVERY_PROVIDER_NOT_CONFIGURED`.

## Architecture and durable-job behavior

The independently deployable worker continues using the shared DB dispatcher; it does not import web-process services. Every 30-second pass selects at most 100 eligible reminders. Each reminder has its own transaction, workspace serialization, recipient/task validation, task/reminder row locks and version recheck. Its notification, final status and content-free audit commit together. A poison record cannot roll back another recipient's delivery.

Database statement timeout is 10 seconds and lock timeout 5 seconds, applied inside each delivery transaction. Neither is a whole-transaction or total-batch deadline/SLA. Failures roll back effects, then record a generic failure code using version/attempt CAS. The budget is three dispatch attempts, with automatic retry delays of one and two minutes; exhausted requests become `FAILED`. Structured worker warnings expose retrying/failed counts. Stale legacy processing claims with an exhausted budget become failed instead of cycling forever. Scheduling a reviewed snooze supplies a new identity and budget without rewriting the failed history.

Eligibility uses PostgreSQL's full-precision clock. The first full validation exposed that a newly committed microsecond checkpoint could be later than JavaScript's truncated millisecond time; this was fixed rather than adding sleeps or relaxing assertions.

Migration **0012** is additive: retry checkpoint, replacement link, nullable notification/reminder identity, unique delivery index, history indexes, and notification title capacity aligned with task titles. Existing notifications are not assigned invented source IDs. ORM and migration indexes match. The unique notification/reminder identity complements transactional acknowledgement; retries cannot generate a second durable notification for the same reminder.

## Compatible API surface

- Existing `GET /api/v1/reminders` retains its bounded due-list behavior, now scoped to the authenticated workspace.
- `GET /api/v1/reminders?history=true` and `?taskId=:id` provide status history using existing `data` / `pagination.next_cursor` / `pagination.has_more` conventions.
- Existing `POST /api/v1/reminders` gains optional `taskVersion`, strict validation and atomic audit.
- `POST /api/v1/reminders/:id/snooze`: required reminder `version` and `minutes`.
- `POST /api/v1/reminders/:id/cancel`: required reminder `version`.
- `GET /api/v1/notifications`: scoped, paginated durable history.
- `POST /api/v1/notifications/:id/read`: monotonic, idempotent read acknowledgement.

Mutations retain origin, authentication, idempotency-key, rate-limit and problem-details conventions. History cursors bind the user/workspace/filter and preserve PostgreSQL microsecond ordering. Foreign resource IDs and cursor reuse do not disclose another tenant's content.

## Export/deletion verification

The existing credential-free JSON export already includes notifications and reminders; no hosted-expiry claim is made. A new regression exposed that legacy malformed notification snapshots could leak foreign task content into an export. Export now excludes foreign-workspace notifications and redacts invalid cross-task title/body/reference data while retaining valid notification/read state. The precise export regression failed before the fix.

A real-DB purge test proves that linked reminders, notification identities and read state cascade away with the account. Delivery is suppressed during pending deletion. Existing account-authentication, grace, reauthentication, purge and entitlement tests remain green. This does not establish production backup retention or finish the asynchronous export milestone.

## Acceptance evidence and failures resolved

- Initial reminder regression suite: **5 failed** before implementation. The shared poison-batch defect also affected later cases in that first run.
- API-before-UI browser run: **1 HTTP scenario passed / 1 UI scenario failed**, demonstrating that routes alone were not treated as completion.
- First full validation found two retry-eligibility failures caused by timestamp precision; final validation includes the DB-clock fix and unchanged acceptance assertions.
- A held-initial-fetch browser regression also failed before refresh cancellation was corrected, then passed in the final full run.
- A separate export regression: **1 failed / 8 passed**, then all passed after scoped/redacted export handling.
- Additional coverage verifies exact expiry boundary, completion/dispatch serialization, full-length titles, concurrent dispatch, three-attempt failure isolation, stale legacy recovery, scope denial, snooze rollback, microsecond pagination, read idempotency and account purge.
- Five dedicated browser/API scenarios verify real shared-worker dispatch followed by visible delivery/read/snooze/cancel, replay/version/tenant/channel guards, lost creation acknowledgement failed continuation to all 55 records, and a held initial fetch followed by scheduling (the post-commit refresh replaces the stale request). Keyboard snooze and targeted Axe WCAG 2/2.1/2.2 AA checks pass. This is not whole-product accessibility certification.

Final **`pnpm verify` passed: 405 unit/integration/tooling tests in 44 files, 69 browser/API scenarios**, lint, all package typechecks, production build and coverage. Core coverage: 97.51% statements / 88.13% branches / 98.50% functions / 100% lines. Frozen-lockfile install, migration replay and `git diff --check` pass. Dependency audit: **zero findings across all severities**.

Local evidence is under `/home/user/nextdoo-notifications/`: `red.log`, `browser-red.log`, `verify-first.log`, `export-red.log`, `export-green.log`, `verify-closure.log`, `refresh-red.log`, `migration-replay.log`, `audit.json`. Logs and browser artifacts are not committed. Successful real SMTP/native-push delivery is not claimed.

## Remaining acceptance — explicitly open

Browser/background push, desktop notifications, enabled reminder email delivery, automatic connected-client refresh, production notification SLO/alert routing and load qualification remain open. Tracking's general outbox consumer is still absent; unrelated events remain unpublished rather than falsely acknowledged. Durable tracking evaluation/freshness is the next dependency, followed by analytics policy/controls and remaining export/deletion/entitlement/authorization and task-management work. Storage/provider decisions and real integration resources remain necessary for hosted expiring exports and external delivery.

See [PHASE1_COMPLETION_PLAN.md](PHASE1_COMPLETION_PLAN.md). No AI, billing integration, desktop or full offline feature was started.
