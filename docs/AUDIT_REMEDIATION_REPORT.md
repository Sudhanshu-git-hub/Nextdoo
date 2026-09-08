# Remaining-audit remediation — final report

**2026-09-08 · branch `arena/01a080d5-nextdoo`**  
Phase baseline: accepted repair report `5e4cbd5`. Final implementation: `e6c5357`.

## Decision and stop point

**The authorized remediation pass is complete; the product is NOT approved for production.** Confirmed high-priority existing-path defects were repaired incrementally, with permanent regressions and full validation. Remaining requirements and release blockers are explicitly retained below. This is not a claim that every audit finding or PRD milestone is closed.

No recovered-branch changes, resets, rebases, amended commits, force-pushes, push or PR were performed. No AI, billing-provider, Google Calendar, desktop, attachment or other next product milestone was begun. **Stop here; further product development requires approval.**

Sources: the original 293-line `NEXTDOO_BASELINE_AUDIT.md` in `/home/user/nextdoo-audit/`; accepted `REPAIR_REPORT.md`; committed remediation plan/log; current executable paths/tests; authoritative `docs/PRD.md`. Its SHA-256 matches the checked-out `origin/main` PRD: `0a1ebd90a31eb88f437352959209251046183c18142599f39918200401019c34`. This is not a claim of a new remote-main fetch or remote CI run.

## A. Every previously open finding — disposition

Classification legend, used throughout this report:

- **S — RELEASE-BLOCKING SECURITY/PRIVACY**
- **D — RELEASE-BLOCKING DATA INTEGRITY/CORRECTNESS**
- **M — IMPORTANT MVP FUNCTIONAL GAP**
- **L — NON-BLOCKING / LATER ENHANCEMENT**

“Repaired” refers to the named defect and tested boundary, not the whole corresponding feature.

| Original finding / entry residual | Class | Final disposition |
|---|---|---|
| F01 cross-tenant sync disclosure | S | Prior repair retained and regressions green. No reopening of foreign entity/mutation replay access. |
| F02 atomic HTTP idempotency; incomplete endpoint opt-in | D | Prior transaction/request-identity repair retained. Added task PATCH/DELETE, timer start/update and reminder create opt-in; client preserves supplied keys in every HeadersInit form. Credential endpoints are not blindly replayed through a plaintext response ledger; sync has its own mutation identity. Comprehensive §14 contract certification remains open. |
| F03 commit-ordered cursor; migration races/drift; global serialization | D | Cursor repair retained. Migration runner now locks before inspecting the ledger, verifies applied SHA-256 sources and rejects missing/changed history. Legacy bootstrap uses a trusted manifest. Production throughput and restore/rollback qualification remain open. |
| F04 sync/domain parity, rejected content and merge coverage | D / M | Prior lifecycle/quota/scoring/reminder parity retained. Rejected/conflicted replay stays rejected, and scoped local queue records survive server rejection. Full client pull/convergence, recovery UI, non-task sync, malformed-batch breadth and complete §19.3 coverage remain open. |
| F05 unsafe relationships; remaining role/resource authorization | S / D | Prior same-workspace relationship guards retained. Newly reproduced guest-membership access/export disclosure fixed: personal workspace access requires OWNER membership **and actual ownership**. Resource IDs fail validation rather than SQL errors. Project quota checks serialize with creates. Broader future resource groups still need authorization tests before activation. |
| F06 purge/history; expired-deletion authentication/cancellation; candidate handling | S / D | Shared history-aware purge retained. Expired-grace accounts cannot authenticate/cancel ahead of worker cleanup; security changes serialize with account state. Eligible candidates are selected and per-account failures isolated. Optional notification failure cannot roll back deletion. Backup/object/legal-hold retention is not solved by database cascade. |
| F07 unscoped cache/queue, random ordering, unsafe retries/deletion | S / D | Displayed cache fix retained. Queue now scopes workspaces, preserves legacy unscoped records without guessing ownership, uses FIFO/entity-head blocking, durable transaction completion and bounded error classification/backoff. Rejected raw content is retained. |
| F07 missing offline product | M / D | **Open:** capture/edit still do not enqueue; no offline shell/local-parser loop, complete pull/reconcile/conflict/legacy recovery UI, desktop repository or 5,000-mutation/skew/restart qualification. Safer helpers are not permission to enable offline mode. |
| F08 false SMTP success and leaked links | S / D | Real encrypted durable auth-mail queue and Nodemailer adapter implemented. Local TCP SMTP acceptance/recovery/failure tested. Production missing-provider behavior is explicit and reset requests do not enumerate accounts through that failure. Production sender/domain/TLS/inbox acceptance remains unverified. |
| F08 false reminder/outbox acknowledgements and unsafe worker shutdown | D / M | WEB SENT now commits with one durable in-app notification; inactive tasks cancel and unsupported external channels fail. Web and worker dispatch share implementation. Unhandled outbox events stay unpublished. SMTP leases/retries/expiry and graceful drain tested. General consumers, external reminder providers, inbox UX, replay/DLQ operations and full durable scheduling remain incomplete. |
| F09 focus clock mismatch | D | Prior server-clock/UI repair retained; real browser pause/resume/stop remains green. |
| F10 timer concurrency, canonicalization, version/sync, rounding and history | D | Prior serialization/terminal-state protections retained. Repeated sub-minute work now accumulates exactly; manual annotations persist. Task versions/sync/scoring use precise totals. Historical missing pause/fractional data and full clock-skew/offline timer contracts remain unqualified; no fabricated reconciliation. |
| F11 stale/lost scores, recurrence denominator, provenance | D / M | Prior active-history/denominator repairs retained. New results store immutable input snapshots instead of hash-only evidence. Legacy snapshots remain NULL rather than invented. Complete source-event reconstruction/UI, corrections/backfills and wellbeing controls remain open. |
| F12 silently dropped recurrence and parsed organization fields | D / M | Recurrence refusal retained. Two new browser regressions fixed silent loss of `#tag`/`+project`: unsupported saving now errors explicitly and retains original input, with honest help text. Persistence/generation/occurrence and organization workflows remain absent, not marked implemented. |
| F13 paid-period/grace errors; quota races; real billing | D / M | Prior paid-period/grace/task-cap fixes retained; concurrent project creates now respect the Free cap of three. Stripe lifecycle/reconciliation and other planned entitlements remain absent. No billing work started. |
| F14 reset TTL/atomicity, MFA rotation, browser origin/headers/logging, backoff | S | Confirmed defects repaired: ≤30-minute reset, atomic single use/credential changes, session revocation/rotation, serialized MFA transitions, origin/Fetch-Metadata controls, removal of wildcard action origins, nonce CSP/HSTS and production redaction, durable account/IP backoff. Expired throttle records are cleaned in bounded batches. |
| F14 broader authentication/security requirements | S | **Open:** breached-password checking, managed secrets and key rotation, trusted production proxy/TLS configuration, broader distributed abuse controls and ASVS/security qualification. Login/export limits are durable; other route throttles still use process memory. |
| F15 incomplete/unthrottled export | S / M | Export selects owned workspaces under a repeatable-read snapshot, includes account-level audit/preferences and existing recurrence/dependency/correction/notification data, plus non-secret session/device metadata. Authenticated per-account quota, no-store and request IDs added. It is not a complete future-provider/object archive or expiring asynchronous CSV/JSON export. |
| F15 UTC/trailing summaries, source history, missing controls | D / M | **Open:** current UTC/trailing periods do not implement full workspace-local/calendar-week reporting; event lists remain bounded, with no complete reconstruction/rollups/trends, independent score/streak opt-outs, corrections or review workflow. No broad analytics rewrite was attempted. |
| F15 deletion/audit/security/billing retention conflicts | S | **Open policy/operations blocker:** distinguish internal security evidence from plan-visible history; approve legal holds, billing retention, backup/object purge/anonymization and recovery behavior. No destructive policy was invented. |

### Unnumbered findings from the original audit

| Finding group | Class | Final disposition |
|---|---|---|
| No-op lint, skipped DB tests, broken E2E/coverage/generator, dependency advisories | D / S | Prior real gates retained; current full verification and audits pass. Mandatory DB tests do not silently skip. SQL scaffolder still intentionally does not infer schema changes. |
| UTF-8/test-environment mismatch | D | Local fresh databases are UTF-8, PG18.4. PG16/standard browser remote CI is configured but not executed; no production equivalence asserted. |
| API path/casing/IDs/aliases, missing groups and contract coverage | D / M | Malformed resource IDs, ignored tag filter and string boolean parsing fixed; health/export now include request IDs. `/api/v1`, camelCase and current aliases remain. No route-count ratio is presented as coverage; compatibility must be settled before expansion. |
| Delete/restore version and state contracts | D | Retention/cap/lifecycle repairs retained. New qualification proves monotonic versions and stale PATCH rejection across delete/restore. PRD explicitly mandates PATCH CAS and delete-wins; no incompatible DELETE CAS policy was silently added. |
| Due-date PATCH/reschedule intent and relative reminders | D | Prior repair retained and tests green. |
| Archived-project relationships | D / M | Existing reference guard rejects inactive/deleted projects. Full project archive/restore lifecycle and associated UI/constraint policy remain unimplemented. |
| SQL/Drizzle parent FK, FTS/partial indexes, configuration/rollups | D / M | SQL remains authoritative. Active-result uniqueness and new tables/columns are represented; baseline SQL-specific FK/trigger/index differences still mean a generated schema is not equivalent. Do not deploy schema push as a replacement for tested migrations. |
| Mutable current snapshots, 200-event history cap, missing calculation stream | D / M | New input snapshots improve reproducibility; full immutable source-stream provenance and historical reconstruction still open. |
| Task editor/rich notes, subtasks/dependencies/location/custom fields, boards/sections/tags | M; configurable custom fields L | Still incomplete. Existing relation/isolation guarantees must be preserved; no broad task-management implementation. |
| Filters/bulk/pagination and 24-hour cursor expiry | M / D | Tag filter works. UI continuation cursors are still discarded (task/focus list caps); advanced saved filters/bulk and cursor lifetime semantics remain incomplete. |
| Mobile navigation, optimistic-update claims, full shortcuts and accessibility | M; release a11y gate D | No responsive navigation rewrite or full optimistic repository added. Tested keyboard flows pass; no axe/screen-reader/full WCAG certification. |
| Calendar day/month/capacity/context, workspace workday/week-start settings | M | Still incomplete; separate from the existing weekly task grid. |
| Google Calendar, attachments/scanning, Windows distribution | M; token/download/signing safety S | Not implemented end to end. OAuth/disconnect, malware clean-only download, storage deletion, secure desktop update and provider gates remain release blockers for those surfaces. No fake adapters added. |
| AI beyond deterministic parser; commercial integrations | M | Still absent and explicitly outside this pass. No model, Stripe or calendar integration started. |
| Consent-aware product events/activation/cohorts and user-review choices | M | Not implemented. Operational logging and personal analytics are not the §20 product-telemetry pipeline. Decisions listed in C. |
| Packaging/deployment, managed PG/Redis/S3, secrets/IAM/TLS, PITR and rollback | S / D | Still unqualified. PostgreSQL-backed mail durability is not implementation of the entire prescribed deployment/job stack. Containers/staging release procedure and actual recovery evidence remain required. |
| OTel/traces, dashboards, job-lag/SLO metrics, alerts/on-call/status/support, kill switches | D / M | Structured logs/blocked reasons are improved; full operational readiness and measured SLO windows remain absent. |
| Contract/component/a11y/load/fault/security suites; beta/GA evidence | S / D / M | Selected regressions/E2E added, not exhaustive certification. No k6/Lighthouse/axe/SAST/secret-scan/ASVS/restore or sustained alpha/beta acceptance claim. |
| README/development overstatements, feature map and runbooks | M | Current README/development guide corrected; this report supplies the supported/unsupported map and migration/mail caveats. Comprehensive API/incident/support documentation remains future work. Historical reports/logs are intentionally not rewritten as if later repairs existed earlier. |
| Teams/comments, social auth/passkeys, native mobile, voice, advanced rules/scheduling, Outlook/CalDAV, plugins/marketplace, enterprise | L | P2/P3 or later enhancements, not begun. |


**Missing API/UX groups carried forward explicitly:** `/me`; individual session
listing/revocation and logout-all; workspace/workday settings; task bulk/history;
project detail/edit/archive/restore/analytics; section/tag CRUD/reordering; tracking
event query/corrections/recalculation; manual time and timer correction; reminder
update/snooze/cancel/history; notifications/inbox; Calendar; attachments; AI
suggestions; billing; asynchronous exports; and complete entitlement endpoints.
Internal helpers or exported session metadata do not satisfy those user workflows.
Global capture outside Today/Inbox, project-task navigation, richer error/loading
and optimistic-update behavior, personal preferences and comprehensive keyboard
shortcuts also remain part of the unfinished online UX.

## B. What was fixed in this phase

| Commit | Verified milestone |
|---|---|
| `fc90632` | Atomic account-security operations, sessions, expiry, browser boundaries, production logging and durable login backoff |
| `defd0b4` | Workspace-scoped durable offline queue, FIFO/backoff and rejection preservation |
| `a4bac82` | Honest in-app/outbox acknowledgement, encrypted leased SMTP delivery, real transport tests and worker drain |
| `2fcd9af` | Actual ownership/export boundaries, complete current-data snapshot additions, project cap race, filters and remaining write contracts |
| `a560ac2` | Serialized/checksummed migrations with trusted legacy bootstrap |
| `01b9c30` | Exact duration remainder, manual notes, new score input snapshots, expiry/quota cleanup and request identity hardening |
| `e6c5357` | Explicit tag/project capture refusal without losing input |

Every completed code milestone was committed after a full green verification and a clean working tree. Documentation finalization follows these commits. Recovered architecture remains the Next modular monolith with shared contracts/core/DB and the existing worker. No wholesale backend, client repository or schema replacement occurred.

## C. Still open — why and prerequisites

### Release-blocking security/privacy

1. **Production authentication qualification:** breached-password source/checking; account/session/MFA threat review; non-login distributed abuse limits; production proxy/origin/TLS behavior; ASVS L2 plus SAST/secret scanning. These need explicit provider/operational evidence beyond local tests.
2. **Secrets/provider operations:** provision high-entropy managed keys, least-privilege DB roles, sender/domain authentication, key rotation/recovery, production SMTP delivery and monitoring. Rotation of AUTH_SECRET affects encrypted MFA/mail payloads; a key-ring/re-encryption strategy is not implemented.
3. **Deletion and retention policy:** original PRD conflicts distinguish personal audit visibility, Free/Pro history and internal security retention. Approve retention/anonymization/legal holds and backup/object handling before production purge certification. In-grace login recovery remains existing behavior; after-grace recovery is denied. Further explicit restore UX/policy is a product decision.
4. **Absent privileged integration surfaces:** Calendar tokens/disconnect, storage/quarantine/download and desktop credentials/update signing cannot pass their security gates before implementation. Their absence must not be presented as successful acceptance.

### Release-blocking data integrity/correctness

1. **End-to-end offline recovery/convergence:** current UI never enqueues core mutations; complete pull/conflict/recovery paths, raw-content retention policy, malformed batch breadth, clock skew and 5,000-event drain/restart tests remain. Safer dormant helpers are not a completed offline feature.
2. **General asynchronous execution:** no actual general outbox consumers, full scheduler/replay/DLQ operations or bounded-failure/load qualification. Unhandled events deliberately stay pending. SMTP is **at-least-once**: accepted mail followed by crash before ledger update can duplicate; a stable Message-ID does not guarantee provider deduplication.
3. **Historical timer/scoring integrity:** legacy missing pause/fractional inputs cannot be safely invented. Current timer transitions serialize, but complete optimistic timer-version/offline skew contracts and legacy reconciliation are not certified. New score snapshots are not full historical event reconstruction.
4. **Reporting and contracts:** UTC/trailing summaries, full period semantics, pagination/cursor expiry, input-stream provenance and comprehensive API compatibility tests still need coordinated API/UI work. No silently breaking period/casing/path changes were introduced as an analytics rewrite.
5. **Release/recovery performance:** global sync/workspace/account locking favors correctness; production throughput, fault/backlog fairness, mixed-version deployment, PG16 CI, rollback/restore/PITR and measured SLOs remain unverified.

### Important MVP gaps and unresolved decisions

The full online organization/recurrence/reminder/manual-time/settings workflow, reporting/corrections/wellbeing controls, offline client, Windows client, integrations, expiring CSV/JSON exports, accessibility/support and consent-aware measurement remain incomplete. Those are deliberate scope boundaries, not feature acceptance.

Carry forward every decision from the original audit: `/api/v1` versus `/v1`, casing/aliases and colocated versus separate API deployment; conflicting activation definitions (§2.14/§20.2); security-retention versus plan-visible-history policies; TR-03 example preconditions (0.80 versus 0.65 available weight); weekly review page/email and external-calendar planning context; deletion recovery UX; desktop history extent and provider/region/signing choices; and P2/P3 public API phase inconsistency. None was silently decided through code or destructive cleanup.

## D. Regressions and actual PRD behavior

**233 → 278 tests: 45 additions. 5 → 11 E2E/API scenarios: 6 additions.** Previous assertions and isolation guarantees remain. Fixture mistakes were corrected, not accepted as proof: delivery fixtures were made eligible for batch selection/module configuration; project-cap fixture was corrected to three and rerun against pre-fix source; the capture alert locator excludes Next's unrelated announcer. See `AUDIT_REMEDIATION_LOG.md` for RED/GREEN evidence.

| New permanent coverage | Cases |
|---|---:|
| Account-security DB regressions | 10 |
| Fake IndexedDB FIFO/isolation/retry/transaction tests + sync rejection DB regressions | 6 + 2 |
| Delivery integrity, notification-failure isolation, real TCP SMTP/disabled-provider/housekeeping, pool drain | 5 + 2 + 5 + 1 |
| Owner/export/project quota/filter boundaries | 5 |
| Concurrent migration and changed-source rejection | 2 |
| Duration/annotation, input snapshots, delete/restore version qualification, HeadersInit identity | 2 + 1 + 1 + 3 |
| **Total new non-E2E tests** | **45** |

New E2E coverage: durable account login backoff; rendered security headers plus health request ID; actual timer HTTP replay/malformed ID; export quota/headers; separate tag/project intent-preservation browser cases. The complete suite has **nine browser scenarios and two real HTTP API scenarios**. Account provisioning/data persistence is real; the inherited cache test deliberately aborts task requests to exercise network-failure fallback. No provider inbox or inaccessible feature is mocked into an acceptance pass.

### PRD §19.2 acceptance disposition

| Gate | Result after remediation |
|---|---|
| 1 Offline create → sync | **Open:** core UI does not enqueue. |
| 2 Duplicate mutations do not duplicate tasks | **Bounded server pass:** atomic HTTP/sync identity and concurrency tests; not full client/platform certification. |
| 3 Completion appears on other device | **Open:** server delta tested, client reconciliation incomplete. |
| 4 Conflicting text retains both versions | **Bounded storage/queue pass; UI open.** |
| 5 Recurring retries do not duplicate occurrences | **Not implemented end to end.** Unsupported capture errors honestly. |
| 6 Completion cancels reminders | **Pass on tested HTTP/sync/dispatch-race paths.** External reminder delivery remains absent. |
| 7 Calendar disconnect removes tokens | **Not implemented.** |
| 8 Client cannot grant billing access | **Local server limit/state guards pass; actual billing acceptance open.** |
| 9 Deleted accounts cannot authenticate | **Pass on tested status/grace/purge paths**, including expired grace before worker. |
| 10 Export files expire | **Not implemented:** synchronous authenticated download has no hosted object to expire. |
| 11 Malware blocks downloads | **Not implemented.** |
| 12 Missing inputs show Unmeasured | **Bounded math/pipeline pass; score opt-out/corrections remain open.** |
| 13 Keyboard-accessible critical flows | **Selected browser paths pass; full WCAG/axe/screen-reader gate unverified.** |
| 14 Database restore tested | **Unverified.** Fresh migrations are not a restore drill. |

TR-01/02 and general available-component math are tested; TR-03's example ambiguity remains. TR-04 has stronger concurrent/reprocessing evidence; TR-05 correction/backfill and TR-07 opt-outs remain absent. TR-06 denominator repair remains green. SY-02/03/06/07/09 have bounded server/queue evidence; SY-01/04/05/08/10 and the full cross-device matrix are not accepted. None of the six complete PRD delivery milestones is declared finished.

## E. Final validation

Fresh disposable database: `nextdoo_remediation_final_20260908`, **PostgreSQL 18.4 / UTF-8**. Real Chromium **149** through the executable override; standard browser download previously failed with ECONNRESET. No browser-security disabling.

| Gate | Final result |
|---|---|
| Frozen install | PASS |
| Fresh migrations 0000–0009 | PASS; replay “Already up to date” |
| Lint | PASS, zero warnings |
| Typecheck | PASS, all five packages |
| Tests/coverage | **278/278, 29 files, no skipped tests** |
| DB-free pure core/tooling subset | **157/157** |
| Core coverage: statements / branches / functions / lines | **96.66% / 85.88% / 100% / 99.75%**; all four 85% thresholds pass |
| Entire configured coverage set, same order | **79.28% / 73.06% / 80.42% / 84.14%**; not 100% contract coverage |
| Production web build | PASS; shared packages/worker still execute TypeScript source |
| Production-server E2E/API suite | **11/11**, no test retries |
| `git diff --check` | PASS |

**No final local gate failures.** Expected negative-test/error logs include unauthenticated access and unavailable production SMTP during test registration; those do not mean verification email was delivered. Intermediate regression/type/selector failures were repaired before final verification. Remote GitHub CI, PG16, full security/accessibility/load/fault/restore and production provider tests were **not run**.

Reproduction: follow `DEVELOPMENT.md`, use a new disposable migrated database and test-only secret, install real Chromium, then `pnpm install --frozen-lockfile`, `pnpm db:migrate` twice, `pnpm verify`, `pnpm audit --json`, `pnpm audit --prod --json`. Never run fixtures against production. Isolated migration tests require CREATE DATABASE rights on the test server.

Evidence: `/home/user/nextdoo-remediation/final-install.log`, `final-migrations.log`, `final-verify.log`, `final-unit.log`, `final-audit.json`, `final-audit-prod.json`; milestone RED/GREEN logs indexed in the execution log. Bulk logs/browser artifacts are intentionally outside Git or ignored.

## F. Dependency audit

- **Full graph: 362 dependencies; 0 informational, low, moderate, high or critical findings.**
- **Production graph: 131 dependencies; 0 at every severity.**
- Both commands exited 0. New relevant dependencies include real Nodemailer **10.0.1**, its types **8.0.1**, fake-indexeddb **6.2.4**, and Node types **22.20.1** resolving the inherited Vite peer mismatch.
- Prior framework/toolchain advisory repairs remain locked. Scanner results are time-specific advisory evidence, not proof of application security.

## G. Production/release recommendation

**Do not release as the PRD-complete MVP or enable unfinished surfaces.** No known repaired cross-tenant disclosure is left failing, but local green gates do not remove the S/D blockers in C. Require staged provider qualification, completed security/retention decisions, recovery and rollout drills, broader contract/sync/a11y tests, load/SLO/observability and §19.4 evidence before release. Do not count notification rows as Web Push, queued mail as inbox delivery, pending outbox as consumed events, safer IndexedDB as working offline mode, or schema rows as integrations.

## H. What is safe to begin next — only after approval

The repaired foundations support a **small next development milestone**, not production approval. Recommended order:

1. Complete online capture/organization and pagination/settings with actual tag/project persistence, accessible editing and explicit API compatibility choices.
2. Complete recurrence and notification workflows using proven transaction/durable-delivery boundaries, with DST/retry/cancellation/provider acceptance tests before enabling them.
3. Correct workspace-local reporting and implement source-event drilldown/corrections/backfills plus independent wellbeing controls, resolving TR-03/period semantics first.
4. Build the end-to-end offline repository/recovery UX on the scoped queue; pass SY-01–SY-10 before desktop expansion.

Operational/security qualification and retention/provider decisions should precede a release and accompany these milestones. AI, Stripe, Google Calendar, attachments and desktop require separate explicit approval and their own real-integration gates. **No next product-development phase has been started.**
