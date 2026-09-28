# Pre-launch correctness closure

28 September 2026. Baseline: `7a530e13e3945e58a1f65b2423451f3ea7c99fd2`.
This is the current core personal-web release boundary, following the Post-M8-i8 audit. Earlier milestone counts and future-work lists are historical snapshots. Implementation and acceptance evidence below supersede them without rewriting their history.

## Scope and decisions

- Task reminders navigate to `/notifications?taskId=...`, render the existing filtered reminder history, retain archived read-only behavior and reject deleted/foreign tasks.
- Knowledge relations preserve historical rows when targets or parents become unavailable. No permanent-delete or account-purge semantics change.
- PRD §18.1 continues to apply to Insights. PC6 has no history entitlement exemption. Free queries may start on today or any of the preceding 30 workspace-local dates (the existing inclusive cutoff); paid plans retain unlimited historical age, subject to report-size limits. Complete requested periods are accepted or rejected, never silently clipped. Standard/custom reports and CSV/JSON exports share the same service. Actual comparison periods receive the same check; disabled/ineligible comparisons do not query history. An out-of-policy query returns `ENTITLEMENT_LIMIT_REACHED` / HTTP 402 and no report/download.
- Task EMAIL is unsupported, even when SMTP is configured. Authentication/account email and Tracker monthly email remain separate. No task email implementation is included.
- User decision: **withhold Google from the first public release**. Native and ICS Calendar remain in scope. `GOOGLE_CALENDAR_ENABLED` defaults to `false`; credentials alone cannot activate Google. Leave it false in first-release deployments. Google connection actions, sync/provider construction, conflict resolution, worker provider I/O and webhook ingestion are gated. Owned retained data and local disconnect remain available through existing APIs; no historical data is erased by the gate.
- `GOOGLE_CALENDAR_ENABLED=true` is reserved for isolated development/acceptance of the separate provider track. Browser fixtures explicitly set it to exercise existing normalized integration tests, without real credentials. Those fixtures do not qualify Google for production. F3's lookup, incremental sync, token/410 handling, watch units/identity, header/secret verification, 412 reconciliation and revocation fixes remain outstanding, followed by live provider acceptance.

## Lifecycle policy

| State | Discovery/selector | Existing relation | Direct owned detail | Backlinks |
|---|---|---|---|---|
| Active target and active parents/source | Selectable and searchable | Original label and actionable destination | Normal workflow | Active origins shown |
| Existing target with archived parent/database/source, deleted parent, or non-ACTIVE Google connection | Hidden from active discovery | Retained, unavailable label, no navigation target | Owned Knowledge content retained for review/recovery; editing disabled while parent unavailable; Calendar keeps its existing unavailable response | Origins under unavailable parents hidden |
| Soft-deleted target | Hidden | Retained unavailable reference | Existing module recovery policy | Deleted origins hidden |
| Restored parent/source/connection | Returns to active discovery if target itself is live | Original identity and destination return | Normal allowed operations resume | Eligible origins return |
| Permanently removed target/account | Existing FK/purge behavior | Existing deletion semantics | Not found | Existing deletion semantics |

Google mirror history is retained independently from whether a provider connection is currently actionable. Connection ACTIVE status is necessary for mirror selection; possession of a stored event ID does not make a suspended/disconnected connection actionable. Workspace ownership remains enforced. Native event source ownership and archive rules are preserved. Explicit archived-database/recovery browsing is distinct from active shared search and relation selection.

## Offline capability contract

| Surface | Contract |
|---|---|
| Capture | Supported capture can queue and synchronize later |
| Today | Previously cached read; cache freshness is not a live server guarantee |
| Focus/time | Supported timer, manual-time and Focus completion commands queue with existing replay identities |
| Task editor/lifecycle, ordinary task-list mutations and relationships | Require connection; no automatic queue. Editor draft stays only while editor remains open; failed requests do not claim saved state |
| Home | Online aggregate; capture follows its own supported queue. Other widgets/quick notes require connection |
| Goals, Trackers, Knowledge, Calendar, Insights, Settings | Online reads/mutations; do not imply offline editing from server sync records |
| Sync | Reconciles only supported queued commands; conflict review remains explicit |
| Service worker/cold start | Push worker only; no guaranteed offline HTML/app-shell launch or background sync |

The shared API client reports `Requires connection` before an unsupported offline request and explicitly says it was not saved or queued. Supported queues remain unchanged. The global offline indicator describes cached/supported operations and the connection requirement for other modules. Task editing, Knowledge and Insights provide scoped capability wording.

## Virtualized focus race

The pagination helper scrolled to the top and immediately resolved `.first()` among *currently mounted* rows. Browser scroll dispatch and React viewport reconciliation are asynchronous, so that locator could still select a lower task. Wait for the original first task to be the first rendered row before focusing; retain the exact task-ID assertion, focused-control assertion, off-window pinning, bounded row count and axe checks. No sleep, skipped assertion or higher retry budget is introduced.

CI now runs this scenario ten times with zero retries, followed by the full browser suite with zero retries. The repeated probe is a distinct gate, not replacement coverage.

## Release check enforcement — administrator action remains required

At the audit baseline, live GitHub main reported no protection and the rulesets list was empty. Repository code cannot establish a remote protection policy. No setting change is claimed here.

The existing `Quality and integrity` workflow has the `verify` job. Require its exact GitHub status-check context (`verify`, verify the displayed context on a current run) before merging/releasing to main. It covers frozen install, deterministic secret/static scan, dependency audit, migration apply/replay, lint, all-package type checks, coverage, production build, real ClamAV/EICAR, logical backup/restore, repeated focus acceptance and complete first-attempt browser acceptance. Do not replace this with a subset of targeted tests.

Administrator checklist: protect main or add an enforced ruleset; require the current `verify` check; require the intended pull-request review policy and up-to-date merge validation; disallow force pushes/deletion; review and document any administrator/automation bypass. Capture live settings and a rejected noncompliant-change example. Platform secret push protection is a separate setting. Do not claim any of these are enabled until verified.

## Validation evidence

Final exact-commit CI and counts are recorded in the delivery report. Targeted implementation runs are not sufficient for milestone completion. Full unit/integration coverage, lint/types/build/security/dependency/migration checks, complete first-attempt browser acceptance, the repeated focus probe and hosted restore/malware gates must pass. Initial fixture-construction failures are reported separately from final first-attempt results.

## Remaining release gates

This milestone does not deploy infrastructure. Trusted ingress/forwarded headers, distributed rate limits and request budgets, production TLS/DB TLS, managed secrets/rotation, password/session policy, durable file/export storage and scanner operations, encrypted backups/PITR/byte restore, measured RTO/RPO, rollback rehearsal, monitoring/alerts/on-call/SLO evidence, independent assessment and enabled mail/push/billing acceptance remain external release gates. Google remains a separate withheld track. No advanced feature milestone or deployment acceptance is started automatically.
